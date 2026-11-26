from __future__ import annotations

import re
import secrets
from datetime import UTC, date, datetime, time, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor
from saath_api.auth.models import AuditLog
from saath_api.core.config import Settings, YamlConfigBundle
from saath_api.core.crypto import hash_invite_token
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7
from saath_api.journeys.chart_rules import compute_chart_due_at
from saath_api.journeys.chart_watcher import compute_public_train_chart_time
from saath_api.journeys.geometry import normalize_coach_class, seat_to_bay_and_type
from saath_api.journeys.models import JourneyInstance
from saath_api.journeys.schemas import AircraftLayoutSummaryDTO, PublicChartTimeResponse
from saath_api.journeys.service import _load_actor_journey_context
from saath_api.providers.flight.layouts import (
    AIRCRAFT_LAYOUTS,
    validate_and_classify_flight_seat,
)
from saath_api.providers.rail.protocol import (
    RailPnrFlushedError,
    RailPnrInvalidError,
    RailPnrNotFoundError,
    RailProviderError,
)
from saath_api.providers.rail.router import ProviderRouter
from saath_api.public.models import SeatInvite
from saath_api.public.schemas import (
    CreateSeatInviteRequest,
    PublicFlightLayoutsResponse,
    PublicPnrStatusItemDTO,
    PublicPnrStatusResponse,
    PublicSeatInviteResponse,
    PublicStatsResponse,
    PublicTrainCoachDTO,
    PublicTrainCompositionResponse,
    PublicTrainLiveResponse,
    SeatInviteResponse,
)
from saath_api.public.train_catalog import (
    get_train_entry,
    is_valid_train_no,
    train_catalog_count,
)
from saath_api.swaps.models import SwapProposal

IST = ZoneInfo("Asia/Kolkata")
_COACH_RE = re.compile(r"^[HABMSCED][0-9]{1,2}$")


def _actor_label(actor: Actor) -> str:
    if actor.kind == "user" and actor.user_id is not None:
        return f"user:{actor.user_id}"
    if actor.anon_id:
        return f"anon:{actor.anon_id}"
    return "anon:unknown"


async def create_seat_invite(
    *,
    settings: Settings,
    db: AsyncSession,
    actor: Actor,
    journey_id: UUID,
    req: CreateSeatInviteRequest,
) -> SeatInviteResponse:
    ji, booking, _ = await _load_actor_journey_context(
        db=db, actor=actor, journey_id=journey_id
    )

    target_coach: str | None = (
        req.coach.strip().upper() if req.coach is not None and req.coach.strip() else None
    )
    target_seat_no: str | None = (
        req.seat_no.strip().upper()
        if req.seat_no is not None and req.seat_no.strip()
        else None
    )

    if ji.mode == "train":
        if target_coach is not None and not _COACH_RE.fullmatch(target_coach):
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_seat_target",
                title="Invalid Coach Target",
                detail="Coach code must be a valid Indian Railways coach such as B5, S3, A1, or C2.",
            )
        if target_seat_no is not None:
            tclass = normalize_coach_class(booking.travel_class, target_coach)
            try:
                seat_to_bay_and_type(tclass, target_seat_no)
            except ValueError as exc:
                raise ProblemDetailError(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    code="invalid_seat_target",
                    title="Invalid Seat Target",
                    detail=str(exc),
                ) from exc
    elif ji.mode == "flight":
        if target_coach is not None and target_coach != "CABIN":
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_seat_target",
                title="Invalid Cabin Target",
                detail="Flight invites only accept CABIN as target coach.",
            )
        if target_seat_no is not None:
            try:
                classified = validate_and_classify_flight_seat(
                    ji.layout_ref, target_seat_no, carrier_code=ji.carrier_code
                )
                target_seat_no = classified.seat_no
            except ValueError as exc:
                raise ProblemDetailError(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    code="invalid_seat_target",
                    title="Invalid Seat Target",
                    detail=str(exc),
                ) from exc

    now = datetime.now(UTC)
    expires_at = now + timedelta(hours=72)
    raw_token = secrets.token_urlsafe(16)
    token_hash = hash_invite_token(raw_token, settings.invite_token_secret)

    invite = SeatInvite(
        id=uuid7(),
        journey_instance_id=ji.id,
        inviter_user_id=actor.user_id if actor.kind == "user" else None,
        inviter_anon_id=actor.anon_id if actor.kind == "anon" else None,
        token_hash=token_hash,
        target_coach=target_coach,
        target_seat_no=target_seat_no,
        expires_at=expires_at,
        conversions_count=0,
    )
    db.add(invite)
    db.add(
        AuditLog(
            actor=_actor_label(actor),
            action="seat_invite.created",
            resource=f"journey:{ji.id}",
            meta={
                "invite_id": str(invite.id),
                "target_coach": target_coach,
                "has_target_seat": target_seat_no is not None,
            },
        )
    )
    await db.commit()

    invite_url = f"{settings.app_url.rstrip('/')}/j/{raw_token}"
    date_iso = ji.service_date.isoformat()

    if target_coach and target_seat_no:
        seat_en = f" (Coach {target_coach}, Seat {target_seat_no})"
        seat_hi = f" (कोच {target_coach}, सीट {target_seat_no})"
    elif target_coach:
        seat_en = f" (Coach {target_coach})"
        seat_hi = f" (कोच {target_coach})"
    elif target_seat_no:
        seat_en = f" (Seat {target_seat_no})"
        seat_hi = f" (सीट {target_seat_no})"
    else:
        seat_en = ""
        seat_hi = ""

    message_en = (
        f"Travelling on {ji.service_no} ({date_iso}){seat_en}? "
        f"Join Saath to help swap seats safely—free and private until we both agree: {invite_url}"
    )
    message_hi = (
        f"क्या आप सेवा {ji.service_no} ({date_iso}){seat_hi} में सफ़र कर रहे हैं? "
        f"साथ (Saath) पर सुरक्षित और मुफ़्त सीट स्वैप से जुड़ें—सहमति से पहले नाम गुप्त रहता है: {invite_url}"
    )

    return SeatInviteResponse(
        invite_url=invite_url,
        token=raw_token,
        expires_at=expires_at,
        message_en=message_en,
        message_hi=message_hi,
        target_coach=target_coach,
        target_seat_no=target_seat_no,
        conversions_count=0,
    )


async def get_public_seat_invite(
    *,
    settings: Settings,
    db: AsyncSession,
    token: str,
) -> PublicSeatInviteResponse:
    cleaned = token.strip()
    if len(cleaned) < 8:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="seat_invite_not_found",
            title="Invite Not Found",
            detail="This seat invite link was not found or is invalid.",
        )

    token_hash = hash_invite_token(cleaned, settings.invite_token_secret)
    res = await db.execute(
        select(SeatInvite, JourneyInstance)
        .join(JourneyInstance, JourneyInstance.id == SeatInvite.journey_instance_id)
        .where(SeatInvite.token_hash == token_hash)
    )
    row = res.first()
    if row is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="seat_invite_not_found",
            title="Invite Not Found",
            detail="This seat invite link was not found or is invalid.",
        )

    invite, ji = row
    if invite.expires_at <= datetime.now(UTC):
        raise ProblemDetailError(
            status_code=status.HTTP_410_GONE,
            code="seat_invite_expired",
            title="Invite Expired",
            detail="This seat invite link has expired after 72 hours.",
        )

    return PublicSeatInviteResponse(
        valid=True,
        mode=ji.mode,  # type: ignore[arg-type]
        carrier_code=ji.carrier_code,
        service_no=ji.service_no,
        service_date=ji.service_date,
        target_coach=invite.target_coach,
        target_seat_no=invite.target_seat_no,
        expires_at=invite.expires_at,
        conversions_count=invite.conversions_count,
    )


async def get_public_pnr_status(
    *,
    pnr: str,
    rail_router: ProviderRouter,
    yaml_configs: YamlConfigBundle,
) -> PublicPnrStatusResponse:
    try:
        dto = await rail_router.get_pnr(pnr)
    except RailPnrInvalidError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="invalid_pnr",
            title="Invalid PNR",
            detail=str(exc),
        ) from exc
    except RailPnrFlushedError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="pnr_flushed",
            title="PNR Flushed or Cancelled",
            detail=str(exc),
        ) from exc
    except RailPnrNotFoundError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="pnr_not_found",
            title="PNR Not Found",
            detail=str(exc),
        ) from exc
    except RailProviderError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="rail_provider_unavailable",
            title="Rail Status Temporarily Unavailable",
            detail="Unable to reach rail status service right now. Please try again shortly.",
        ) from exc

    chart_due_at = compute_chart_due_at(
        dto.departure_at,
        train_no=dto.train_no,
        rules=yaml_configs.chart_rules,
    )

    confirmed_count = 0
    rac_count = 0
    wl_count = 0
    coaches_set: set[str] = set()
    berth_types_set: set[str] = set()
    summary_items: list[PublicPnrStatusItemDTO] = []

    for pax in dto.passengers:
        cur = pax.current_status.strip().upper()
        if cur.startswith("CNF"):
            confirmed_count += 1
        elif cur.startswith("RAC"):
            rac_count += 1
        else:
            wl_count += 1
        if pax.coach:
            coaches_set.add(pax.coach)
        if pax.seat_type:
            berth_types_set.add(pax.seat_type)
        summary_items.append(
            PublicPnrStatusItemDTO(
                pax_seq=pax.pax_seq,
                booking_status=pax.booking_status,
                current_status=pax.current_status,
                coach=pax.coach,
                seat_type=pax.seat_type,
                bay=pax.bay,
            )
        )

    return PublicPnrStatusResponse(
        train_no=dto.train_no,
        train_name=dto.train_name,
        service_date=dto.service_date,
        travel_class=dto.travel_class,
        from_code=dto.from_code,
        to_code=dto.to_code,
        departure_at=dto.departure_at,
        arrival_at=dto.arrival_at,
        chart_state=dto.chart_state,
        chart_due_at=chart_due_at,
        passenger_count=len(dto.passengers),
        confirmed_count=confirmed_count,
        rac_count=rac_count,
        wl_count=wl_count,
        coaches=sorted(coaches_set),
        berth_types=sorted(berth_types_set),
        status_summary=summary_items,
    )


def _assert_valid_train_no(train_no: str) -> str:
    cleaned = train_no.strip()
    if not is_valid_train_no(cleaned):
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="train_not_found",
            title="Train Not Found",
            detail=f"Train {cleaned or 'unknown'} was not found.",
        )
    return cleaned


async def get_public_train_live(
    *,
    train_no: str,
    service_date: date,
    rail_router: ProviderRouter,
    yaml_configs: YamlConfigBundle,
) -> PublicTrainLiveResponse:
    cleaned = _assert_valid_train_no(train_no)
    try:
        live = await rail_router.get_live_status(cleaned, service_date)
    except RailPnrNotFoundError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="train_not_found",
            title="Train Not Found",
            detail=str(exc),
        ) from exc
    except RailProviderError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="rail_provider_unavailable",
            title="Rail Status Temporarily Unavailable",
            detail="Unable to fetch live train status right now.",
        ) from exc

    entry = get_train_entry(cleaned)
    chart_info = compute_public_train_chart_time(
        train_no=cleaned,
        service_date=service_date,
        yaml_configs=yaml_configs,
    )
    train_name = entry.train_name if entry else f"Express {cleaned}"
    return PublicTrainLiveResponse(
        train_no=cleaned,
        train_name=train_name,
        from_code=entry.from_code if entry else None,
        to_code=entry.to_code if entry else None,
        service_date=live.service_date,
        current_station=live.current_station,
        delay_minutes=live.delay_minutes,
        chart_state=live.chart_state,
        chart_due_at=chart_info.chart_due_at,
    )


async def get_public_train_composition(
    *,
    train_no: str,
    service_date: date,
    rail_router: ProviderRouter,
) -> PublicTrainCompositionResponse:
    cleaned = _assert_valid_train_no(train_no)
    try:
        coaches = await rail_router.get_composition(cleaned, service_date)
    except RailPnrNotFoundError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="train_not_found",
            title="Train Not Found",
            detail=str(exc),
        ) from exc
    except RailProviderError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="rail_provider_unavailable",
            title="Rail Status Temporarily Unavailable",
            detail="Unable to fetch train composition right now.",
        ) from exc

    entry = get_train_entry(cleaned)
    return PublicTrainCompositionResponse(
        train_no=cleaned,
        train_name=entry.train_name if entry else f"Express {cleaned}",
        from_code=entry.from_code if entry else None,
        to_code=entry.to_code if entry else None,
        service_date=service_date,
        coaches=[
            PublicTrainCoachDTO(
                coach=c.coach,
                travel_class=c.travel_class,
                position=c.position,
                capacity=c.capacity,
            )
            for c in coaches
        ],
    )


def get_public_train_chart_time(
    *,
    train_no: str,
    service_date: date,
    yaml_configs: YamlConfigBundle,
) -> PublicChartTimeResponse:
    cleaned = _assert_valid_train_no(train_no)
    return compute_public_train_chart_time(
        train_no=cleaned,
        service_date=service_date,
        yaml_configs=yaml_configs,
    )


def get_public_flight_layouts(
    *,
    airline: str | None = None,
    aircraft: str | None = None,
) -> PublicFlightLayoutsResponse:
    airline_q = airline.strip().upper() if airline and airline.strip() else None
    aircraft_q = aircraft.strip().lower() if aircraft and aircraft.strip() else None

    items: list[AircraftLayoutSummaryDTO] = []
    for spec in AIRCRAFT_LAYOUTS.values():
        if (airline_q or aircraft_q) and spec.layout_ref.startswith("generic:"):
            continue
        if airline_q and spec.carrier_code.upper() != airline_q:
            continue
        if aircraft_q:
            model_part = (
                spec.layout_ref.split(":", 1)[1].lower()
                if ":" in spec.layout_ref
                else spec.layout_ref.lower()
            )
            if aircraft_q != model_part and aircraft_q not in spec.aircraft_name.lower():
                continue
        items.append(
            AircraftLayoutSummaryDTO(
                layout_ref=spec.layout_ref,
                carrier_code=spec.carrier_code,
                aircraft_name=spec.aircraft_name,
                configuration=spec.configuration,
                rows=spec.rows,
                columns=list(spec.columns),
                aisle_after_indices=list(spec.aisle_after_indices),
                exit_rows=sorted(spec.exit_rows),
                premium_rows=sorted(spec.premium_rows),
                total_seats=spec.total_seats,
            )
        )
    return PublicFlightLayoutsResponse(items=items)


async def get_public_stats(*, db: AsyncSession) -> PublicStatsResponse:
    journeys_count = int(
        (await db.execute(select(func.count(JourneyInstance.id)))).scalar_one() or 0
    )
    swaps_count = int(
        (
            await db.execute(
                select(func.count(SwapProposal.id)).where(
                    SwapProposal.status == "completed"
                )
            )
        ).scalar_one()
        or 0
    )
    return PublicStatsResponse(
        verified_journeys_count=journeys_count,
        completed_swaps_count=swaps_count,
        active_trains_catalog_count=train_catalog_count(),
        flight_layouts_count=len(AIRCRAFT_LAYOUTS),
    )
