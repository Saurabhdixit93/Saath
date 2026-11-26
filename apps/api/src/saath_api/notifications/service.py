from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import structlog
from fastapi import status
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor
from saath_api.auth.models import AuditLog, Device, User
from saath_api.auth.schemas import NotificationChannelsDTO, NotificationChannelsPatchDTO
from saath_api.core.config import Settings, YamlConfigBundle
from saath_api.core.crypto import (
    blind_index_phone,
    decrypt_phone,
    encrypt_phone,
    normalize_indian_phone,
    verify_hmac_sha256_hex,
)
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7
from saath_api.journeys.models import Booking, JourneyInstance
from saath_api.journeys.schemas import VerifyJourneyRequest
from saath_api.journeys.service import verify_journey
from saath_api.matching.models import MatchCandidate
from saath_api.notifications.models import NotificationsOutbox
from saath_api.notifications.schemas import (
    PushSubscriptionRequest,
    PushSubscriptionResponse,
    WhatsAppWebhookResponse,
)
from saath_api.notifications.templates import (
    EXTERNAL_NOTIFICATION_EVENTS,
    INTERNAL_ONLY_EVENTS,
    URGENT_CHART_EVENTS,
    is_quiet_hours_ist,
    is_urgent_chart_bypass,
    next_quiet_hours_end_utc,
    render_notification,
)
from saath_api.parties.models import Party, PartyMember
from saath_api.parties.schemas import GoalConstraintsDTO, PutGoalRequest
from saath_api.parties.service import put_party_goal
from saath_api.providers.base import ProviderError
from saath_api.providers.flight.schedule import FlightScheduleProvider
from saath_api.providers.messaging import MessagingProvider
from saath_api.providers.push import PushSubscriptionExpiredError, WebPushProvider
from saath_api.providers.rail.router import ProviderRouter
from saath_api.swaps.models import SwapProposal

logger = structlog.get_logger(__name__)

_PNR_RE = re.compile(r"\b([0-9]{10})\b")
_MAX_OUTBOX_ATTEMPTS = 5


async def _resolve_departure_at(
    db: AsyncSession, payload: dict[str, Any]
) -> datetime | None:
    ji_raw = payload.get("journey_instance_id") or payload.get("journey_id")
    if isinstance(ji_raw, str):
        try:
            ji_id = UUID(ji_raw)
            dep = (
                await db.execute(
                    select(JourneyInstance.departure_at).where(
                        JourneyInstance.id == ji_id
                    )
                )
            ).scalar_one_or_none()
            if dep is not None:
                return dep
        except ValueError:
            pass

    swap_raw = payload.get("swap_id")
    if isinstance(swap_raw, str):
        try:
            swap_id = UUID(swap_raw)
            dep = (
                await db.execute(
                    select(JourneyInstance.departure_at)
                    .join(
                        SwapProposal,
                        SwapProposal.journey_instance_id == JourneyInstance.id,
                    )
                    .where(SwapProposal.id == swap_id)
                )
            ).scalar_one_or_none()
            if dep is not None:
                return dep
        except ValueError:
            pass
    return None


async def deliver_outbox_batch(
    *,
    settings: Settings,
    db: AsyncSession,
    redis: Redis | None,
    web_push_provider: WebPushProvider,
    messaging_provider: MessagingProvider,
    batch_size: int = 50,
    now_override: datetime | None = None,
) -> dict[str, int]:
    now = now_override or datetime.now(UTC)
    rows = list(
        (
            await db.execute(
                select(NotificationsOutbox)
                .where(
                    NotificationsOutbox.status == "queued",
                    (
                        NotificationsOutbox.next_attempt_at.is_(None)
                        | (NotificationsOutbox.next_attempt_at <= now)
                    ),
                )
                .order_by(NotificationsOutbox.created_at.asc())
                .limit(batch_size)
                .with_for_update(skip_locked=True)
            )
        )
        .scalars()
        .all()
    )

    stats = {"sent": 0, "deferred": 0, "retried": 0, "dead_letter": 0}
    if not rows:
        return stats

    for row in rows:
        if row.user_id is None or row.event in INTERNAL_ONLY_EVENTS or (
            row.event not in EXTERNAL_NOTIFICATION_EVENTS
        ):
            row.status = "sent"
            row.sent_at = now
            stats["sent"] += 1
            continue

        idemp_redis_key = f"notif:delivered:{row.idempotency_key}"
        if redis is not None:
            try:
                if await redis.exists(idemp_redis_key):
                    row.status = "sent"
                    row.sent_at = now
                    stats["sent"] += 1
                    continue
            except Exception:
                pass

        user = (
            await db.execute(select(User).where(User.id == row.user_id))
        ).scalar_one_or_none()
        if user is None or user.status in ("banned", "deleted"):
            row.status = "sent"
            row.sent_at = now
            stats["sent"] += 1
            continue

        prefs = user.notification_channels
        if prefs.get("quiet_hours_enabled", True) and is_quiet_hours_ist(now):
            dep_at = (
                await _resolve_departure_at(db, row.payload)
                if row.event in URGENT_CHART_EVENTS
                else None
            )
            if not is_urgent_chart_bypass(row.event, dep_at, now):
                row.next_attempt_at = next_quiet_hours_end_utc(now)
                stats["deferred"] += 1
                continue

        rendered = render_notification(
            event=row.event,
            payload=dict(row.payload or {}),
            locale=user.locale,
        )

        delivered_channel: str | None = None
        last_error: str | None = None
        attempted_any = False

        # 1. Web Push
        if prefs.get("push", True):
            devices = list(
                (
                    await db.execute(
                        select(Device).where(
                            Device.user_id == user.id,
                            Device.push_endpoint.is_not(None),
                        )
                    )
                )
                .scalars()
                .all()
            )
            for dev in devices:
                if not dev.push_endpoint or not dev.push_p256dh or not dev.push_auth:
                    continue
                attempted_any = True
                try:
                    await web_push_provider.send_push(
                        endpoint=dev.push_endpoint,
                        p256dh=dev.push_p256dh,
                        auth=dev.push_auth,
                        title=rendered.title,
                        body=rendered.body,
                        url=rendered.url,
                        data={"event": row.event, **dict(row.payload or {})},
                    )
                    delivered_channel = "push"
                except PushSubscriptionExpiredError as exc:
                    last_error = str(exc)
                    dev.push_endpoint = None
                    dev.push_p256dh = None
                    dev.push_auth = None
                except ProviderError as exc:
                    last_error = str(exc)

        # 2. WhatsApp fallback
        phone_e164: str | None = None
        if delivered_channel is None and (
            prefs.get("whatsapp", True) or prefs.get("sms", True)
        ):
            try:
                phone_e164 = decrypt_phone(user.phone_enc, settings.phone_aes_key)
            except Exception as exc:
                last_error = f"phone_decrypt_failed: {exc}"

        if delivered_channel is None and prefs.get("whatsapp", True) and phone_e164:
            attempted_any = True
            try:
                await messaging_provider.send_template(
                    phone_e164=phone_e164,
                    template_name=rendered.template_name,
                    locale=user.locale,
                    params=rendered.params,
                    channel="whatsapp",
                )
                delivered_channel = "whatsapp"
            except ProviderError as exc:
                last_error = str(exc)

        # 3. SMS fallback
        if delivered_channel is None and prefs.get("sms", True) and phone_e164:
            attempted_any = True
            try:
                await messaging_provider.send_template(
                    phone_e164=phone_e164,
                    template_name=rendered.template_name,
                    locale=user.locale,
                    params=rendered.params,
                    channel="sms",
                )
                delivered_channel = "sms"
            except ProviderError as exc:
                last_error = str(exc)

        if delivered_channel is not None:
            if redis is not None:
                try:
                    await redis.set(idemp_redis_key, "1", ex=86400)
                except Exception:
                    pass
            row.status = "sent"
            row.channel = delivered_channel
            row.sent_at = now
            row.last_error = None
            stats["sent"] += 1
            continue

        if not attempted_any and last_error is None:
            # User explicitly disabled all channels and has no push subscription
            row.status = "sent"
            row.channel = "internal"
            row.sent_at = now
            stats["sent"] += 1
            continue

        row.attempts += 1
        row.last_error = (last_error or "delivery_failed")[:500]
        if row.attempts >= _MAX_OUTBOX_ATTEMPTS:
            row.status = "dead_letter"
            stats["dead_letter"] += 1
        else:
            backoff_sec = min(3600, 30 * (2 ** (row.attempts - 1)))
            row.next_attempt_at = now + timedelta(seconds=backoff_sec)
            stats["retried"] += 1

    await db.commit()
    return stats


async def register_push_subscription(
    *,
    db: AsyncSession,
    actor: Actor,
    req: PushSubscriptionRequest,
) -> PushSubscriptionResponse:
    assert actor.user_id is not None
    now = datetime.now(UTC)

    device: Device | None = None
    if actor.device_id is not None:
        device = (
            await db.execute(
                select(Device).where(
                    Device.id == actor.device_id,
                    Device.user_id == actor.user_id,
                )
            )
        ).scalar_one_or_none()

    if device is None:
        device = (
            await db.execute(
                select(Device)
                .where(Device.user_id == actor.user_id)
                .order_by(Device.last_seen_at.desc().nullslast(), Device.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

    if device is None:
        device = Device(
            id=uuid7(),
            user_id=actor.user_id,
            push_endpoint=req.endpoint,
            push_p256dh=req.keys.p256dh,
            push_auth=req.keys.auth,
            last_seen_at=now,
        )
        db.add(device)
    else:
        device.push_endpoint = req.endpoint
        device.push_p256dh = req.keys.p256dh
        device.push_auth = req.keys.auth
        device.last_seen_at = now

    await db.commit()
    return PushSubscriptionResponse(subscribed=True)


async def get_notification_prefs(
    *, db: AsyncSession, actor: Actor
) -> NotificationChannelsDTO:
    assert actor.user_id is not None
    user = (
        await db.execute(select(User).where(User.id == actor.user_id))
    ).scalar_one()
    return NotificationChannelsDTO.model_validate(user.notification_channels)


async def update_notification_prefs(
    *,
    db: AsyncSession,
    actor: Actor,
    req: NotificationChannelsPatchDTO,
) -> NotificationChannelsDTO:
    assert actor.user_id is not None
    user = (
        await db.execute(select(User).where(User.id == actor.user_id))
    ).scalar_one()
    merged = dict(user.notification_channels)
    if req.push is not None:
        merged["push"] = req.push
    if req.whatsapp is not None:
        merged["whatsapp"] = req.whatsapp
    if req.sms is not None:
        merged["sms"] = req.sms
    if req.quiet_hours_enabled is not None:
        merged["quiet_hours_enabled"] = req.quiet_hours_enabled
    user.notification_prefs = merged
    await db.commit()
    await db.refresh(user)
    return NotificationChannelsDTO.model_validate(user.notification_channels)


def _extract_whatsapp_messages(payload: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Return list of (wamid, from_phone, text_or_button_title) tuples."""
    extracted: list[tuple[str, str, str]] = []
    entries = payload.get("entry")
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            changes = entry.get("changes")
            if not isinstance(changes, list):
                continue
            for change in changes:
                if not isinstance(change, dict):
                    continue
                value = change.get("value")
                if not isinstance(value, dict):
                    continue
                msgs = value.get("messages")
                if not isinstance(msgs, list):
                    continue
                for m in msgs:
                    if not isinstance(m, dict):
                        continue
                    wamid = str(m.get("id") or "")
                    sender = str(m.get("from") or "")
                    text_val = ""
                    if m.get("type") == "text" and isinstance(m.get("text"), dict):
                        text_val = str(m["text"].get("body") or "")
                    elif m.get("type") == "interactive" and isinstance(
                        m.get("interactive"), dict
                    ):
                        btn = m["interactive"].get("button_reply")
                        if isinstance(btn, dict):
                            text_val = str(btn.get("title") or btn.get("id") or "")
                    elif isinstance(m.get("text"), str):
                        text_val = m["text"]
                    if wamid and sender:
                        extracted.append((wamid, sender, text_val))
    elif "messages" in payload and isinstance(payload["messages"], list):
        for m in payload["messages"]:
            if isinstance(m, dict):
                wamid = str(m.get("id") or "")
                sender = str(m.get("from") or "")
                text_val = (
                    str(m["text"].get("body") or "")
                    if isinstance(m.get("text"), dict)
                    else str(m.get("text") or "")
                )
                if wamid and sender:
                    extracted.append((wamid, sender, text_val))
    return extracted


async def _find_or_create_whatsapp_user(
    *,
    settings: Settings,
    db: AsyncSession,
    raw_phone: str,
) -> tuple[User, str]:
    cleaned = raw_phone.strip()
    if cleaned.startswith("+"):
        phone_e164 = normalize_indian_phone(cleaned)
    elif cleaned.startswith("91") and len(cleaned) == 12:
        phone_e164 = normalize_indian_phone("+" + cleaned)
    else:
        phone_e164 = normalize_indian_phone(cleaned)

    phone_bidx = blind_index_phone(phone_e164, settings.phone_blind_index_key)
    user = (
        await db.execute(select(User).where(User.phone_bidx == phone_bidx))
    ).scalar_one_or_none()
    if user is None:
        uid = uuid7()
        await db.execute(
            pg_insert(User)
            .values(
                id=uid,
                phone_enc=encrypt_phone(phone_e164, settings.phone_aes_key),
                phone_bidx=phone_bidx,
                locale="en",
                gender_self="undisclosed",
                women_only_default=False,
                status="active",
            )
            .on_conflict_do_nothing(index_elements=[User.phone_bidx])
        )
        user = (
            await db.execute(select(User).where(User.phone_bidx == phone_bidx))
        ).scalar_one()
        db.add(
            AuditLog(
                actor=f"user:{user.id}",
                action="auth.whatsapp_auto_provisioned",
                resource=f"user:{user.id}",
                meta={},
            )
        )
        await db.commit()
    return user, phone_e164


async def process_whatsapp_webhook(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    redis: Redis,
    rail_router: ProviderRouter,
    flight_provider: FlightScheduleProvider,
    messaging_provider: MessagingProvider,
    raw_body: bytes,
    signature_header: str | None,
) -> WhatsAppWebhookResponse:
    if settings.is_production and not settings.whatsapp_app_secret:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="whatsapp_secret_missing",
            title="WhatsApp webhook secret not configured",
            detail="WhatsApp webhook secret is not configured.",
        )
    if settings.whatsapp_app_secret or settings.is_production:
        if not signature_header or not signature_header.startswith("sha256="):
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="invalid_webhook_signature",
                title="Invalid Webhook Signature",
                detail="Missing or malformed X-Hub-Signature-256 header.",
            )
        sig_hex = signature_header.split("=", 1)[1]
        if not verify_hmac_sha256_hex(settings.whatsapp_app_secret, raw_body, sig_hex):
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="invalid_webhook_signature",
                title="Invalid Webhook Signature",
                detail="WhatsApp webhook signature verification failed.",
            )
    elif signature_header is not None:
        # Even in local dev when WHATSAPP_APP_SECRET is empty, reject explicitly invalid signatures
        if not signature_header.startswith("sha256="):
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="invalid_webhook_signature",
                title="Invalid Webhook Signature",
                detail="Malformed X-Hub-Signature-256 header.",
            )
        sig_hex = signature_header.split("=", 1)[1]
        if not verify_hmac_sha256_hex("dev-whatsapp-app-secret", raw_body, sig_hex):
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="invalid_webhook_signature",
                title="Invalid Webhook Signature",
                detail="WhatsApp webhook signature verification failed.",
            )

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="invalid_webhook_payload",
            title="Invalid Webhook Payload",
            detail="Webhook body must be valid JSON.",
        ) from exc

    if not isinstance(payload, dict):
        return WhatsAppWebhookResponse(ok=True, processed=0, deduped=0)

    messages = _extract_whatsapp_messages(payload)
    processed = 0
    deduped = 0

    for wamid, raw_phone, body_text in messages:
        dedupe_key = f"wa:wamid:{wamid}"
        was_set = await redis.set(dedupe_key, "1", nx=True, ex=86400)
        if not was_set:
            deduped += 1
            continue

        try:
            user, phone_e164 = await _find_or_create_whatsapp_user(
                settings=settings, db=db, raw_phone=raw_phone
            )
        except ProblemDetailError:
            processed += 1
            continue

        actor = Actor(
            kind="user",
            user_id=user.id,
            anon_id=None,
            device_id=None,
            scopes=frozenset({"user"}),
        )

        cleaned_text = body_text.strip()
        pnr_match = _PNR_RE.search(cleaned_text)
        if pnr_match:
            pnr = pnr_match.group(1)
            try:
                verified = await verify_journey(
                    settings=settings,
                    yaml_configs=yaml_configs,
                    db=db,
                    redis=redis,
                    rail_router=rail_router,
                    flight_provider=flight_provider,
                    actor=actor,
                    req=VerifyJourneyRequest(mode="train", pnr=pnr),
                    client_ip="127.0.0.1",
                )
                await redis.set(
                    f"wa:ctx:{user.id}",
                    json.dumps(
                        {
                            "journey_id": str(verified.journey.id),
                            "party_id": str(verified.party_id),
                        }
                    ),
                    ex=86400,
                )
                match_cnt = int(
                    (
                        await db.execute(
                            select(func.count(MatchCandidate.id)).where(
                                MatchCandidate.for_party_id == verified.party_id
                            )
                        )
                    ).scalar_one()
                    or 0
                )
                hub_url = f"{settings.app_url.rstrip('/')}/journeys/{verified.journey.id}"
                reply_txt = (
                    f"Verified {verified.journey.service_no} ({verified.journey.service_date}). "
                    f"Chart: {verified.chart.state}. Matches ready: {match_cnt}. "
                    f"Open: {hub_url}"
                )
                await messaging_provider.send_whatsapp_reply(
                    phone_e164=phone_e164,
                    text=reply_txt,
                    buttons=[
                        ("goal_lower", "Find me a lower"),
                        ("goal_open_to_help", "Open to help"),
                    ],
                )
            except ProblemDetailError as exc:
                await messaging_provider.send_whatsapp_reply(
                    phone_e164=phone_e164,
                    text=exc.detail,
                )
            processed += 1
            continue

        lowered = cleaned_text.lower()
        if lowered in ("find me a lower", "goal_lower", "open to help", "goal_open_to_help"):
            goal_type = "lower" if "lower" in lowered else "open_to_help"
            ctx_raw = await redis.get(f"wa:ctx:{user.id}")
            party_id: UUID | None = None
            journey_id_str = ""
            if ctx_raw:
                try:
                    ctx_obj = json.loads(ctx_raw)
                    party_id = UUID(str(ctx_obj["party_id"]))
                    journey_id_str = str(ctx_obj.get("journey_id") or "")
                except (ValueError, KeyError, TypeError):
                    party_id = None
            if party_id is None:
                latest_party = (
                    await db.execute(
                        select(Party)
                        .where(Party.leader_user_id == user.id)
                        .order_by(Party.created_at.desc())
                        .limit(1)
                    )
                ).scalar_one_or_none()
                if latest_party is not None:
                    party_id = latest_party.id
                    journey_id_str = str(latest_party.journey_instance_id)

            if party_id is not None:
                mover_ids = list(
                    (
                        await db.execute(
                            select(PartyMember.seat_holder_id).where(
                                PartyMember.party_id == party_id
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                try:
                    hub = await put_party_goal(
                        db=db,
                        redis=redis,
                        actor=actor,
                        party_id=party_id,
                        req=PutGoalRequest(
                            goal_type=goal_type,  # type: ignore[arg-type]
                            movers=mover_ids,
                            constraints=GoalConstraintsDTO(),
                        ),
                    )
                    deep_link = (
                        f"{settings.app_url.rstrip('/')}/journeys/{journey_id_str}/matches"
                        if journey_id_str
                        else f"{settings.app_url.rstrip('/')}/journeys"
                    )
                    await messaging_provider.send_whatsapp_reply(
                        phone_e164=phone_e164,
                        text=f"Goal saved ({hub.goal.goal_type if hub.goal else goal_type}). View matches: {deep_link}",
                    )
                except ProblemDetailError as exc:
                    await messaging_provider.send_whatsapp_reply(
                        phone_e164=phone_e164,
                        text=exc.detail,
                    )
            processed += 1
            continue

        # Non-PNR / general text ignored gracefully with 200 OK
        processed += 1

    return WhatsAppWebhookResponse(ok=True, processed=processed, deduped=deduped)
