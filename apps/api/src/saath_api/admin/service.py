from __future__ import annotations

import hashlib
import json
import math
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime
from typing import Any, Literal
from uuid import UUID

import httpx
import jwt
from fastapi import Request, status
from sqlalchemy import case, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.admin.models import FeatureFlag
from saath_api.admin.schemas import (
    AdminDisputeItemDTO,
    AdminDisputeListResponse,
    AdminRedemptionDTO,
    AdminRedemptionListResponse,
    AdminSessionRequest,
    AdminSessionResponse,
    AuditLogItemDTO,
    AuditLogListResponse,
    DisputeOverrideRequest,
    DisputeOverrideResponse,
    DisputeParticipantDTO,
    FeatureFlagDTO,
    FeatureFlagListResponse,
    FraudAnomalyDTO,
    FraudEdgeDTO,
    FraudGraphResponse,
    FraudNodeDTO,
    FunnelAnalyticsResponse,
    ModerationActionRequest,
    ModerationActionResponse,
    ModerationQueueItem,
    ModerationQueueResponse,
    NotificationDeliveryStats,
    OutboxHealthStats,
    ProviderHealthItem,
    ProvidersHealthResponse,
    RedemptionReviewRequest,
    RouteFunnelItem,
    SharedDeviceClusterDTO,
    UpdateFeatureFlagRequest,
)
from saath_api.auth.dependencies import Actor
from saath_api.auth.models import AuditLog, Device, RefreshToken, User
from saath_api.core.config import Settings, YamlConfigBundle
from saath_api.core.crypto import create_admin_token
from saath_api.core.errors import ProblemDetailError
from saath_api.journeys.models import Booking, JourneyInstance
from saath_api.karma.models import KarmaLedger, RewardItem, RewardRedemption
from saath_api.karma.service import (
    credit_for_completed_proposal,
    evaluate_and_award_badges,
    reverse_for_proposal,
)
from saath_api.matching.models import MatchCandidate
from saath_api.messaging.models import Conversation, Message, Report
from saath_api.notifications.models import NotificationsOutbox
from saath_api.parties.models import Goal, Party
from saath_api.providers.base import CircuitBreaker
from saath_api.providers.flight.schedule import FakeFlightScheduleProvider
from saath_api.providers.llm import FakeLLMProvider
from saath_api.providers.messaging import (
    ChannelRoutingMessagingProvider,
    FakeMessagingProvider,
)
from saath_api.providers.push import FakeWebPushProvider
from saath_api.providers.turnstile import FakeTurnstileVerifier
from saath_api.swaps.models import SeatLock, SwapCard, SwapParticipant, SwapProposal

_GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]

OidcVerifierFn = Callable[..., Awaitable[str]]


def _hash_fingerprint(raw: str) -> str:
    return hashlib.sha256(raw.strip().encode("utf-8")).hexdigest()[:16]


async def verify_google_oidc_token(
    settings: Settings,
    *,
    id_token: str | None = None,
    code: str | None = None,
    redirect_uri: str | None = None,
) -> str:
    """Verify a Google Workspace OIDC id_token (or exchange auth code) and return verified email."""
    client_id = settings.admin_sso_client_id.strip()
    if not client_id:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="admin_sso_not_configured",
            title="Admin SSO Not Configured",
            detail="ADMIN_SSO_CLIENT_ID must be configured for Google Workspace SSO.",
        )

    raw_id_token = (id_token or "").strip()
    if not raw_id_token and code and code.strip():
        client_secret = settings.admin_sso_client_secret.strip()
        if not client_secret:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="admin_sso_not_configured",
                title="Admin SSO Not Configured",
                detail="ADMIN_SSO_CLIENT_SECRET is required to exchange an OIDC code.",
            )
        resolved_redirect = (redirect_uri or "").strip() or (
            f"{settings.admin_url.rstrip('/')}/login"
        )
        try:
            async with httpx.AsyncClient(timeout=5.0) as http_client:
                token_resp = await http_client.post(
                    _GOOGLE_TOKEN_URL,
                    data={
                        "code": code.strip(),
                        "client_id": client_id,
                        "client_secret": client_secret,
                        "redirect_uri": resolved_redirect,
                        "grant_type": "authorization_code",
                    },
                )
        except httpx.HTTPError as exc:
            raise ProblemDetailError(
                status_code=status.HTTP_401_UNAUTHORIZED,
                code="invalid_oidc_code",
                title="OIDC Code Exchange Failed",
                detail="Unable to exchange Google Workspace authorization code.",
            ) from exc

        if token_resp.status_code >= 400:
            raise ProblemDetailError(
                status_code=status.HTTP_401_UNAUTHORIZED,
                code="invalid_oidc_code",
                title="OIDC Code Exchange Failed",
                detail="Google Workspace rejected the authorization code.",
            )
        token_payload = token_resp.json()
        raw_id_token = str(token_payload.get("id_token") or "").strip()

    if not raw_id_token:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_oidc_token",
            title="Invalid OIDC Token",
            detail="A valid Google Workspace ID token is required.",
        )

    try:
        header = jwt.get_unverified_header(raw_id_token)
    except jwt.InvalidTokenError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_oidc_token",
            title="Invalid OIDC Token",
            detail="Malformed Google Workspace ID token header.",
        ) from exc

    kid = header.get("kid")
    try:
        async with httpx.AsyncClient(timeout=5.0) as http_client:
            jwks_resp = await http_client.get(_GOOGLE_CERTS_URL)
            jwks_resp.raise_for_status()
            jwks = jwks_resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="oidc_jwks_unavailable",
            title="OIDC Verification Unavailable",
            detail="Could not fetch Google Workspace signing keys.",
        ) from exc

    keys = jwks.get("keys", []) if isinstance(jwks, dict) else []
    matching_jwk = next(
        (k for k in keys if isinstance(k, dict) and (kid is None or k.get("kid") == kid)),
        None,
    )
    if matching_jwk is None:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_oidc_token",
            title="Invalid OIDC Token",
            detail="No matching Google Workspace signing key found for ID token.",
        )

    try:
        public_key = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(matching_jwk))
        claims = jwt.decode(
            raw_id_token,
            public_key,  # type: ignore[arg-type]
            algorithms=["RS256"],
            audience=client_id,
            issuer=_GOOGLE_ISSUERS,
            options={"require": ["sub", "aud", "iss", "exp", "iat", "email"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="oidc_token_expired",
            title="OIDC Token Expired",
            detail="Google Workspace ID token has expired.",
        ) from exc
    except jwt.InvalidTokenError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_oidc_token",
            title="Invalid OIDC Token",
            detail="Google Workspace ID token signature or claims are invalid.",
        ) from exc

    if claims.get("email_verified") is not True:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="oidc_email_unverified",
            title="Unverified Operator Email",
            detail="Google Workspace email must be verified.",
        )

    email = str(claims.get("email") or "").strip().lower()
    if not email:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_oidc_token",
            title="Invalid OIDC Token",
            detail="Google Workspace ID token is missing an email claim.",
        )
    return email


def _effective_allowed_emails(settings: Settings) -> set[str]:
    allowed = set(settings.admin_sso_allowed_email_list)
    if not allowed and settings.env in ("test", "development"):
        return {"ops@saath.test"}
    return allowed


async def create_admin_session(
    *,
    db: AsyncSession,
    settings: Settings,
    req: AdminSessionRequest,
    oidc_verifier: OidcVerifierFn | None = None,
) -> AdminSessionResponse:
    verifier = oidc_verifier or verify_google_oidc_token
    allowed = _effective_allowed_emails(settings)
    has_oidc_credential = bool((req.id_token and req.id_token.strip()) or (req.code and req.code.strip()))

    if settings.is_production:
        if not settings.admin_sso_client_id.strip() or not allowed:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="admin_sso_not_configured",
                title="Admin SSO Not Configured",
                detail="Admin Google Workspace SSO and allowlist must be configured in production.",
            )
        if not has_oidc_credential:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="admin_sso_required",
                title="Google Workspace SSO Required",
                detail="Passwordless email login is disabled in production; present a Google OIDC token.",
            )
        verified_email = (
            await verifier(
                settings,
                id_token=req.id_token,
                code=req.code,
                redirect_uri=req.redirect_uri,
            )
        ).strip().lower()
        if req.email and req.email.strip() and req.email.strip().lower() != verified_email:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="admin_email_mismatch",
                title="Email Mismatch",
                detail="Requested email does not match verified Google Workspace identity.",
            )
        if verified_email not in allowed:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="admin_not_allowlisted",
                title="Operator Not Allowlisted",
                detail="Your operator account is not allowlisted for admin access.",
            )
        auth_method = "oidc"
    else:
        if has_oidc_credential:
            verified_email = (
                await verifier(
                    settings,
                    id_token=req.id_token,
                    code=req.code,
                    redirect_uri=req.redirect_uri,
                )
            ).strip().lower()
            if verified_email not in allowed:
                raise ProblemDetailError(
                    status_code=status.HTTP_403_FORBIDDEN,
                    code="admin_not_allowlisted",
                    title="Operator Not Allowlisted",
                    detail="Your operator account is not allowlisted for admin access.",
                )
            auth_method = "oidc"
        elif req.email and req.email.strip():
            verified_email = req.email.strip().lower()
            if verified_email not in allowed:
                raise ProblemDetailError(
                    status_code=status.HTTP_403_FORBIDDEN,
                    code="admin_not_allowlisted",
                    title="Operator Not Allowlisted",
                    detail="Your operator account is not allowlisted for admin access.",
                )
            auth_method = "allowlist_email"
        else:
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="missing_admin_credentials",
                title="Missing Credentials",
                detail="Provide either a Google Workspace OIDC credential or an allowlisted email.",
            )

    token, ttl = create_admin_token(settings, email=verified_email, scopes=("admin",))
    db.add(
        AuditLog(
            actor=f"admin:{verified_email}",
            action="admin.session_created",
            resource="admin:session",
            meta={"method": auth_method, "env": settings.env},
        )
    )
    await db.commit()

    return AdminSessionResponse(
        access=token,
        token=token,
        token_type="bearer",
        expires_in=ttl,
        email=verified_email,
        scopes=["admin"],
    )


async def get_funnel_analytics(
    *,
    db: AsyncSession,
    route: str | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
) -> FunnelAnalyticsResponse:
    route_clean = route.strip().upper() if route and route.strip() else None

    ji_stmt = select(JourneyInstance)
    if from_date is not None:
        ji_stmt = ji_stmt.where(JourneyInstance.service_date >= from_date)
    if to_date is not None:
        ji_stmt = ji_stmt.where(JourneyInstance.service_date <= to_date)
    if route_clean is not None:
        route_booking_subq = select(Booking.journey_instance_id).where(
            func.upper(
                func.concat(
                    func.coalesce(Booking.from_code, ""),
                    "-",
                    func.coalesce(Booking.to_code, ""),
                )
            )
            == route_clean
        )
        ji_stmt = ji_stmt.where(
            or_(
                func.upper(JourneyInstance.service_no) == route_clean,
                func.upper(JourneyInstance.carrier_code) == route_clean,
                JourneyInstance.id.in_(route_booking_subq),
            )
        )

    journeys = list((await db.execute(ji_stmt)).scalars().all())
    journey_ids = [j.id for j in journeys]

    outbox_stmt = select(NotificationsOutbox.status, func.count(NotificationsOutbox.id)).group_by(
        NotificationsOutbox.status
    )
    if from_date is not None:
        outbox_stmt = outbox_stmt.where(func.date(NotificationsOutbox.created_at) >= from_date)
    if to_date is not None:
        outbox_stmt = outbox_stmt.where(func.date(NotificationsOutbox.created_at) <= to_date)

    outbox_rows = (await db.execute(outbox_stmt)).all()
    status_counts = {str(st): int(cnt) for st, cnt in outbox_rows}
    queued_cnt = status_counts.get("queued", 0)
    sent_cnt = status_counts.get("sent", 0)
    dead_cnt = status_counts.get("dead_letter", 0)
    outbox_total = sum(status_counts.values())
    delivery_rate = round(sent_cnt / outbox_total, 4) if outbox_total > 0 else 0.0

    notif_stats = NotificationDeliveryStats(
        total=outbox_total,
        queued=queued_cnt,
        sent=sent_cnt,
        dead_letter=dead_cnt,
        delivery_rate=delivery_rate,
    )

    if not journey_ids:
        return FunnelAnalyticsResponse(
            from_date=from_date,
            to_date=to_date,
            route=route_clean,
            verified=0,
            goal_set=0,
            matched=0,
            swap_created=0,
            swap_confirmed=0,
            swap_completed=0,
            match_rate=0.0,
            notification_delivery=notif_stats,
            routes=[],
        )

    booking_rows = (
        await db.execute(
            select(
                Booking.journey_instance_id,
                Booking.from_code,
                Booking.to_code,
                Booking.trust_tier,
            ).where(Booking.journey_instance_id.in_(journey_ids))
        )
    ).all()

    verified_by_ji: dict[UUID, int] = defaultdict(int)
    route_pair_counts: dict[UUID, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for ji_id, from_code, to_code, trust_tier in booking_rows:
        if trust_tier in ("verified_provider", "verified_bcbp", "verified_doc"):
            verified_by_ji[ji_id] += 1
        if from_code and to_code:
            pair = f"{from_code.upper()}-{to_code.upper()}"
            route_pair_counts[ji_id][pair] += 1

    goal_rows = (
        await db.execute(
            select(Party.journey_instance_id, func.count(func.distinct(Goal.party_id)))
            .join(Goal, Goal.party_id == Party.id)
            .where(Party.journey_instance_id.in_(journey_ids), Goal.active.is_(True))
            .group_by(Party.journey_instance_id)
        )
    ).all()
    goals_by_ji = {ji_id: int(cnt) for ji_id, cnt in goal_rows}

    match_rows = (
        await db.execute(
            select(
                MatchCandidate.journey_instance_id,
                func.count(func.distinct(MatchCandidate.for_party_id)),
            )
            .where(MatchCandidate.journey_instance_id.in_(journey_ids))
            .group_by(MatchCandidate.journey_instance_id)
        )
    ).all()
    matched_by_ji = {ji_id: int(cnt) for ji_id, cnt in match_rows}

    swap_rows = (
        await db.execute(
            select(
                SwapProposal.journey_instance_id,
                SwapProposal.status,
                func.count(SwapProposal.id),
            )
            .where(SwapProposal.journey_instance_id.in_(journey_ids))
            .group_by(SwapProposal.journey_instance_id, SwapProposal.status)
        )
    ).all()
    swap_created_by_ji: dict[UUID, int] = defaultdict(int)
    swap_confirmed_by_ji: dict[UUID, int] = defaultdict(int)
    swap_completed_by_ji: dict[UUID, int] = defaultdict(int)
    for ji_id, sp_status, cnt in swap_rows:
        n = int(cnt)
        swap_created_by_ji[ji_id] += n
        if sp_status in ("confirmed", "awaiting_confirmation", "completed", "not_completed"):
            swap_confirmed_by_ji[ji_id] += n
        if sp_status == "completed":
            swap_completed_by_ji[ji_id] += n

    total_verified = sum(verified_by_ji.values())
    total_goals = sum(goals_by_ji.values())
    total_matched = sum(matched_by_ji.values())
    total_swaps = sum(swap_created_by_ji.values())
    total_confirmed = sum(swap_confirmed_by_ji.values())
    total_completed = sum(swap_completed_by_ji.values())
    total_match_rate = round(total_matched / total_goals, 4) if total_goals > 0 else 0.0

    grouped: dict[tuple[str, str, str], dict[str, Any]] = {}
    for ji in journeys:
        key = (str(ji.mode), ji.carrier_code, ji.service_no)
        bucket = grouped.setdefault(
            key,
            {
                "journeys": 0,
                "verified": 0,
                "goal_set": 0,
                "matched": 0,
                "swap_created": 0,
                "swap_confirmed": 0,
                "swap_completed": 0,
                "pair_counts": defaultdict(int),
            },
        )
        bucket["journeys"] += 1
        bucket["verified"] += verified_by_ji.get(ji.id, 0)
        bucket["goal_set"] += goals_by_ji.get(ji.id, 0)
        bucket["matched"] += matched_by_ji.get(ji.id, 0)
        bucket["swap_created"] += swap_created_by_ji.get(ji.id, 0)
        bucket["swap_confirmed"] += swap_confirmed_by_ji.get(ji.id, 0)
        bucket["swap_completed"] += swap_completed_by_ji.get(ji.id, 0)
        for pair, pair_cnt in route_pair_counts.get(ji.id, {}).items():
            bucket["pair_counts"][pair] += pair_cnt

    route_items: list[RouteFunnelItem] = []
    for (mode, carrier_code, service_no), bucket in sorted(grouped.items()):
        pair_counts: dict[str, int] = bucket["pair_counts"]
        if pair_counts:
            top_pair = max(pair_counts.items(), key=lambda item: item[1])[0]
            route_label = f"{service_no} ({top_pair})"
        else:
            route_label = service_no
        g_cnt = int(bucket["goal_set"])
        m_cnt = int(bucket["matched"])
        route_items.append(
            RouteFunnelItem(
                route=route_label,
                mode=mode,
                carrier_code=carrier_code,
                service_no=service_no,
                journeys=int(bucket["journeys"]),
                verified=int(bucket["verified"]),
                goal_set=g_cnt,
                matched=m_cnt,
                swap_created=int(bucket["swap_created"]),
                swap_confirmed=int(bucket["swap_confirmed"]),
                swap_completed=int(bucket["swap_completed"]),
                match_rate=round(m_cnt / g_cnt, 4) if g_cnt > 0 else 0.0,
            )
        )

    return FunnelAnalyticsResponse(
        from_date=from_date,
        to_date=to_date,
        route=route_clean,
        verified=total_verified,
        goal_set=total_goals,
        matched=total_matched,
        swap_created=total_swaps,
        swap_confirmed=total_confirmed,
        swap_completed=total_completed,
        match_rate=total_match_rate,
        notification_delivery=notif_stats,
        routes=route_items,
    )


def _inspect_in_process_breaker(
    provider: object,
    *,
    name: str,
    category: str,
    mode: str,
) -> ProviderHealthItem:
    breaker = getattr(provider, "_breaker", None)
    circuit_state: Literal["closed", "open"] = "closed"
    failures = 0
    open_ttl_seconds = 0
    if isinstance(breaker, CircuitBreaker):
        failures = int(breaker._failures)
        if breaker._opened_at is not None:
            remaining = breaker.reset_timeout_seconds - (time.monotonic() - breaker._opened_at)
            if remaining > 0:
                circuit_state = "open"
                open_ttl_seconds = int(math.ceil(remaining))
    return ProviderHealthItem(
        name=name,
        category=category,
        mode=mode,
        circuit_state=circuit_state,
        failures=failures,
        open_ttl_seconds=open_ttl_seconds,
    )


async def get_providers_health(
    *,
    request: Request,
    db: AsyncSession,
) -> ProvidersHealthResponse:
    providers: list[ProviderHealthItem] = []
    redis = getattr(request.app.state, "redis", None)
    rail_router = getattr(request.app.state, "rail_router", None)

    if rail_router is not None:
        for rail_prov in getattr(rail_router, "_providers", []):
            pname = str(getattr(rail_prov, "name", type(rail_prov).__name__))
            is_open = False
            failures = 0
            open_ttl_seconds = 0
            if redis is not None:
                is_open = bool(await redis.exists(f"cb:rail:{pname}:open"))
                raw_fail = await redis.get(f"cb:rail:{pname}:failures")
                failures = int(raw_fail) if raw_fail else 0
                if is_open:
                    ttl_raw = await redis.ttl(f"cb:rail:{pname}:open")
                    if isinstance(ttl_raw, int) and ttl_raw > 0:
                        open_ttl_seconds = ttl_raw
            mode = "fake" if "fake" in pname.lower() else "live"
            providers.append(
                ProviderHealthItem(
                    name=pname,
                    category="rail",
                    mode=mode,
                    circuit_state="open" if is_open else "closed",
                    failures=failures,
                    open_ttl_seconds=open_ttl_seconds,
                )
            )

    flight_prov = getattr(request.app.state, "flight_schedule_provider", None)
    if flight_prov is not None:
        providers.append(
            _inspect_in_process_breaker(
                flight_prov,
                name=str(getattr(flight_prov, "name", "flight_schedule")),
                category="flight",
                mode="fake" if isinstance(flight_prov, FakeFlightScheduleProvider) else "live",
            )
        )

    msg_prov = getattr(request.app.state, "messaging_provider", None)
    if isinstance(msg_prov, ChannelRoutingMessagingProvider):
        wa_prov = msg_prov._whatsapp
        sms_prov = msg_prov._sms
        providers.append(
            _inspect_in_process_breaker(
                wa_prov,
                name="whatsapp_cloud" if not isinstance(wa_prov, FakeMessagingProvider) else "fake_whatsapp",
                category="messaging",
                mode="fake" if isinstance(wa_prov, FakeMessagingProvider) else "live",
            )
        )
        providers.append(
            _inspect_in_process_breaker(
                sms_prov,
                name="msg91_sms" if not isinstance(sms_prov, FakeMessagingProvider) else "fake_sms",
                category="messaging",
                mode="fake" if isinstance(sms_prov, FakeMessagingProvider) else "live",
            )
        )
    elif msg_prov is not None:
        providers.append(
            _inspect_in_process_breaker(
                msg_prov,
                name="fake_messaging" if isinstance(msg_prov, FakeMessagingProvider) else type(msg_prov).__name__,
                category="messaging",
                mode="fake" if isinstance(msg_prov, FakeMessagingProvider) else "live",
            )
        )

    push_prov = getattr(request.app.state, "web_push_provider", None)
    if push_prov is not None:
        providers.append(
            _inspect_in_process_breaker(
                push_prov,
                name="fake_webpush" if isinstance(push_prov, FakeWebPushProvider) else "vapid_webpush",
                category="push",
                mode="fake" if isinstance(push_prov, FakeWebPushProvider) else "live",
            )
        )

    llm_prov = getattr(request.app.state, "llm_provider", None)
    if llm_prov is not None:
        providers.append(
            _inspect_in_process_breaker(
                llm_prov,
                name="fake_llm" if isinstance(llm_prov, FakeLLMProvider) else "anthropic_llm",
                category="llm",
                mode="fake" if isinstance(llm_prov, FakeLLMProvider) else "live",
            )
        )

    turnstile_prov = getattr(request.app.state, "turnstile_verifier", None)
    if turnstile_prov is not None:
        providers.append(
            _inspect_in_process_breaker(
                turnstile_prov,
                name=(
                    "fake_turnstile"
                    if isinstance(turnstile_prov, FakeTurnstileVerifier)
                    else "cloudflare_turnstile"
                ),
                category="turnstile",
                mode="fake" if isinstance(turnstile_prov, FakeTurnstileVerifier) else "live",
            )
        )

    payment_prov = getattr(request.app.state, "payment_provider", None)
    if payment_prov is not None:
        pay_name = str(getattr(payment_prov, "name", "sandbox"))
        providers.append(
            _inspect_in_process_breaker(
                payment_prov,
                name=pay_name,
                category="payment",
                mode="sandbox" if pay_name == "sandbox" else "live",
            )
        )

    outbox_rows = (
        await db.execute(
            select(NotificationsOutbox.status, func.count(NotificationsOutbox.id)).group_by(
                NotificationsOutbox.status
            )
        )
    ).all()
    counts = {str(st): int(cnt) for st, cnt in outbox_rows}
    oldest_queued = (
        await db.execute(
            select(func.min(NotificationsOutbox.created_at)).where(
                NotificationsOutbox.status == "queued"
            )
        )
    ).scalar_one_or_none()
    if oldest_queued is not None:
        aware = oldest_queued if oldest_queued.tzinfo is not None else oldest_queued.replace(tzinfo=UTC)
        lag_seconds = max(0.0, round((datetime.now(UTC) - aware).total_seconds(), 2))
    else:
        lag_seconds = 0.0

    return ProvidersHealthResponse(
        providers=providers,
        outbox=OutboxHealthStats(
            queued=counts.get("queued", 0),
            sent=counts.get("sent", 0),
            dead_letter=counts.get("dead_letter", 0),
            lag_seconds=lag_seconds,
        ),
    )


async def get_moderation_queue(
    *,
    db: AsyncSession,
    actor: Actor,
    status_filter: Literal["open", "reviewed", "dismissed", "actioned", "all"] = "open",
    limit: int = 50,
    offset: int = 0,
) -> ModerationQueueResponse:
    base_where = []
    if status_filter != "all":
        base_where.append(Report.status == status_filter)

    total_stmt = select(func.count(Report.id))
    if base_where:
        total_stmt = total_stmt.where(*base_where)
    total = int((await db.execute(total_stmt)).scalar_one())

    stmt = (
        select(Report, User, Message, Conversation)
        .join(User, User.id == Report.target_user)
        .outerjoin(Message, Message.id == Report.message_id)
        .outerjoin(Conversation, Conversation.id == Report.conversation_id)
    )
    if base_where:
        stmt = stmt.where(*base_where)
    stmt = stmt.order_by(Report.created_at.desc(), Report.id.desc()).limit(limit).offset(offset)

    rows = (await db.execute(stmt)).all()
    items = [
        ModerationQueueItem(
            report_id=rep.id,
            status=rep.status,
            reason=rep.reason,
            created_at=rep.created_at,
            reporter_id=rep.reporter,
            target_user_id=rep.target_user,
            target_user_status=target.status,
            target_display_alias=target.display_alias,
            conversation_id=rep.conversation_id,
            journey_instance_id=convo.journey_instance_id if convo is not None else None,
            message_id=rep.message_id,
            message_body=msg.body if msg is not None else None,
            message_moderation=msg.moderation if msg is not None else None,
            message_moderation_reason=msg.moderation_reason if msg is not None else None,
        )
        for rep, target, msg, convo in rows
    ]

    db.add(
        AuditLog(
            actor=f"admin:{actor.admin_email}",
            action="admin.moderation_queue_viewed",
            resource="moderation:queue",
            meta={
                "status": status_filter,
                "limit": limit,
                "offset": offset,
                "returned": len(items),
                "total": total,
            },
        )
    )
    await db.commit()

    return ModerationQueueResponse(items=items, total=total)


async def act_on_moderation(
    *,
    db: AsyncSession,
    actor: Actor,
    report_id: UUID,
    req: ModerationActionRequest,
) -> ModerationActionResponse:
    report = (
        await db.execute(select(Report).where(Report.id == report_id))
    ).scalar_one_or_none()
    if report is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="report_not_found",
            title="Report Not Found",
            detail="The requested moderation report does not exist.",
        )

    target_user = (
        await db.execute(select(User).where(User.id == report.target_user))
    ).scalar_one_or_none()
    if target_user is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="user_not_found",
            title="User Not Found",
            detail="Reported target user no longer exists.",
        )

    message: Message | None = None
    if report.message_id is not None:
        message = (
            await db.execute(select(Message).where(Message.id == report.message_id))
        ).scalar_one_or_none()

    now = datetime.now(UTC)
    revoked_tokens = 0
    invalidated_swaps = 0

    if req.action == "dismiss":
        report.status = "dismissed"
    elif req.action == "hide":
        report.status = "actioned"
        if message is not None:
            message.moderation = "hidden"
            message.moderation_reason = (
                req.note or report.reason or "Hidden by admin moderation"
            )[:200]
    elif req.action == "restrict":
        report.status = "actioned"
        if target_user.status == "active":
            target_user.status = "restricted"
    elif req.action == "ban":
        report.status = "actioned"
        if target_user.status != "deleted":
            target_user.status = "banned"

        rev_res = await db.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == target_user.id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        revoked_tokens = int(rev_res.rowcount or 0)  # type: ignore[attr-defined]

        part_prop_subq = select(SwapParticipant.proposal_id).where(
            SwapParticipant.user_id == target_user.id
        )
        pending_props = list(
            (
                await db.execute(
                    select(SwapProposal).where(
                        SwapProposal.status == "pending",
                        or_(
                            SwapProposal.initiator_user_id == target_user.id,
                            SwapProposal.id.in_(part_prop_subq),
                        ),
                    )
                )
            )
            .scalars()
            .all()
        )
        pending_ids = [prop.id for prop in pending_props]
        if pending_ids:
            for prop in pending_props:
                prop.status = "invalidated"
                prop.version += 1
            await db.execute(delete(SeatLock).where(SeatLock.proposal_id.in_(pending_ids)))
            await db.execute(
                update(SwapCard)
                .where(SwapCard.proposal_id.in_(pending_ids), SwapCard.revoked.is_(False))
                .values(revoked=True, revoked_reason="participant_banned")
            )
            invalidated_swaps = len(pending_ids)

    db.add(
        AuditLog(
            actor=f"admin:{actor.admin_email}",
            action=f"admin.moderation.{req.action}",
            resource=f"report:{report.id}",
            meta={
                "target_user_id": str(target_user.id),
                "target_user_status": target_user.status,
                "message_id": str(message.id) if message is not None else None,
                "note": req.note,
                "revoked_tokens": revoked_tokens,
                "invalidated_swaps": invalidated_swaps,
            },
        )
    )
    await db.commit()

    return ModerationActionResponse(
        report_id=report.id,
        report_status=report.status,
        target_user_id=target_user.id,
        target_user_status=target_user.status,
        message_moderation=message.moderation if message is not None else None,
        revoked_tokens=revoked_tokens,
        invalidated_swaps=invalidated_swaps,
    )


async def get_fraud_graph(
    *,
    db: AsyncSession,
    actor: Actor,
) -> FraudGraphResponse:
    device_rows = (
        await db.execute(
            select(Device.user_id, Device.push_endpoint, Device.push_p256dh).where(
                or_(
                    Device.push_endpoint.is_not(None),
                    Device.push_p256dh.is_not(None),
                )
            )
        )
    ).all()

    by_endpoint_hash: dict[str, set[UUID]] = defaultdict(set)
    by_p256dh_hash: dict[str, set[UUID]] = defaultdict(set)
    for uid, endpoint, p256dh in device_rows:
        if endpoint and endpoint.strip():
            by_endpoint_hash[_hash_fingerprint(endpoint)].add(uid)
        if p256dh and p256dh.strip():
            by_p256dh_hash[_hash_fingerprint(p256dh)].add(uid)

    shared_devices: list[SharedDeviceClusterDTO] = []
    shared_pairs: set[tuple[UUID, UUID]] = set()
    involved_user_ids: set[UUID] = set()

    for fp_hash, uids in sorted(by_endpoint_hash.items()):
        if len(uids) >= 2:
            ordered = sorted(uids, key=str)
            involved_user_ids.update(ordered)
            shared_devices.append(
                SharedDeviceClusterDTO(
                    fingerprint_hash=fp_hash,
                    signal="push_endpoint",
                    user_ids=ordered,
                )
            )
            for i in range(len(ordered)):
                for j in range(i + 1, len(ordered)):
                    shared_pairs.add((ordered[i], ordered[j]))

    for fp_hash, uids in sorted(by_p256dh_hash.items()):
        if len(uids) >= 2:
            ordered = sorted(uids, key=str)
            involved_user_ids.update(ordered)
            shared_devices.append(
                SharedDeviceClusterDTO(
                    fingerprint_hash=fp_hash,
                    signal="push_p256dh",
                    user_ids=ordered,
                )
            )
            for i in range(len(ordered)):
                for j in range(i + 1, len(ordered)):
                    shared_pairs.add((ordered[i], ordered[j]))

    part_rows = (
        await db.execute(
            select(
                SwapParticipant.proposal_id,
                SwapParticipant.user_id,
                SwapProposal.status,
            )
            .join(SwapProposal, SwapProposal.id == SwapParticipant.proposal_id)
            .where(
                SwapParticipant.user_id.is_not(None),
                SwapProposal.status.in_(
                    ("confirmed", "awaiting_confirmation", "completed", "not_completed")
                ),
            )
        )
    ).all()

    users_by_prop: dict[UUID, set[UUID]] = defaultdict(set)
    prop_status: dict[UUID, str] = {}
    for prop_id, uid, st in part_rows:
        if uid is not None:
            users_by_prop[prop_id].add(uid)
            prop_status[prop_id] = st

    prop_ids = list(users_by_prop.keys())
    credited_props: set[UUID] = set()
    reversed_props: set[UUID] = set()
    if prop_ids:
        ledger_rows = (
            await db.execute(
                select(KarmaLedger.proposal_id, KarmaLedger.state).where(
                    KarmaLedger.proposal_id.in_(prop_ids),
                    KarmaLedger.state.in_(("credited", "reversed")),
                )
            )
        ).all()
        for prop_id, state in ledger_rows:
            if prop_id is None:
                continue
            if state == "credited":
                credited_props.add(prop_id)
            elif state == "reversed":
                reversed_props.add(prop_id)

    pair_stats: dict[tuple[UUID, UUID], dict[str, int]] = defaultdict(
        lambda: {"swap_count": 0, "completed_count": 0, "credited_count": 0, "reversed_count": 0}
    )
    for prop_id, uids in users_by_prop.items():
        ordered = sorted(uids, key=str)
        for i in range(len(ordered)):
            for j in range(i + 1, len(ordered)):
                pair = (ordered[i], ordered[j])
                involved_user_ids.update(pair)
                st_bucket = pair_stats[pair]
                st_bucket["swap_count"] += 1
                if prop_status.get(prop_id) == "completed":
                    st_bucket["completed_count"] += 1
                if prop_id in credited_props:
                    st_bucket["credited_count"] += 1
                if prop_id in reversed_props:
                    st_bucket["reversed_count"] += 1

    anomaly_rows = (
        await db.execute(
            select(AuditLog)
            .where(
                AuditLog.action.in_(
                    (
                        "karma.collusion_blocked",
                        "karma.same_pair_cap_blocked",
                        "karma.daily_cap_blocked",
                    )
                )
            )
            .order_by(AuditLog.at.desc(), AuditLog.id.desc())
            .limit(100)
        )
    ).scalars().all()

    anomalies: list[FraudAnomalyDTO] = []
    for log_row in anomaly_rows:
        if isinstance(log_row.meta, dict) and log_row.meta.get("user_id"):
            try:
                involved_user_ids.add(UUID(str(log_row.meta["user_id"])))
            except ValueError:
                pass
        anomalies.append(
            FraudAnomalyDTO(
                id=log_row.id,
                action=log_row.action,
                resource=log_row.resource,
                meta=log_row.meta,
                at=log_row.at,
            )
        )

    edges: list[FraudEdgeDTO] = []
    flagged_pairs: list[FraudEdgeDTO] = []
    all_pairs = sorted(set(pair_stats.keys()) | shared_pairs, key=lambda p: (str(p[0]), str(p[1])))
    for pair in all_pairs:
        st_bucket = pair_stats.get(
            pair,
            {"swap_count": 0, "completed_count": 0, "credited_count": 0, "reversed_count": 0},
        )
        reasons: list[str] = []
        if pair in shared_pairs:
            reasons.append("shared_device_push_key")
        if st_bucket["swap_count"] >= 2:
            reasons.append("repeat_swap_pair")
        if st_bucket["reversed_count"] >= 1:
            reasons.append("karma_reversed")
        flagged = bool(reasons)
        edge = FraudEdgeDTO(
            user_a=pair[0],
            user_b=pair[1],
            swap_count=st_bucket["swap_count"],
            completed_count=st_bucket["completed_count"],
            credited_count=st_bucket["credited_count"],
            reversed_count=st_bucket["reversed_count"],
            flagged=flagged,
            reasons=reasons,
        )
        edges.append(edge)
        if flagged:
            flagged_pairs.append(edge)

    nodes: list[FraudNodeDTO] = []
    if involved_user_ids:
        user_rows = (
            await db.execute(select(User).where(User.id.in_(involved_user_ids)))
        ).scalars().all()
        karma_sums = (
            await db.execute(
                select(
                    KarmaLedger.user_id,
                    func.coalesce(
                        func.sum(case((KarmaLedger.state == "credited", KarmaLedger.delta), else_=0)),
                        0,
                    ),
                    func.coalesce(
                        func.sum(
                            case(
                                (KarmaLedger.state == "reversed", func.abs(KarmaLedger.delta)),
                                else_=0,
                            )
                        ),
                        0,
                    ),
                )
                .where(KarmaLedger.user_id.in_(involved_user_ids))
                .group_by(KarmaLedger.user_id)
            )
        ).all()
        karma_map = {
            uid: (int(credited), int(reversed_pts))
            for uid, credited, reversed_pts in karma_sums
            if uid is not None
        }
        for usr in sorted(user_rows, key=lambda u: str(u.id)):
            credited_pts, reversed_pts = karma_map.get(usr.id, (0, 0))
            nodes.append(
                FraudNodeDTO(
                    user_id=usr.id,
                    display_alias=usr.display_alias,
                    status=usr.status,
                    karma_credited=credited_pts,
                    karma_reversed=reversed_pts,
                )
            )

    db.add(
        AuditLog(
            actor=f"admin:{actor.admin_email}",
            action="admin.fraud_graph_viewed",
            resource="fraud:graph",
            meta={
                "nodes": len(nodes),
                "edges": len(edges),
                "flagged_pairs": len(flagged_pairs),
                "shared_devices": len(shared_devices),
                "anomalies": len(anomalies),
            },
        )
    )
    await db.commit()

    return FraudGraphResponse(
        nodes=nodes,
        edges=edges,
        flagged_pairs=flagged_pairs,
        shared_devices=shared_devices,
        anomalies=anomalies,
    )


async def list_feature_flags(*, db: AsyncSession) -> FeatureFlagListResponse:
    rows = (await db.execute(select(FeatureFlag).order_by(FeatureFlag.key.asc()))).scalars().all()
    return FeatureFlagListResponse(
        items=[
            FeatureFlagDTO(
                key=row.key,
                value=row.value,
                description=row.description,
                updated_by=row.updated_by,
                updated_at=row.updated_at,
            )
            for row in rows
        ]
    )


async def update_feature_flag(
    *,
    db: AsyncSession,
    actor: Actor,
    key: str,
    req: UpdateFeatureFlagRequest,
) -> FeatureFlagDTO:
    flag = (
        await db.execute(select(FeatureFlag).where(FeatureFlag.key == key))
    ).scalar_one_or_none()
    if flag is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="flag_not_found",
            title="Feature Flag Not Found",
            detail=f"Feature flag {key!r} does not exist.",
        )

    flag.value = req.value
    if req.description is not None:
        flag.description = req.description
    flag.updated_by = f"admin:{actor.admin_email}"
    flag.updated_at = datetime.now(UTC)

    db.add(
        AuditLog(
            actor=f"admin:{actor.admin_email}",
            action="admin.flag_updated",
            resource=f"feature_flag:{flag.key}",
            meta={"value": req.value, "description": flag.description},
        )
    )
    await db.commit()
    await db.refresh(flag)

    return FeatureFlagDTO(
        key=flag.key,
        value=flag.value,
        description=flag.description,
        updated_by=flag.updated_by,
        updated_at=flag.updated_at,
    )


async def list_disputes(
    *,
    db: AsyncSession,
    actor: Actor,
    status_filter: Literal["open", "resolved", "all"] = "open",
    limit: int = 50,
    offset: int = 0,
) -> AdminDisputeListResponse:
    dispute_items: list[AdminDisputeItemDTO] = []

    negative_confirm_subq = select(SwapParticipant.proposal_id).where(
        SwapParticipant.post_confirm.in_(("no", "did_not_board"))
    )
    if status_filter == "open":
        swap_cond = or_(
            SwapProposal.status == "not_completed",
            (SwapProposal.status == "awaiting_confirmation")
            & SwapProposal.id.in_(negative_confirm_subq),
        )
    elif status_filter == "resolved":
        overridden_subq = select(AuditLog.resource).where(
            AuditLog.action == "admin.dispute_override"
        )
        swap_cond = or_(
            (SwapProposal.status == "completed") & SwapProposal.id.in_(negative_confirm_subq),
            func.concat("swap:", func.cast(SwapProposal.id, AuditLog.resource.type)).in_(
                overridden_subq
            ),
        )
    else:
        swap_cond = or_(
            SwapProposal.status == "not_completed",
            SwapProposal.id.in_(negative_confirm_subq),
        )

    swap_rows = (
        await db.execute(
            select(SwapProposal, JourneyInstance)
            .join(JourneyInstance, JourneyInstance.id == SwapProposal.journey_instance_id)
            .where(swap_cond)
            .order_by(SwapProposal.created_at.desc())
        )
    ).all()

    swap_ids = [sp.id for sp, _ in swap_rows]
    parts_by_swap: dict[UUID, list[DisputeParticipantDTO]] = defaultdict(list)
    if swap_ids:
        part_rows = (
            await db.execute(
                select(SwapParticipant).where(SwapParticipant.proposal_id.in_(swap_ids))
            )
        ).scalars().all()
        for part in part_rows:
            parts_by_swap[part.proposal_id].append(
                DisputeParticipantDTO(
                    user_id=part.user_id,
                    alias=part.alias,
                    gives_seat=part.gives_seat,
                    gets_seat=part.gets_seat,
                    decision=part.decision,
                    post_confirm=part.post_confirm,
                )
            )

    for sp, ji in swap_rows:
        dispute_items.append(
            AdminDisputeItemDTO(
                dispute_id=sp.id,
                dispute_type="swap_dispute",
                status=sp.status,
                journey_instance_id=ji.id,
                service=f"{ji.carrier_code} {ji.service_no}".strip(),
                service_date=ji.service_date,
                participants=parts_by_swap.get(sp.id, []),
                claim_conflict_flagged=False,
                created_at=sp.created_at,
            )
        )

    if status_filter in ("open", "all"):
        conflict_rows = (
            await db.execute(
                select(Booking, JourneyInstance)
                .join(JourneyInstance, JourneyInstance.id == Booking.journey_instance_id)
                .where(Booking.claim_conflict_flagged.is_(True))
                .order_by(Booking.created_at.desc())
            )
        ).all()
        for booking, ji in conflict_rows:
            dispute_items.append(
                AdminDisputeItemDTO(
                    dispute_id=booking.id,
                    dispute_type="claim_conflict",
                    status="conflict_flagged",
                    journey_instance_id=ji.id,
                    service=f"{ji.carrier_code} {ji.service_no}".strip(),
                    service_date=ji.service_date,
                    participants=[],
                    claim_conflict_flagged=True,
                    created_at=booking.created_at,
                )
            )

    dispute_items.sort(key=lambda item: item.created_at, reverse=True)
    total = len(dispute_items)
    paged = dispute_items[offset : offset + limit]

    db.add(
        AuditLog(
            actor=f"admin:{actor.admin_email}",
            action="admin.disputes_viewed",
            resource="disputes:list",
            meta={"status": status_filter, "total": total, "returned": len(paged)},
        )
    )
    await db.commit()

    return AdminDisputeListResponse(items=paged, total=total)


async def override_dispute(
    *,
    db: AsyncSession,
    actor: Actor,
    dispute_id: UUID,
    req: DisputeOverrideRequest,
    yaml_configs: YamlConfigBundle | None = None,
) -> DisputeOverrideResponse:
    proposal = (
        await db.execute(select(SwapProposal).where(SwapProposal.id == dispute_id))
    ).scalar_one_or_none()

    if proposal is None:
        booking = (
            await db.execute(select(Booking).where(Booking.id == dispute_id))
        ).scalar_one_or_none()
        if booking is None:
            raise ProblemDetailError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="dispute_not_found",
                title="Dispute Not Found",
                detail="No swap dispute or booking conflict found for this ID.",
            )
        if req.action not in ("clear_conflict", "dismiss"):
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="invalid_dispute_action",
                title="Invalid Dispute Action",
                detail=f"Action {req.action!r} is not valid for a booking claim conflict.",
            )
        booking.claim_conflict_flagged = False
        db.add(
            AuditLog(
                actor=f"admin:{actor.admin_email}",
                action="admin.dispute_override",
                resource=f"booking:{booking.id}",
                meta={"action": req.action, "note": req.note},
            )
        )
        await db.commit()
        return DisputeOverrideResponse(
            dispute_id=booking.id,
            dispute_type="claim_conflict",
            status="resolved",
            karma_reversed_users=[],
            karma_credited_users=[],
        )

    if req.action == "clear_conflict":
        raise ProblemDetailError(
            status_code=status.HTTP_409_CONFLICT,
            code="invalid_dispute_action",
            title="Invalid Dispute Action",
            detail="Action 'clear_conflict' is only valid for booking claim conflicts.",
        )

    parts = list(
        (
            await db.execute(
                select(SwapParticipant).where(SwapParticipant.proposal_id == proposal.id)
            )
        )
        .scalars()
        .all()
    )
    ji = (
        await db.execute(
            select(JourneyInstance).where(JourneyInstance.id == proposal.journey_instance_id)
        )
    ).scalar_one()
    participant_user_ids = sorted(
        {p.user_id for p in parts if p.user_id is not None},
        key=str,
    )

    reversed_users: list[UUID] = []
    credited_users: list[UUID] = []

    if req.action == "complete":
        was_completed = proposal.status == "completed"
        proposal.status = "completed"
        proposal.version += 1

        # Remove prior reversal rows so net wallet balance reflects completed swap.
        await db.execute(
            delete(KarmaLedger).where(
                KarmaLedger.proposal_id == proposal.id,
                KarmaLedger.state == "reversed",
            )
        )
        if not was_completed and participant_user_ids:
            await db.execute(
                update(User)
                .where(User.id.in_(participant_user_ids))
                .values(reliability_completed=User.reliability_completed + 1)
            )
        card = (
            await db.execute(select(SwapCard).where(SwapCard.proposal_id == proposal.id))
        ).scalar_one_or_none()
        if card is not None and card.revoked:
            card.revoked = False
            card.revoked_reason = None

        awarded = await credit_for_completed_proposal(
            db=db,
            proposal=proposal,
            parts=parts,
            ji=ji,
            yaml_configs=yaml_configs,
        )
        await evaluate_and_award_badges(db=db, proposal=proposal, parts=parts, ji=ji)
        credited_users = sorted(awarded.keys(), key=str)
    else:
        was_completed = proposal.status == "completed"
        proposal.status = "not_completed"
        proposal.version += 1
        if was_completed and participant_user_ids:
            await db.execute(
                update(User)
                .where(User.id.in_(participant_user_ids))
                .values(
                    reliability_completed=func.greatest(0, User.reliability_completed - 1)
                )
            )
        reversed_users = await reverse_for_proposal(
            db=db,
            proposal_id=proposal.id,
            reason=f"admin_override:{req.action}",
        )
        card = (
            await db.execute(select(SwapCard).where(SwapCard.proposal_id == proposal.id))
        ).scalar_one_or_none()
        if card is not None:
            card.revoked = True
            card.revoked_reason = req.note or f"admin_override:{req.action}"

    db.add(
        AuditLog(
            actor=f"admin:{actor.admin_email}",
            action="admin.dispute_override",
            resource=f"swap:{proposal.id}",
            meta={
                "action": req.action,
                "note": req.note,
                "status": proposal.status,
                "karma_reversed_users": [str(u) for u in reversed_users],
                "karma_credited_users": [str(u) for u in credited_users],
            },
        )
    )
    await db.commit()

    return DisputeOverrideResponse(
        dispute_id=proposal.id,
        dispute_type="swap_dispute",
        status=proposal.status,
        karma_reversed_users=reversed_users,
        karma_credited_users=credited_users,
    )


async def list_redemptions(
    *,
    db: AsyncSession,
    status_filter: Literal[
        "pending", "approved", "fulfilled", "rejected", "cancelled", "all"
    ] = "all",
    limit: int = 50,
    offset: int = 0,
) -> AdminRedemptionListResponse:
    where_clauses = []
    if status_filter != "all":
        where_clauses.append(RewardRedemption.status == status_filter)

    total_stmt = select(func.count(RewardRedemption.id))
    if where_clauses:
        total_stmt = total_stmt.where(*where_clauses)
    total = int((await db.execute(total_stmt)).scalar_one())

    stmt = (
        select(RewardRedemption, RewardItem, User)
        .join(RewardItem, RewardItem.id == RewardRedemption.reward_item_id)
        .outerjoin(User, User.id == RewardRedemption.user_id)
    )
    if where_clauses:
        stmt = stmt.where(*where_clauses)
    stmt = (
        stmt.order_by(RewardRedemption.created_at.desc(), RewardRedemption.id.desc())
        .limit(limit)
        .offset(offset)
    )

    rows = (await db.execute(stmt)).all()
    items = [
        AdminRedemptionDTO(
            id=redemption.id,
            user_id=redemption.user_id,
            user_display_alias=user.display_alias if user is not None else None,
            reward_code=item.code,
            title_en=item.title_en,
            points_spent=int(redemption.points_spent),
            status=redemption.status,
            reviewed_by=redemption.reviewed_by,
            created_at=redemption.created_at,
            updated_at=redemption.updated_at,
        )
        for redemption, item, user in rows
    ]

    return AdminRedemptionListResponse(items=items, total=total)


async def review_redemption(
    *,
    db: AsyncSession,
    actor: Actor,
    redemption_id: UUID,
    req: RedemptionReviewRequest,
) -> AdminRedemptionDTO:
    redemption = (
        await db.execute(
            select(RewardRedemption)
            .where(RewardRedemption.id == redemption_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if redemption is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="redemption_not_found",
            title="Redemption Not Found",
            detail="The requested reward redemption does not exist.",
        )

    item = (
        await db.execute(
            select(RewardItem)
            .where(RewardItem.id == redemption.reward_item_id)
            .with_for_update()
        )
    ).scalar_one()

    user = (
        (await db.execute(select(User).where(User.id == redemption.user_id))).scalar_one_or_none()
        if redemption.user_id is not None
        else None
    )

    if redemption.status in ("fulfilled", "rejected", "cancelled"):
        raise ProblemDetailError(
            status_code=status.HTTP_409_CONFLICT,
            code="invalid_redemption_state",
            title="Redemption Already Finalized",
            detail=f"Cannot review redemption in terminal state {redemption.status!r}.",
        )

    if req.action == "approve":
        if redemption.status != "pending":
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="invalid_redemption_state",
                title="Invalid Redemption Transition",
                detail=f"Cannot approve redemption in state {redemption.status!r}.",
            )
        new_status = "approved"
    elif req.action == "fulfill":
        new_status = "fulfilled"
    elif req.action == "reject":
        new_status = "rejected"
        if item.stock is not None:
            item.stock += 1
    else:
        new_status = "cancelled"
        if item.stock is not None:
            item.stock += 1

    now = datetime.now(UTC)
    redemption.status = new_status
    redemption.reviewed_by = f"admin:{actor.admin_email}"
    redemption.updated_at = now

    if redemption.user_id is not None:
        db.add(
            NotificationsOutbox(
                user_id=redemption.user_id,
                event="RewardRedemptionUpdated",
                payload={
                    "redemption_id": str(redemption.id),
                    "reward_code": item.code,
                    "status": new_status,
                    "note": req.note,
                },
                idempotency_key=f"reward_redemption_review:{redemption.id}:{new_status}",
            )
        )

    db.add(
        AuditLog(
            actor=f"admin:{actor.admin_email}",
            action=f"admin.redemption.{req.action}",
            resource=f"redemption:{redemption.id}",
            meta={
                "status": new_status,
                "reward_code": item.code,
                "points_spent": int(redemption.points_spent),
                "note": req.note,
            },
        )
    )
    await db.commit()
    await db.refresh(redemption)

    return AdminRedemptionDTO(
        id=redemption.id,
        user_id=redemption.user_id,
        user_display_alias=user.display_alias if user is not None else None,
        reward_code=item.code,
        title_en=item.title_en,
        points_spent=int(redemption.points_spent),
        status=redemption.status,
        reviewed_by=redemption.reviewed_by,
        created_at=redemption.created_at,
        updated_at=redemption.updated_at,
    )


async def list_audit_logs(
    *,
    db: AsyncSession,
    action: str | None = None,
    actor_filter: str | None = None,
    resource: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> AuditLogListResponse:
    where_clauses = []
    if action and action.strip():
        where_clauses.append(AuditLog.action == action.strip())
    if actor_filter and actor_filter.strip():
        where_clauses.append(AuditLog.actor == actor_filter.strip())
    if resource and resource.strip():
        where_clauses.append(AuditLog.resource == resource.strip())

    total_stmt = select(func.count(AuditLog.id))
    if where_clauses:
        total_stmt = total_stmt.where(*where_clauses)
    total = int((await db.execute(total_stmt)).scalar_one())

    stmt = select(AuditLog)
    if where_clauses:
        stmt = stmt.where(*where_clauses)
    stmt = stmt.order_by(AuditLog.at.desc(), AuditLog.id.desc()).limit(limit).offset(offset)

    rows = (await db.execute(stmt)).scalars().all()
    return AuditLogListResponse(
        items=[
            AuditLogItemDTO(
                id=row.id,
                actor=row.actor,
                action=row.action,
                resource=row.resource,
                meta=row.meta,
                at=row.at,
            )
            for row in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )
