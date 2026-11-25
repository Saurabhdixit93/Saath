from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, authorize
from saath_api.core.config import Settings, YamlConfigBundle
from saath_api.core.crypto import hash_token
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7
from saath_api.journeys.models import Booking, JourneyInstance
from saath_api.notifications.models import NotificationsOutbox
from saath_api.parties.models import Party, PartyMember
from saath_api.pricing.models import (
    B2BApiKey,
    Entitlement,
    PaymentOrder,
    PaymentWebhookEvent,
)
from saath_api.pricing.schemas import (
    B2BApiKeyMetaDTO,
    B2BKeyCreatedResponse,
    B2BStatsResponse,
    CheckoutRequest,
    CheckoutResponse,
    CreateB2BKeyRequest,
    EntitlementDTO,
    MyEntitlementsResponse,
    PricingPlanDTO,
    PricingPlansResponse,
    SandboxCompleteRequest,
    SandboxCompleteResponse,
    WebhookAckResponse,
)
from saath_api.providers.payment.base import PaymentGatewayProvider


def _entitlement_dto(row: Entitlement) -> EntitlementDTO:
    return EntitlementDTO(
        id=row.id,
        plan_code=row.plan_code,
        order_id=row.order_id,
        scope_journey_instance_id=row.scope_journey_instance_id,
        scope_party_id=row.scope_party_id,
        features=dict(row.features or {}),
        status=row.status,  # type: ignore[arg-type]
        valid_from=row.valid_from,
        valid_until=row.valid_until,
        created_at=row.created_at,
    )


def get_pricing_plans(yaml_configs: YamlConfigBundle) -> PricingPlansResponse:
    plans = [
        PricingPlanDTO(
            code=p.code,
            name=p.name,
            price_inr_paise=p.price_inr_paise,
            currency=p.currency,
            billing_type=p.billing_type,
            scope=p.scope,
            max_party_members=p.max_party_members,
            organiser_dashboard=p.organiser_dashboard,
            summary_export=p.summary_export,
            b2b_api=p.b2b_api,
            widget_access=p.widget_access,
            priority_seat_bump=False,
        )
        for p in yaml_configs.plans.plans.values()
    ]
    return PricingPlansResponse(plans=plans, anti_seat_sale_guarantee=True)


async def get_my_entitlements(
    *,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    actor: Actor,
) -> MyEntitlementsResponse:
    authorize(actor, "pricing.read_entitlements", resource_owner_id=actor.user_id)
    assert actor.user_id is not None

    ent_res = await db.execute(
        select(Entitlement)
        .where(Entitlement.user_id == actor.user_id)
        .order_by(Entitlement.created_at.desc())
    )
    entitlements = [_entitlement_dto(row) for row in ent_res.scalars().all()]

    keys_res = await db.execute(
        select(B2BApiKey)
        .where(B2BApiKey.user_id == actor.user_id)
        .order_by(B2BApiKey.created_at.desc())
    )
    keys = [
        B2BApiKeyMetaDTO(
            id=k.id,
            partner_name=k.partner_name,
            key_prefix=k.key_prefix,
            scopes=list(k.scopes),
            rate_limit_rpm=k.rate_limit_rpm,
            status=k.status,  # type: ignore[arg-type]
            created_at=k.created_at,
        )
        for k in keys_res.scalars().all()
    ]
    free_limit = yaml_configs.plans.plans["free_passenger"].max_party_members
    return MyEntitlementsResponse(
        entitlements=entitlements,
        b2b_api_keys=keys,
        free_party_limit=free_limit,
    )


async def _validate_checkout_scope(
    *,
    db: AsyncSession,
    actor: Actor,
    plan_code: str,
    journey_instance_id: UUID | None,
    party_id: UUID | None,
) -> tuple[UUID | None, UUID | None]:
    if plan_code != "group_organiser_pass":
        return journey_instance_id, party_id

    if journey_instance_id is None and party_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="missing_pass_scope",
            title="Journey or Party Required",
            detail="Select a verified journey or party for your Group-Organiser Trip Pass.",
        )

    resolved_ji = journey_instance_id
    if party_id is not None:
        party = (
            await db.execute(select(Party).where(Party.id == party_id))
        ).scalar_one_or_none()
        if party is None:
            raise ProblemDetailError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="party_not_found",
                title="Party Not Found",
                detail="The specified party was not found.",
            )
        if resolved_ji is not None and resolved_ji != party.journey_instance_id:
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="scope_mismatch",
                title="Scope Mismatch",
                detail="Party does not belong to the selected journey.",
            )
        resolved_ji = party.journey_instance_id

    if resolved_ji is not None:
        booking = (
            await db.execute(
                select(Booking).where(
                    Booking.journey_instance_id == resolved_ji,
                    Booking.owner_user_id == actor.user_id,
                )
            )
        ).scalars().first()
        if booking is None and party_id is not None:
            # Also permit if user is a member via another booking or party leader
            party_leader_ok = (
                await db.execute(
                    select(Party.id).where(
                        Party.id == party_id,
                        Party.leader_user_id == actor.user_id,
                    )
                )
            ).scalar_one_or_none()
            if party_leader_ok is None:
                raise ProblemDetailError(
                    status_code=status.HTTP_403_FORBIDDEN,
                    code="forbidden",
                    title="Forbidden",
                    detail="You do not belong to this journey or party.",
                )
        elif booking is None:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="forbidden",
                title="Forbidden",
                detail="You do not belong to this journey.",
            )

    return resolved_ji, party_id


async def create_checkout_order(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    payment_provider: PaymentGatewayProvider,
    actor: Actor,
    req: CheckoutRequest,
) -> CheckoutResponse:
    authorize(actor, "pricing.checkout", resource_owner_id=actor.user_id)
    assert actor.user_id is not None

    plan = yaml_configs.plans.plans.get(req.plan_code)
    if plan is None or req.plan_code == "free_passenger":
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="invalid_plan_code",
            title="Invalid Plan",
            detail="Choose a valid paid plan such as group_organiser_pass or b2b_partner.",
        )

    if plan.priority_seat_bump:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="seat_sale_forbidden",
            title="Seat Sales Forbidden",
            detail="Saath never sells seats or priority seat bumps.",
        )

    scoped_ji, scoped_party = await _validate_checkout_scope(
        db=db,
        actor=actor,
        plan_code=req.plan_code,
        journey_instance_id=req.journey_instance_id,
        party_id=req.party_id,
    )

    idem_key = (
        f"{actor.user_id}:{req.idempotency_key.strip()}"
        if req.idempotency_key
        else f"{actor.user_id}:{req.plan_code}:{uuid7().hex}"
    )
    existing = (
        await db.execute(
            select(PaymentOrder).where(PaymentOrder.idempotency_key == idem_key)
        )
    ).scalar_one_or_none()
    if existing is not None:
        return CheckoutResponse(
            order_id=existing.id,
            plan_code=existing.plan_code,
            provider=existing.provider,  # type: ignore[arg-type]
            provider_order_id=existing.provider_order_id or "",
            amount_paise=existing.amount_paise,
            currency=existing.currency,
            checkout_mode=existing.provider,
            key_id=settings.razorpay_key_id or None,
            status=existing.status,  # type: ignore[arg-type]
        )

    order_id = uuid7()
    # Amount strictly computed server-side from plans.yaml (never from request body)
    server_amount_paise = plan.price_inr_paise
    gateway_order = await payment_provider.create_order(
        order_id=order_id,
        amount_paise=server_amount_paise,
        currency=plan.currency,
        receipt=f"saath_{order_id.hex[:16]}",
        notes={
            "plan_code": plan.code,
            "journey_instance_id": str(scoped_ji) if scoped_ji else "",
            "party_id": str(scoped_party) if scoped_party else "",
        },
    )

    order = PaymentOrder(
        id=order_id,
        user_id=actor.user_id,
        plan_code=plan.code,
        journey_instance_id=scoped_ji,
        party_id=scoped_party,
        amount_paise=server_amount_paise,
        currency=plan.currency,
        provider=gateway_order.provider,
        provider_order_id=gateway_order.provider_order_id,
        status="created",
        idempotency_key=idem_key,
    )
    db.add(order)
    await db.commit()

    return CheckoutResponse(
        order_id=order.id,
        plan_code=order.plan_code,
        provider=order.provider,  # type: ignore[arg-type]
        provider_order_id=gateway_order.provider_order_id,
        amount_paise=order.amount_paise,
        currency=order.currency,
        checkout_mode=gateway_order.checkout_mode,
        key_id=settings.razorpay_key_id or None,
        status=order.status,  # type: ignore[arg-type]
    )


async def _activate_entitlement_for_order(
    *,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    order: PaymentOrder,
    provider_payment_id: str | None,
) -> tuple[Entitlement, str | None]:
    now = datetime.now(UTC)
    order.status = "paid"
    order.paid_at = order.paid_at or now
    if provider_payment_id:
        order.provider_payment_id = provider_payment_id

    existing_ent = (
        await db.execute(
            select(Entitlement).where(
                Entitlement.order_id == order.id,
                Entitlement.status == "active",
            )
        )
    ).scalar_one_or_none()
    if existing_ent is not None:
        return existing_ent, None

    plan = yaml_configs.plans.plans[order.plan_code]
    valid_until = (
        now + timedelta(days=30)
        if plan.billing_type == "per_trip"
        else now + timedelta(days=365)
    )
    entitlement = Entitlement(
        id=uuid7(),
        user_id=order.user_id,
        plan_code=order.plan_code,
        order_id=order.id,
        scope_journey_instance_id=order.journey_instance_id,
        scope_party_id=order.party_id,
        features={
            "max_party_members": plan.max_party_members,
            "organiser_dashboard": plan.organiser_dashboard,
            "summary_export": plan.summary_export,
            "b2b_api": plan.b2b_api,
            "widget_access": plan.widget_access,
            "priority_seat_bump": False,
        },
        status="active",
        valid_from=now,
        valid_until=valid_until,
    )
    db.add(entitlement)

    issued_raw_key: str | None = None
    if order.plan_code == "b2b_partner":
        existing_key = (
            await db.execute(
                select(B2BApiKey).where(
                    B2BApiKey.user_id == order.user_id,
                    B2BApiKey.status == "active",
                )
            )
        ).scalars().first()
        if existing_key is None:
            raw_key = f"sk_saath_{secrets.token_urlsafe(24)}"
            issued_raw_key = raw_key
            db.add(
                B2BApiKey(
                    id=uuid7(),
                    user_id=order.user_id,
                    partner_name="Saath Partner",
                    key_prefix=raw_key[:14],
                    key_hash=hash_token(raw_key),
                    scopes=["stats:read", "widget:embed"],
                    rate_limit_rpm=120,
                    status="active",
                )
            )

    db.add(
        NotificationsOutbox(
            user_id=order.user_id,
            event="EntitlementActivated",
            payload={
                "entitlement_id": str(entitlement.id),
                "plan_code": entitlement.plan_code,
                "order_id": str(order.id),
                "scope_journey_instance_id": (
                    str(order.journey_instance_id)
                    if order.journey_instance_id
                    else None
                ),
                "scope_party_id": str(order.party_id) if order.party_id else None,
            },
            idempotency_key=f"entitlement_activated:{order.id}",
        )
    )
    return entitlement, issued_raw_key


async def process_payment_webhook(
    *,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    payment_provider: PaymentGatewayProvider,
    raw_body: bytes,
    signature: str,
    header_event_id: str | None = None,
) -> WebhookAckResponse:
    sig_valid = payment_provider.verify_webhook_signature(raw_body, signature)
    try:
        payload: dict[str, Any] = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="invalid_webhook_payload",
            title="Invalid Webhook Payload",
            detail="Webhook body must be valid JSON.",
        ) from exc

    event_id = str(
        header_event_id
        or payload.get("event_id")
        or payload.get("id")
        or ""
    ).strip()
    event_type = str(payload.get("event") or payload.get("event_type") or "unknown")
    if not event_id:
        event_id = f"evt_{hash_token(raw_body.decode('utf-8', errors='ignore')).hex()[:24]}"

    if not sig_valid:
        await db.execute(
            pg_insert(PaymentWebhookEvent)
            .values(
                provider=payment_provider.name,
                event_id=f"invalid:{event_id}",
                event_type=event_type,
                payload=payload,
                signature_valid=False,
            )
            .on_conflict_do_nothing(index_elements=[PaymentWebhookEvent.event_id])
        )
        await db.commit()
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_webhook_signature",
            title="Invalid Webhook Signature",
            detail="Payment webhook signature verification failed.",
        )

    insert_stmt = (
        pg_insert(PaymentWebhookEvent)
        .values(
            provider=payment_provider.name,
            event_id=event_id,
            event_type=event_type,
            payload=payload,
            signature_valid=True,
        )
        .on_conflict_do_nothing(index_elements=[PaymentWebhookEvent.event_id])
        .returning(PaymentWebhookEvent.id)
    )
    inserted_id = (await db.execute(insert_stmt)).scalar_one_or_none()
    if inserted_id is None:
        await db.commit()
        return WebhookAckResponse(ok=True, duplicate=True)

    # Extract provider_order_id / order_id & payment_id from either Razorpay or simplified webhook shape
    provider_order_id: str | None = payload.get("provider_order_id")
    provider_payment_id: str | None = payload.get("provider_payment_id")
    internal_order_id: str | None = payload.get("order_id")

    pay_entity = (
        payload.get("payload", {}).get("payment", {}).get("entity", {})
        if isinstance(payload.get("payload"), dict)
        else {}
    )
    ord_entity = (
        payload.get("payload", {}).get("order", {}).get("entity", {})
        if isinstance(payload.get("payload"), dict)
        else {}
    )
    if isinstance(pay_entity, dict):
        provider_order_id = provider_order_id or pay_entity.get("order_id")
        provider_payment_id = provider_payment_id or pay_entity.get("id")
    if isinstance(ord_entity, dict):
        provider_order_id = provider_order_id or ord_entity.get("id")

    order: PaymentOrder | None = None
    if provider_order_id:
        order = (
            await db.execute(
                select(PaymentOrder)
                .where(PaymentOrder.provider_order_id == str(provider_order_id))
                .with_for_update()
            )
        ).scalar_one_or_none()
    if order is None and internal_order_id:
        try:
            oid = UUID(str(internal_order_id))
            order = (
                await db.execute(
                    select(PaymentOrder)
                    .where(PaymentOrder.id == oid)
                    .with_for_update()
                )
            ).scalar_one_or_none()
        except ValueError:
            order = None

    if order is not None:
        if event_type in ("payment.captured", "order.paid"):
            await _activate_entitlement_for_order(
                yaml_configs=yaml_configs,
                db=db,
                order=order,
                provider_payment_id=str(provider_payment_id) if provider_payment_id else None,
            )
        elif event_type == "payment.failed" and order.status != "paid":
            order.status = "failed"

    await db.commit()
    return WebhookAckResponse(ok=True, duplicate=False)


async def complete_sandbox_payment(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    payment_provider: PaymentGatewayProvider,
    actor: Actor,
    req: SandboxCompleteRequest,
) -> SandboxCompleteResponse:
    if settings.is_production or settings.payment_provider != "sandbox":
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="not_found",
            title="Not Found",
            detail="Endpoint is not available.",
        )

    authorize(actor, "pricing.sandbox_complete", resource_owner_id=actor.user_id)
    order = (
        await db.execute(
            select(PaymentOrder)
            .where(PaymentOrder.id == req.order_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if order is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="order_not_found",
            title="Order Not Found",
            detail="Payment order was not found.",
        )
    authorize(actor, "pricing.sandbox_complete", resource_owner_id=order.user_id)

    event_id = f"sbx_evt_{order.id.hex}_{req.outcome}"
    event_type = "payment.captured" if req.outcome == "paid" else "payment.failed"
    pay_id = f"pay_sbx_{order.id.hex[:16]}"
    payload_dict = {
        "event_id": event_id,
        "event": event_type,
        "order_id": str(order.id),
        "provider_order_id": order.provider_order_id,
        "provider_payment_id": pay_id,
    }

    # Record idempotent webhook event via same pipeline
    await db.execute(
        pg_insert(PaymentWebhookEvent)
        .values(
            provider=payment_provider.name,
            event_id=event_id,
            event_type=event_type,
            payload=payload_dict,
            signature_valid=True,
        )
        .on_conflict_do_nothing(index_elements=[PaymentWebhookEvent.event_id])
    )

    issued_key: str | None = None
    ent_dto: EntitlementDTO | None = None
    if req.outcome == "paid":
        ent, issued_key = await _activate_entitlement_for_order(
            yaml_configs=yaml_configs,
            db=db,
            order=order,
            provider_payment_id=pay_id,
        )
        await db.commit()
        await db.refresh(ent)
        ent_dto = _entitlement_dto(ent)
        return SandboxCompleteResponse(
            ok=True,
            order_id=order.id,
            status="paid",
            entitlement=ent_dto,
            b2b_api_key=issued_key,
        )

    order.status = "failed"
    await db.commit()
    return SandboxCompleteResponse(
        ok=True,
        order_id=order.id,
        status="failed",
        entitlement=None,
        b2b_api_key=None,
    )


async def create_b2b_api_key(
    *,
    db: AsyncSession,
    actor: Actor,
    req: CreateB2BKeyRequest,
) -> B2BKeyCreatedResponse:
    authorize(actor, "b2b.create_key", resource_owner_id=actor.user_id)
    assert actor.user_id is not None

    now = datetime.now(UTC)
    ent = (
        await db.execute(
            select(Entitlement).where(
                Entitlement.user_id == actor.user_id,
                Entitlement.plan_code == "b2b_partner",
                Entitlement.status == "active",
                Entitlement.valid_until.is_(None) | (Entitlement.valid_until > now),
            )
        )
    ).scalars().first()
    if ent is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="b2b_entitlement_required",
            title="B2B Partner Plan Required",
            detail="Activate a B2B / API Partner plan before issuing API keys.",
        )

    raw_key = f"sk_saath_{secrets.token_urlsafe(24)}"
    key_row = B2BApiKey(
        id=uuid7(),
        user_id=actor.user_id,
        partner_name=req.partner_name.strip(),
        key_prefix=raw_key[:14],
        key_hash=hash_token(raw_key),
        scopes=req.scopes,
        rate_limit_rpm=120,
        status="active",
    )
    db.add(key_row)
    await db.commit()
    await db.refresh(key_row)

    return B2BKeyCreatedResponse(
        id=key_row.id,
        partner_name=key_row.partner_name,
        key_prefix=key_row.key_prefix,
        api_key=raw_key,
        scopes=list(key_row.scopes),
        rate_limit_rpm=key_row.rate_limit_rpm,
        created_at=key_row.created_at,
    )


async def get_b2b_stats(
    *,
    db: AsyncSession,
    raw_api_key: str | None,
    actor: Actor | None,
) -> B2BStatsResponse:
    partner_name: str | None = None

    if raw_api_key:
        digest = hash_token(raw_api_key.strip())
        key_row = (
            await db.execute(select(B2BApiKey).where(B2BApiKey.key_hash == digest))
        ).scalar_one_or_none()
        if key_row is None or key_row.status != "active":
            raise ProblemDetailError(
                status_code=status.HTTP_401_UNAUTHORIZED,
                code="invalid_b2b_api_key",
                title="Invalid API Key",
                detail="B2B API key is missing, invalid, or revoked.",
            )
        if key_row.user_id is not None:
            now = datetime.now(UTC)
            owner_ent = (
                await db.execute(
                    select(Entitlement).where(
                        Entitlement.user_id == key_row.user_id,
                        Entitlement.plan_code == "b2b_partner",
                        Entitlement.status == "active",
                        Entitlement.valid_until.is_(None) | (Entitlement.valid_until > now),
                    )
                )
            ).scalars().first()
            if owner_ent is None:
                raise ProblemDetailError(
                    status_code=status.HTTP_403_FORBIDDEN,
                    code="b2b_entitlement_required",
                    title="B2B Partner Plan Required",
                    detail="B2B Partner entitlement has expired or is inactive.",
                )
        partner_name = key_row.partner_name
    elif actor is not None and actor.kind == "user" and actor.user_id is not None:
        now = datetime.now(UTC)
        ent = (
            await db.execute(
                select(Entitlement).where(
                    Entitlement.user_id == actor.user_id,
                    Entitlement.plan_code == "b2b_partner",
                    Entitlement.status == "active",
                    Entitlement.valid_until.is_(None) | (Entitlement.valid_until > now),
                )
            )
        ).scalars().first()
        if ent is None:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="b2b_entitlement_required",
                title="B2B Partner Plan Required",
                detail="Active B2B Partner entitlement or valid X-API-Key is required.",
            )
        partner_name = "B2B Partner"
    else:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="missing_b2b_credentials",
            title="API Key Required",
            detail="Provide a valid X-API-Key header or B2B Partner bearer token.",
        )

    total_journeys = int(
        (await db.execute(select(func.count(JourneyInstance.id)))).scalar_one() or 0
    )
    verified_bookings = int(
        (await db.execute(select(func.count(Booking.id)))).scalar_one() or 0
    )
    active_parties = int(
        (await db.execute(select(func.count(Party.id)))).scalar_one() or 0
    )
    _ = PartyMember

    return B2BStatsResponse(
        partner_name=partner_name,
        total_journeys=total_journeys,
        verified_bookings=verified_bookings,
        active_parties=active_parties,
        supported_modes=["train", "flight"],
        anti_seat_sale_guarantee=True,
    )
