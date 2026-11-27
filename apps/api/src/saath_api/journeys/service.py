from __future__ import annotations

import contextlib
import re
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import status
from redis.asyncio import Redis
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, authorize_resource_owner
from saath_api.auth.models import AuditLog
from saath_api.core.config import Settings, YamlConfigBundle
from saath_api.core.crypto import hash_invite_token, hash_pnr
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7
from saath_api.core.redis import SlidingWindowRateLimiter
from saath_api.journeys.chart_rules import compute_chart_due_at
from saath_api.journeys.geometry import (
    default_capacity_for_class,
    normalize_coach_class,
    seat_to_bay_and_type,
)
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.journeys.schemas import (
    AircraftLayoutSummaryDTO,
    BookingSummaryDTO,
    ChartStatusDTO,
    DeleteJourneyResponse,
    GoalConstraintsDTO,
    GoalDTO,
    JourneyCountsDTO,
    JourneyHubResponse,
    JourneyListItemDTO,
    JourneyListResponse,
    JourneySummaryDTO,
    PartySummaryDTO,
    SeatHolderOwnDTO,
    SmartSuggestionDTO,
    StandingOfferDTO,
    VerifyJourneyRequest,
    VerifyJourneyResponse,
    VerifyPartyRef,
)
from saath_api.journeys.sms_parser import (
    SmsParseError,
    parse_irctc_sms_text,
)
from saath_api.notifications.models import NotificationsOutbox
from saath_api.parties.models import Goal, Party, PartyMember
from saath_api.pricing.models import Entitlement
from saath_api.providers.base import ProviderError
from saath_api.providers.flight.bcbp import BcbpParseError, parse_bcbp
from saath_api.providers.flight.layouts import (
    AIRCRAFT_LAYOUTS,
    resolve_aircraft_layout,
    validate_and_classify_flight_seat,
)
from saath_api.providers.flight.schedule import FlightScheduleProvider
from saath_api.providers.rail.protocol import (
    BookingDTO,
    PassengerDTO,
    RailPnrFlushedError,
    RailPnrInvalidError,
    RailPnrNotFoundError,
    RailProviderError,
)
from saath_api.providers.rail.router import ProviderRouter

IST = ZoneInfo("Asia/Kolkata")
_FLIGHT_NO_RE = re.compile(r"^([A-Z0-9]{2,3}?)\s*-?\s*([0-9]{1,4}[A-Z]?)$")


def _purge_after(arrival_at: datetime | None, service_date: date) -> datetime:
    if arrival_at is not None:
        return arrival_at + timedelta(days=30)
    fallback = datetime.combine(service_date + timedelta(days=1), time(0, 0), tzinfo=IST)
    return (fallback + timedelta(days=30)).astimezone(UTC)


def _chart_dto(ji: JourneyInstance) -> ChartStatusDTO:
    now = datetime.now(UTC)
    seconds: int | None = None
    if ji.chart_due_at is not None and ji.chart_state == "pending":
        diff = int((ji.chart_due_at - now).total_seconds())
        seconds = max(0, diff)
    state: Literal["pending", "first", "final", "na"] = ji.chart_state  # type: ignore[assignment]
    return ChartStatusDTO(
        state=state,
        chart_due_at=ji.chart_due_at,
        seconds_until_chart=seconds,
    )


def _seat_holder_dto(sh: SeatHolder) -> SeatHolderOwnDTO:
    return SeatHolderOwnDTO(
        id=sh.id,
        pax_seq=sh.pax_seq,
        booking_status=sh.booking_status,
        current_status=sh.current_status,
        coach=sh.coach,
        seat_no=sh.seat_no,
        seat_type=sh.seat_type,
        bay=sh.bay,
        age_band=sh.age_band,
        gender_band=sh.gender_band,
        linked_user_id=sh.linked_user_id,
    )


def _goal_dto(goal: Goal | None) -> GoalDTO | None:
    if goal is None:
        return None
    return GoalDTO(
        id=goal.id,
        party_id=goal.party_id,
        goal_type=goal.goal_type,
        movers=list(goal.movers),
        preferred_seats=list(goal.preferred_seats),
        constraints=GoalConstraintsDTO.model_validate(goal.constraints or {}),
        standing_offer=(
            StandingOfferDTO.model_validate(goal.standing_offer) if goal.standing_offer else None
        ),
        active=goal.active,
        updated_at=goal.updated_at,
    )


def _journey_summary_dto(ji: JourneyInstance) -> JourneySummaryDTO:
    return JourneySummaryDTO(
        id=ji.id,
        mode=ji.mode,
        carrier_code=ji.carrier_code,
        service_no=ji.service_no,
        service_date=ji.service_date,
        departure_at=ji.departure_at,
        arrival_at=ji.arrival_at,
        chart_due_at=ji.chart_due_at,
        chart_state=ji.chart_state,
        layout_ref=ji.layout_ref,
        match_version=ji.match_version,
    )


def _booking_summary_dto(booking: Booking) -> BookingSummaryDTO:
    return BookingSummaryDTO(
        id=booking.id,
        travel_class=booking.travel_class,
        from_code=booking.from_code,
        to_code=booking.to_code,
        trust_tier=booking.trust_tier,
        claim_conflict_flagged=booking.claim_conflict_flagged,
        last_verified_at=booking.last_verified_at,
    )


def _is_actor_booking_owner(actor: Actor, booking: Booking) -> bool:
    if actor.kind == "admin":
        return True
    if actor.kind == "user" and actor.user_id is not None:
        return booking.owner_user_id == actor.user_id
    if actor.kind == "anon" and actor.anon_id is not None:
        return booking.owner_anon_id == actor.anon_id
    return False


def _is_actor_party_leader(actor: Actor, party: Party) -> bool:
    if actor.kind == "admin":
        return True
    if actor.kind == "user" and actor.user_id is not None:
        return party.leader_user_id == actor.user_id
    if actor.kind == "anon" and actor.anon_id is not None:
        return party.leader_anon_id == actor.anon_id
    return False


def _build_smart_suggestions(
    members: list[SeatHolderOwnDTO],
    mode: str,
) -> list[SmartSuggestionDTO]:
    suggestions: list[SmartSuggestionDTO] = []
    if mode == "train":
        seniors_on_upper = [
            m.id for m in members if m.age_band == "senior" and m.seat_type in ("UB", "SU")
        ]
        if seniors_on_upper:
            suggestions.append(
                SmartSuggestionDTO(
                    code="senior_upper_to_lower",
                    title_key="suggestionSeniorUpper",
                    seat_holder_ids=seniors_on_upper,
                    recommended_goal_type="lower",
                )
            )
        coaches = {m.coach for m in members if m.coach}
        if len(coaches) > 1:
            suggestions.append(
                SmartSuggestionDTO(
                    code="split_coaches",
                    title_key="suggestionSplitCoaches",
                    seat_holder_ids=[m.id for m in members],
                    recommended_goal_type="together",
                )
            )
        elif len(members) >= 2:
            bays = {(m.coach, m.bay) for m in members if m.coach and m.bay}
            if len(bays) > 1:
                suggestions.append(
                    SmartSuggestionDTO(
                        code="split_bays",
                        title_key="suggestionSplitBays",
                        seat_holder_ids=[m.id for m in members],
                        recommended_goal_type="together",
                    )
                )
    elif mode == "flight" and len(members) >= 2:
        suggestions.append(
            SmartSuggestionDTO(
                code="flight_sit_together",
                title_key="suggestionFlightTogether",
                seat_holder_ids=[m.id for m in members],
                recommended_goal_type="together",
            )
        )
    return suggestions


async def resolve_party_entitlement_limits(
    *,
    db: AsyncSession,
    yaml_configs: YamlConfigBundle,
    party: Party,
    actor: Actor | None = None,
) -> tuple[int, bool]:
    """Return (max_party_members, has_organiser_pass) for a party."""
    free_limit = yaml_configs.plans.plans["free_passenger"].max_party_members
    candidate_user_ids: list[UUID] = []
    if party.leader_user_id is not None:
        candidate_user_ids.append(party.leader_user_id)
    if actor is not None and actor.user_id is not None and actor.user_id not in candidate_user_ids:
        candidate_user_ids.append(actor.user_id)

    if not candidate_user_ids:
        return free_limit, False

    now = datetime.now(UTC)
    stmt = select(Entitlement).where(
        Entitlement.user_id.in_(candidate_user_ids),
        Entitlement.status == "active",
        Entitlement.valid_until.is_(None) | (Entitlement.valid_until > now),
    )
    res = await db.execute(stmt)
    entitlements = list(res.scalars().all())
    for ent in entitlements:
        if ent.valid_until is not None and ent.valid_until <= now:
            continue
        if ent.plan_code == "b2b_partner":
            plan = yaml_configs.plans.plans.get("b2b_partner")
            return (plan.max_party_members if plan else 50), True
        if ent.plan_code == "group_organiser_pass" and (
            ent.scope_party_id == party.id
            or ent.scope_journey_instance_id == party.journey_instance_id
        ):
            plan = yaml_configs.plans.plans.get("group_organiser_pass")
            return (plan.max_party_members if plan else 50), True

    return free_limit, False


async def _enforce_verify_rate_limit(
    *,
    redis: Redis,
    yaml_configs: YamlConfigBundle,
    actor: Actor,
    client_ip: str,
) -> None:
    limiter = SlidingWindowRateLimiter(redis)
    limits = yaml_configs.rate_limits.verify

    ip_ok, ip_retry = await limiter.allow(
        f"rl:verify:ip:{client_ip}",
        limit=limits.per_ip_per_minute,
        window_seconds=60,
    )
    if not ip_ok:
        raise ProblemDetailError(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="rate_limited",
            title="Too Many Requests",
            detail="Lots of people checking right now. Give us 30 seconds.",
            headers={"Retry-After": str(ip_retry)},
        )

    actor_key = str(actor.user_id) if actor.user_id else (actor.anon_id or "anon")
    actor_ok, actor_retry = await limiter.allow(
        f"rl:verify:actor:{actor_key}",
        limit=limits.per_user_per_day,
        window_seconds=86400,
    )
    if not actor_ok:
        raise ProblemDetailError(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="rate_limited",
            title="Daily Verification Limit Reached",
            detail="You have reached the daily journey verification limit.",
            headers={"Retry-After": str(actor_retry)},
        )


async def _upsert_journey_instance(
    *,
    db: AsyncSession,
    mode: Literal["train", "flight", "bus"],
    carrier_code: str,
    service_no: str,
    service_date: date,
    departure_at: datetime | None,
    arrival_at: datetime | None,
    chart_due_at: datetime | None,
    chart_state: str,
    layout_ref: str | None,
) -> JourneyInstance:
    stmt = select(JourneyInstance).where(
        JourneyInstance.mode == mode,
        JourneyInstance.carrier_code == carrier_code,
        JourneyInstance.service_no == service_no,
        JourneyInstance.service_date == service_date,
    )
    res = await db.execute(stmt)
    ji = res.scalar_one_or_none()
    if ji is None:
        ji = JourneyInstance(
            id=uuid7(),
            mode=mode,
            carrier_code=carrier_code,
            service_no=service_no,
            service_date=service_date,
            departure_at=departure_at,
            arrival_at=arrival_at,
            chart_due_at=chart_due_at,
            chart_state=chart_state,
            layout_ref=layout_ref,
            match_version=0,
        )
        db.add(ji)
        await db.flush()
    else:
        if departure_at is not None and ji.departure_at is None:
            ji.departure_at = departure_at
        if arrival_at is not None and ji.arrival_at is None:
            ji.arrival_at = arrival_at
        if chart_due_at is not None and ji.chart_due_at is None:
            ji.chart_due_at = chart_due_at
        if layout_ref is not None and ji.layout_ref is None:
            ji.layout_ref = layout_ref
        if chart_state in ("first", "final") and ji.chart_state == "pending":
            ji.chart_state = chart_state
    return ji


async def _ensure_party_for_booking(
    *,
    db: AsyncSession,
    actor: Actor,
    journey_instance_id: UUID,
    seat_holders: list[SeatHolder],
) -> Party:
    sh_ids = [sh.id for sh in seat_holders]
    if sh_ids:
        existing_pm = await db.execute(
            select(PartyMember).where(PartyMember.seat_holder_id.in_(sh_ids))
        )
        pm_rows = list(existing_pm.scalars().all())
        if pm_rows:
            party_res = await db.execute(select(Party).where(Party.id == pm_rows[0].party_id))
            existing_party = party_res.scalar_one_or_none()
            if existing_party is not None:
                existing_sh_ids = {pm.seat_holder_id for pm in pm_rows}
                for sh in seat_holders:
                    if sh.id not in existing_sh_ids:
                        db.add(PartyMember(party_id=existing_party.id, seat_holder_id=sh.id))
                await db.flush()
                return existing_party

    party = Party(
        id=uuid7(),
        journey_instance_id=journey_instance_id,
        leader_user_id=actor.user_id if actor.kind == "user" else None,
        leader_anon_id=actor.anon_id if actor.kind == "anon" else None,
    )
    db.add(party)
    await db.flush()
    for sh in seat_holders:
        db.add(PartyMember(party_id=party.id, seat_holder_id=sh.id))
    await db.flush()
    return party


def _booking_dto_from_sms(sms_text: str) -> BookingDTO:
    try:
        parsed = parse_irctc_sms_text(sms_text)
    except SmsParseError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="sms_parse_failed",
            title="Could Not Read IRCTC SMS",
            detail=str(exc),
        ) from exc

    pax_dtos: list[PassengerDTO] = []
    for p in parsed.passengers:
        pax_dtos.append(
            PassengerDTO(
                pax_seq=p.pax_seq,
                booking_status=p.booking_status,
                current_status=p.current_status,
                coach=p.coach,
                seat_no=p.seat_no,
                seat_type=p.seat_type,
                bay=p.bay,
                age_band="unknown",
                gender_band="U",
            )
        )
    return BookingDTO(
        provider="sms_parser",
        train_no=parsed.train_no,
        train_name=f"Train {parsed.train_no}",
        service_date=parsed.service_date,
        travel_class=parsed.travel_class,
        from_code=parsed.from_code,
        to_code=parsed.to_code,
        from_seq=parsed.from_seq,
        to_seq=parsed.to_seq,
        departure_at=parsed.departure_at,
        arrival_at=parsed.arrival_at,
        chart_state="pending",
        passengers=pax_dtos,
    )


async def _verify_train(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    rail_router: ProviderRouter,
    actor: Actor,
    req: VerifyJourneyRequest,
    simulate_provider_failure: bool,
) -> tuple[JourneyInstance, Booking, list[SeatHolder], Party]:
    if req.pnr:
        if simulate_provider_failure and not settings.is_production:
            raise ProblemDetailError(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                code="rail_provider_unavailable",
                title="Rail Provider Unavailable",
                detail=(
                    "Rail verification provider is temporarily unavailable. "
                    "Try pasting your IRCTC SMS."
                ),
            )
        raw_pnr = req.pnr.strip()
        trust_tier = "verified_provider"
        try:
            dto = await rail_router.get_pnr(raw_pnr)
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
                code="pnr_flushed_or_cancelled",
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
                title="Rail Provider Unavailable",
                detail=(
                    "Rail verification provider is temporarily unavailable. "
                    "Try pasting your IRCTC SMS."
                ),
            ) from exc
    elif req.sms_text:
        try:
            parsed_sms = parse_irctc_sms_text(req.sms_text)
        except SmsParseError as exc:
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="sms_parse_failed",
                title="Could Not Read IRCTC SMS",
                detail=str(exc),
            ) from exc
        raw_pnr = parsed_sms.pnr
        trust_tier = "verified_doc"
        dto = _booking_dto_from_sms(req.sms_text)
    else:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="missing_train_credentials",
            title="PNR or SMS Required",
            detail="Provide a 10-digit PNR or paste your IRCTC SMS.",
        )

    travel_class = normalize_coach_class(dto.travel_class)
    cap = default_capacity_for_class(travel_class)
    layout_ref = f"IR:{travel_class}:{cap}"
    chart_due = compute_chart_due_at(
        dto.departure_at,
        train_no=dto.train_no,
        rules=yaml_configs.chart_rules,
    )

    ji = await _upsert_journey_instance(
        db=db,
        mode="train",
        carrier_code="IR",
        service_no=dto.train_no.strip().upper(),
        service_date=dto.service_date,
        departure_at=dto.departure_at,
        arrival_at=dto.arrival_at,
        chart_due_at=chart_due,
        chart_state=dto.chart_state,
        layout_ref=layout_ref,
    )

    pnr_digest = hash_pnr(raw_pnr, settings.pnr_pepper)
    existing_res = await db.execute(
        select(Booking).where(
            Booking.journey_instance_id == ji.id,
            Booking.pnr_hash == pnr_digest,
            Booking.trust_tier != "verified_bcbp",
        )
    )
    booking = existing_res.scalar_one_or_none()
    now = datetime.now(UTC)

    if booking is not None:
        if not _is_actor_booking_owner(actor, booking):
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="pnr_already_claimed",
                title="PNR Already Verified",
                detail=(
                    "This PNR is already verified on another account. "
                    "Ask the group organiser for an invite link."
                ),
            )
        booking.last_verified_at = now
        booking.travel_class = travel_class
        if trust_tier == "verified_provider":
            booking.trust_tier = trust_tier
        sh_res = await db.execute(
            select(SeatHolder)
            .where(SeatHolder.booking_id == booking.id)
            .order_by(SeatHolder.pax_seq)
        )
        seat_holders = list(sh_res.scalars().all())
        party = await _ensure_party_for_booking(
            db=db, actor=actor, journey_instance_id=ji.id, seat_holders=seat_holders
        )
        return ji, booking, seat_holders, party

    booking = Booking(
        id=uuid7(),
        journey_instance_id=ji.id,
        owner_user_id=actor.user_id if actor.kind == "user" else None,
        owner_anon_id=actor.anon_id if actor.kind == "anon" else None,
        pnr_hash=pnr_digest,
        travel_class=travel_class,
        from_code=dto.from_code,
        to_code=dto.to_code,
        from_seq=dto.from_seq,
        to_seq=dto.to_seq,
        trust_tier=trust_tier,
        claim_conflict_flagged=False,
        last_verified_at=now,
        purge_after=_purge_after(dto.arrival_at, dto.service_date),
    )
    db.add(booking)
    await db.flush()

    seat_holders = []
    for p in dto.passengers:
        bay = p.bay
        seat_type = p.seat_type
        if p.seat_no and p.seat_no.isdigit() and (bay is None or seat_type is None):
            with contextlib.suppress(ValueError):
                bay, seat_type, _ = seat_to_bay_and_type(travel_class, int(p.seat_no))
        sh = SeatHolder(
            id=uuid7(),
            booking_id=booking.id,
            pax_seq=p.pax_seq,
            booking_status=p.booking_status,
            current_status=p.current_status,
            coach=p.coach,
            seat_no=p.seat_no,
            seat_type=seat_type,
            bay=bay,
            age_band=p.age_band,
            gender_band=p.gender_band,
            linked_user_id=actor.user_id if (actor.kind == "user" and p.pax_seq == 1) else None,
        )
        db.add(sh)
        seat_holders.append(sh)

    await db.flush()
    party = await _ensure_party_for_booking(
        db=db, actor=actor, journey_instance_id=ji.id, seat_holders=seat_holders
    )
    return ji, booking, seat_holders, party


async def _verify_flight(
    *,
    settings: Settings,
    db: AsyncSession,
    flight_provider: FlightScheduleProvider,
    actor: Actor,
    req: VerifyJourneyRequest,
    simulate_provider_failure: bool,
) -> tuple[JourneyInstance, Booking, list[SeatHolder], Party]:
    if simulate_provider_failure and not settings.is_production and req.bcbp:
        raise ProblemDetailError(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="flight_provider_unavailable",
            title="Flight Schedule Unavailable",
            detail="Flight schedule provider is temporarily unavailable.",
        )

    now = datetime.now(UTC)
    if req.bcbp:
        try:
            parsed_bcbp = parse_bcbp(req.bcbp, pnr_pepper=settings.pnr_pepper)
        except BcbpParseError as exc:
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code=exc.code,
                title="Invalid Boarding Pass",
                detail=str(exc),
            ) from exc

        if req.leg_index >= len(parsed_bcbp.legs):
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_leg_index",
                title="Invalid Flight Segment",
                detail=f"Boarding pass only has {len(parsed_bcbp.legs)} leg(s).",
            )

        leg = parsed_bcbp.legs[req.leg_index]
        # Immediately drop passenger_name_hint after parsing (never stored/logged)
        try:
            schedule = await flight_provider.lookup_flight(
                carrier_code=leg.carrier_code,
                service_no=leg.flight_no,
                service_date=leg.service_date,
                from_code=leg.from_iata,
                to_code=leg.to_iata,
            )
        except ProviderError as exc:
            raise ProblemDetailError(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                code="flight_provider_unavailable",
                title="Flight Schedule Unavailable",
                detail="Flight schedule provider is temporarily unavailable.",
            ) from exc
        resolved_layout = resolve_aircraft_layout(
            req.layout_ref or schedule.layout_ref, leg.carrier_code
        )
        try:
            classified = validate_and_classify_flight_seat(
                resolved_layout.layout_ref, leg.seat_no, carrier_code=leg.carrier_code
            )
        except ValueError as exc:
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_seat_for_layout",
                title="Invalid Seat For Aircraft",
                detail=str(exc),
            ) from exc

        ji = await _upsert_journey_instance(
            db=db,
            mode="flight",
            carrier_code=schedule.carrier_code,
            service_no=schedule.service_no,
            service_date=schedule.service_date,
            departure_at=schedule.departure_at,
            arrival_at=schedule.arrival_at,
            chart_due_at=None,
            chart_state="na",
            layout_ref=resolved_layout.layout_ref,
        )

        # Duplicate active claim check on (journey_instance_id, pnr_hash, seat_no)
        dup_stmt = (
            select(Booking, SeatHolder)
            .join(SeatHolder, SeatHolder.booking_id == Booking.id)
            .where(
                Booking.journey_instance_id == ji.id,
                Booking.pnr_hash == leg.pnr_hash,
                SeatHolder.seat_no == classified.seat_no,
            )
        )
        dup_res = await db.execute(dup_stmt)
        existing_pair = dup_res.first()
        if existing_pair is not None:
            existing_booking, existing_sh = existing_pair
            if _is_actor_booking_owner(actor, existing_booking):
                existing_booking.last_verified_at = now
                party = await _ensure_party_for_booking(
                    db=db, actor=actor, journey_instance_id=ji.id, seat_holders=[existing_sh]
                )
                return ji, existing_booking, [existing_sh], party

            existing_booking.claim_conflict_flagged = True
            actor_label = f"user:{actor.user_id}" if actor.user_id else (actor.anon_id or "anon")
            db.add(
                AuditLog(
                    actor=actor_label,
                    action="flight.duplicate_claim_flagged",
                    resource=f"journey:{ji.id}",
                    meta={"seat_no": classified.seat_no, "booking_id": str(existing_booking.id)},
                )
            )
            await db.commit()
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="duplicate_seat_claim",
                title="Seat Already Claimed",
                detail="This boarding pass seat is already verified by another traveller.",
            )

        booking = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=actor.user_id if actor.kind == "user" else None,
            owner_anon_id=actor.anon_id if actor.kind == "anon" else None,
            pnr_hash=leg.pnr_hash,
            travel_class=leg.travel_class,
            from_code=leg.from_iata,
            to_code=leg.to_iata,
            trust_tier="verified_bcbp",
            claim_conflict_flagged=False,
            last_verified_at=now,
            purge_after=_purge_after(schedule.arrival_at, schedule.service_date),
        )
        db.add(booking)
        await db.flush()

        sh = SeatHolder(
            id=uuid7(),
            booking_id=booking.id,
            pax_seq=1,
            booking_status="OK",
            current_status="OK",
            coach="CABIN",
            seat_no=classified.seat_no,
            seat_type=classified.seat_type,
            bay=classified.row,
            age_band="unknown",
            gender_band="U",
            linked_user_id=actor.user_id if actor.kind == "user" else None,
        )
        db.add(sh)
        await db.flush()
        party = await _ensure_party_for_booking(
            db=db, actor=actor, journey_instance_id=ji.id, seat_holders=[sh]
        )
        return ji, booking, [sh], party

    if req.declared is not None:
        raw_fno = req.declared.flight_no.strip().upper().replace(" ", "")
        match = _FLIGHT_NO_RE.fullmatch(raw_fno)
        if not match:
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_flight_no",
                title="Invalid Flight Number",
                detail="Enter a valid flight number like 6E215 or AI804.",
            )
        carrier = match.group(1)
        svc_no = (
            f"{carrier}{int(match.group(2))}"
            if match.group(2).isdigit()
            else f"{carrier}{match.group(2)}"
        )

        try:
            schedule = await flight_provider.lookup_flight(
                carrier_code=carrier,
                service_no=svc_no,
                service_date=req.declared.date,
            )
        except ProviderError as exc:
            raise ProblemDetailError(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                code="flight_provider_unavailable",
                title="Flight Schedule Unavailable",
                detail="Flight schedule provider is temporarily unavailable.",
            ) from exc
        resolved_layout = resolve_aircraft_layout(
            req.declared.layout_ref or req.layout_ref or schedule.layout_ref, carrier
        )
        try:
            classified = validate_and_classify_flight_seat(
                resolved_layout.layout_ref, req.declared.seat, carrier_code=carrier
            )
        except ValueError as exc:
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_seat_for_layout",
                title="Invalid Seat For Aircraft",
                detail=str(exc),
            ) from exc

        ji = await _upsert_journey_instance(
            db=db,
            mode="flight",
            carrier_code=carrier,
            service_no=svc_no,
            service_date=req.declared.date,
            departure_at=schedule.departure_at,
            arrival_at=schedule.arrival_at,
            chart_due_at=None,
            chart_state="na",
            layout_ref=resolved_layout.layout_ref,
        )
        actor_key = str(actor.user_id) if actor.user_id else (actor.anon_id or "anon")
        declared_pnr_hash = hash_pnr(
            f"declared:{actor_key}:{carrier}:{svc_no}:{req.declared.date.isoformat()}:{classified.seat_no}",
            settings.pnr_pepper,
        )
        existing_res = await db.execute(
            select(Booking).where(
                Booking.journey_instance_id == ji.id,
                Booking.pnr_hash == declared_pnr_hash,
            )
        )
        declared_booking = existing_res.scalar_one_or_none()
        if declared_booking is not None:
            sh_res = await db.execute(
                select(SeatHolder).where(SeatHolder.booking_id == declared_booking.id)
            )
            shs = list(sh_res.scalars().all())
            party = await _ensure_party_for_booking(
                db=db, actor=actor, journey_instance_id=ji.id, seat_holders=shs
            )
            return ji, declared_booking, shs, party

        booking = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=actor.user_id if actor.kind == "user" else None,
            owner_anon_id=actor.anon_id if actor.kind == "anon" else None,
            pnr_hash=declared_pnr_hash,
            travel_class="Y",
            from_code=schedule.from_code,
            to_code=schedule.to_code,
            trust_tier="declared",
            claim_conflict_flagged=False,
            last_verified_at=now,
            purge_after=_purge_after(schedule.arrival_at, schedule.service_date),
        )
        db.add(booking)
        await db.flush()

        sh = SeatHolder(
            id=uuid7(),
            booking_id=booking.id,
            pax_seq=1,
            booking_status="DECLARED",
            current_status="DECLARED",
            coach="CABIN",
            seat_no=classified.seat_no,
            seat_type=classified.seat_type,
            bay=classified.row,
            age_band="unknown",
            gender_band="U",
            linked_user_id=actor.user_id if actor.kind == "user" else None,
        )
        db.add(sh)
        await db.flush()
        party = await _ensure_party_for_booking(
            db=db, actor=actor, journey_instance_id=ji.id, seat_holders=[sh]
        )
        return ji, booking, [sh], party

    raise ProblemDetailError(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        code="missing_flight_credentials",
        title="Boarding Pass or Flight Details Required",
        detail="Scan a boarding pass barcode or enter your flight details.",
    )


async def verify_and_persist_booking(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    redis: Redis,
    rail_router: ProviderRouter,
    flight_provider: FlightScheduleProvider,
    actor: Actor,
    req: VerifyJourneyRequest,
    client_ip: str,
    simulate_provider_failure: bool = False,
) -> tuple[JourneyInstance, Booking, list[SeatHolder], Party]:
    if req.mode == "bus":
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="bus_coming_soon",
            title="Bus Mode Coming Soon",
            detail="Bus seat swaps are coming in v1.1.",
        )

    await _enforce_verify_rate_limit(
        redis=redis, yaml_configs=yaml_configs, actor=actor, client_ip=client_ip
    )

    if req.mode == "train":
        return await _verify_train(
            settings=settings,
            yaml_configs=yaml_configs,
            db=db,
            rail_router=rail_router,
            actor=actor,
            req=req,
            simulate_provider_failure=simulate_provider_failure,
        )

    return await _verify_flight(
        settings=settings,
        db=db,
        flight_provider=flight_provider,
        actor=actor,
        req=req,
        simulate_provider_failure=simulate_provider_failure,
    )


async def verify_journey(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    redis: Redis,
    rail_router: ProviderRouter,
    flight_provider: FlightScheduleProvider,
    actor: Actor,
    req: VerifyJourneyRequest,
    client_ip: str,
    simulate_provider_failure: bool = False,
    arq_pool: Any | None = None,
) -> VerifyJourneyResponse:
    ji, booking, seat_holders, party = await verify_and_persist_booking(
        settings=settings,
        yaml_configs=yaml_configs,
        db=db,
        redis=redis,
        rail_router=rail_router,
        flight_provider=flight_provider,
        actor=actor,
        req=req,
        client_ip=client_ip,
        simulate_provider_failure=simulate_provider_failure,
    )

    db.add(
        NotificationsOutbox(
            user_id=actor.user_id,
            event="JourneyVerified",
            payload={
                "journey_instance_id": str(ji.id),
                "booking_id": str(booking.id),
                "party_id": str(party.id),
                "mode": ji.mode,
                "service_no": ji.service_no,
            },
            idempotency_key=f"journey_verified:{booking.id}:{uuid7().hex[:12]}",
        )
    )

    now = datetime.now(UTC)
    if req.invite_token:
        from saath_api.public.models import SeatInvite

        invite_hash = hash_invite_token(req.invite_token, settings.invite_token_secret)
        invite_res = await db.execute(
            select(SeatInvite)
            .where(
                SeatInvite.token_hash == invite_hash,
                SeatInvite.journey_instance_id == ji.id,
                SeatInvite.expires_at > now,
            )
            .with_for_update()
        )
        invite_row = invite_res.scalar_one_or_none()
        if invite_row is not None:
            invite_row.conversions_count += 1
            actor_label = (
                f"user:{actor.user_id}"
                if actor.kind == "user" and actor.user_id is not None
                else f"anon:{actor.anon_id or 'unknown'}"
            )
            db.add(
                AuditLog(
                    actor=actor_label,
                    action="seat_invite.converted",
                    resource=f"seat_invite:{invite_row.id}",
                    meta={
                        "journey_instance_id": str(ji.id),
                        "booking_id": str(booking.id),
                        "open_to_help": req.open_to_help,
                    },
                )
            )

    if req.open_to_help and seat_holders:
        await db.execute(
            update(Goal)
            .where(Goal.party_id == party.id, Goal.active.is_(True))
            .values(active=False, updated_at=now)
        )
        db.add(
            Goal(
                id=uuid7(),
                party_id=party.id,
                goal_type="open_to_help",
                movers=[sh.id for sh in seat_holders],
                preferred_seats=[],
                constraints={
                    "women_only": False,
                    "no_middle": False,
                    "same_coach_only": False,
                    "verified_only": False,
                },
                standing_offer={"give_to": "anyone"},
                active=True,
                updated_at=now,
            )
        )
        ji.match_version += 1

    await db.commit()
    await db.refresh(ji)
    await db.refresh(booking)

    from saath_api.matching.service import schedule_or_run_match_recompute

    await schedule_or_run_match_recompute(
        db=db,
        redis=redis,
        journey_instance_id=ji.id,
        arq_pool=arq_pool,
        settings=settings,
    )

    return VerifyJourneyResponse(
        journey=_journey_summary_dto(ji),
        booking=_booking_summary_dto(booking),
        seat_holders=[_seat_holder_dto(sh) for sh in seat_holders],
        party_id=party.id,
        party=VerifyPartyRef(id=party.id),
        trust_tier=booking.trust_tier,
        chart=_chart_dto(ji),
    )


async def _build_journey_hub(
    *,
    db: AsyncSession,
    yaml_configs: YamlConfigBundle,
    actor: Actor,
    ji: JourneyInstance,
    booking: Booking,
    party: Party,
) -> JourneyHubResponse:
    members_res = await db.execute(
        select(SeatHolder)
        .join(PartyMember, PartyMember.seat_holder_id == SeatHolder.id)
        .where(PartyMember.party_id == party.id)
        .order_by(SeatHolder.pax_seq, SeatHolder.id)
    )
    members = [_seat_holder_dto(sh) for sh in members_res.scalars().all()]

    goal_res = await db.execute(
        select(Goal).where(Goal.party_id == party.id, Goal.active.is_(True))
    )
    goal_row = goal_res.scalar_one_or_none()

    max_members, has_pass = await resolve_party_entitlement_limits(
        db=db, yaml_configs=yaml_configs, party=party, actor=actor
    )

    total_active_res = await db.execute(
        select(func.count(SeatHolder.id))
        .join(Booking, Booking.id == SeatHolder.booking_id)
        .where(Booking.journey_instance_id == ji.id)
    )
    journey_active_count = int(total_active_res.scalar_one() or 0)

    own_coaches = {m.coach for m in members if m.coach}
    coach_active_count = journey_active_count
    if own_coaches:
        coach_res = await db.execute(
            select(func.count(SeatHolder.id))
            .join(Booking, Booking.id == SeatHolder.booking_id)
            .where(
                Booking.journey_instance_id == ji.id,
                SeatHolder.coach.in_(own_coaches),
            )
        )
        coach_active_count = int(coach_res.scalar_one() or 0)

    own_res = await db.execute(
        select(SeatHolder)
        .where(SeatHolder.booking_id == booking.id)
        .order_by(SeatHolder.pax_seq, SeatHolder.id)
    )
    own_holders = [_seat_holder_dto(sh) for sh in own_res.scalars().all()]

    return JourneyHubResponse(
        journey=_journey_summary_dto(ji),
        chart=_chart_dto(ji),
        booking=_booking_summary_dto(booking),
        seat_holders=own_holders or members,
        party=PartySummaryDTO(
            id=party.id,
            leader_is_me=_is_actor_party_leader(actor, party),
            members=members,
            member_count=len(members),
            max_party_members=max_members,
            has_organiser_pass=has_pass,
            invite_expires_at=party.invite_expires_at,
        ),
        goal=_goal_dto(goal_row),
        suggestions=_build_smart_suggestions(members, ji.mode),
        counts=JourneyCountsDTO(
            coach_active_count=coach_active_count,
            journey_active_count=journey_active_count,
        ),
    )


async def _load_actor_journey_context(
    *,
    db: AsyncSession,
    actor: Actor,
    journey_id: UUID,
) -> tuple[JourneyInstance, Booking, Party]:
    ji_res = await db.execute(select(JourneyInstance).where(JourneyInstance.id == journey_id))
    ji = ji_res.scalar_one_or_none()
    if ji is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="journey_not_found",
            title="Journey Not Found",
            detail="Journey was not found.",
        )

    booking_stmt = select(Booking).where(Booking.journey_instance_id == journey_id)
    if actor.kind == "user" and actor.user_id is not None:
        booking_stmt = booking_stmt.where(Booking.owner_user_id == actor.user_id)
    elif actor.kind == "anon" and actor.anon_id is not None:
        booking_stmt = booking_stmt.where(Booking.owner_anon_id == actor.anon_id)
    elif actor.kind != "admin":
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="You do not have access to this journey.",
        )

    booking_res = await db.execute(booking_stmt.order_by(Booking.created_at.asc()))
    booking = booking_res.scalars().first()
    if booking is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="You do not have a verified booking on this journey.",
        )

    party_res = await db.execute(
        select(Party)
        .join(PartyMember, PartyMember.party_id == Party.id)
        .join(SeatHolder, SeatHolder.id == PartyMember.seat_holder_id)
        .where(SeatHolder.booking_id == booking.id)
    )
    party = party_res.scalars().first()
    if party is None:
        sh_res = await db.execute(select(SeatHolder).where(SeatHolder.booking_id == booking.id))
        shs = list(sh_res.scalars().all())
        party = await _ensure_party_for_booking(
            db=db, actor=actor, journey_instance_id=ji.id, seat_holders=shs
        )
    return ji, booking, party


async def list_journeys(
    *,
    db: AsyncSession,
    actor: Actor,
) -> JourneyListResponse:
    stmt = (
        select(JourneyInstance, Booking)
        .join(Booking, Booking.journey_instance_id == JourneyInstance.id)
        .order_by(JourneyInstance.departure_at.asc().nullslast(), Booking.created_at.desc())
    )
    if actor.kind == "user" and actor.user_id is not None:
        stmt = stmt.where(Booking.owner_user_id == actor.user_id)
    elif actor.kind == "anon" and actor.anon_id is not None:
        stmt = stmt.where(Booking.owner_anon_id == actor.anon_id)
    else:
        return JourneyListResponse(items=[])

    rows = (await db.execute(stmt)).all()
    items: list[JourneyListItemDTO] = []
    seen_journeys: set[UUID] = set()
    for ji, booking in rows:
        if ji.id in seen_journeys:
            continue
        seen_journeys.add(ji.id)

        sh_res = await db.execute(
            select(SeatHolder)
            .where(SeatHolder.booking_id == booking.id)
            .order_by(SeatHolder.pax_seq)
        )
        own_shs = list(sh_res.scalars().all())

        party_res = await db.execute(
            select(Party)
            .join(PartyMember, PartyMember.party_id == Party.id)
            .join(SeatHolder, SeatHolder.id == PartyMember.seat_holder_id)
            .where(SeatHolder.booking_id == booking.id)
        )
        party = party_res.scalars().first()
        if party is None:
            continue

        count_res = await db.execute(
            select(func.count(PartyMember.seat_holder_id)).where(PartyMember.party_id == party.id)
        )
        member_count = int(count_res.scalar_one() or len(own_shs))

        goal_res = await db.execute(
            select(Goal).where(Goal.party_id == party.id, Goal.active.is_(True))
        )
        goal_row = goal_res.scalar_one_or_none()

        items.append(
            JourneyListItemDTO(
                journey=_journey_summary_dto(ji),
                booking=_booking_summary_dto(booking),
                party_id=party.id,
                member_count=member_count,
                seat_holders=[_seat_holder_dto(sh) for sh in own_shs],
                goal=_goal_dto(goal_row),
            )
        )
    return JourneyListResponse(items=items)


async def get_journey_hub(
    *,
    db: AsyncSession,
    yaml_configs: YamlConfigBundle,
    actor: Actor,
    journey_id: UUID,
) -> JourneyHubResponse:
    ji, booking, party = await _load_actor_journey_context(
        db=db, actor=actor, journey_id=journey_id
    )
    return await _build_journey_hub(
        db=db, yaml_configs=yaml_configs, actor=actor, ji=ji, booking=booking, party=party
    )


async def reverify_journey(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    redis: Redis | None = None,
    actor: Actor,
    journey_id: UUID,
    simulate_chart_change: bool = False,
) -> JourneyHubResponse:
    ji, booking, party = await _load_actor_journey_context(
        db=db, actor=actor, journey_id=journey_id
    )
    authorize_resource_owner(
        actor,
        "journey.reverify",
        owner_user_id=booking.owner_user_id,
        owner_anon_id=booking.owner_anon_id,
    )

    if redis is not None:
        actor_key = str(actor.user_id) if actor.user_id else (actor.anon_id or "anon")
        limiter = SlidingWindowRateLimiter(redis)
        allowed, retry_after = await limiter.allow(
            f"rl:reverify:{actor_key}:{journey_id}",
            limit=10,
            window_seconds=60,
        )
        if not allowed:
            raise ProblemDetailError(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                code="rate_limited",
                title="Too Many Reverify Requests",
                detail="Please wait a moment before refreshing this journey again.",
                headers={"Retry-After": str(retry_after)},
            )

    now = datetime.now(UTC)
    booking.last_verified_at = now
    berth_changes: list[tuple[SeatHolder, str | None, str | None, UUID | None]] = []
    new_chart_state: str | None = None

    if simulate_chart_change and not settings.is_production:
        sh_res = await db.execute(
            select(SeatHolder)
            .where(SeatHolder.booking_id == booking.id)
            .order_by(SeatHolder.pax_seq)
        )
        shs = list(sh_res.scalars().all())
        if shs:
            target = shs[0]
            old_coach = target.coach
            old_seat = target.seat_no
            if ji.mode == "train":
                tclass = normalize_coach_class(booking.travel_class, target.coach)
                cap = default_capacity_for_class(tclass)
                cur_num = int(target.seat_no) if target.seat_no and target.seat_no.isdigit() else 1
                new_num = (cur_num % cap) + 1
                bay, stype, _ = seat_to_bay_and_type(tclass, new_num, capacity=cap)
                target.coach = target.coach or "B3"
                target.seat_no = str(new_num)
                target.seat_type = stype
                target.bay = bay
                target.current_status = "CNF"
            else:
                target.seat_no = "15A" if target.seat_no != "15A" else "16A"
                target.seat_type = "WS"
                target.bay = 15 if target.seat_no == "15A" else 16
            new_chart_state = "final"
            berth_changes.append((target, old_coach, old_seat, actor.user_id))
    elif (
        ji.mode == "train"
        and ji.chart_due_at is not None
        and now >= ji.chart_due_at
        and ji.chart_state == "pending"
    ):
        new_chart_state = "final"

    if berth_changes or new_chart_state is not None:
        from saath_api.journeys.chart_watcher import apply_journey_chart_update

        await apply_journey_chart_update(
            settings=settings,
            db=db,
            redis=redis,
            journey_instance=ji,
            new_chart_state=new_chart_state,
            berth_changes=berth_changes,
            commit=True,
        )
        await db.refresh(ji)
        await db.refresh(booking)
    else:
        await db.commit()
        await db.refresh(ji)
        await db.refresh(booking)

    return await _build_journey_hub(
        db=db, yaml_configs=yaml_configs, actor=actor, ji=ji, booking=booking, party=party
    )


async def _prune_goal_movers(
    *,
    db: AsyncSession,
    party_id: UUID,
    removed_seat_holder_ids: set[UUID],
) -> None:
    if not removed_seat_holder_ids:
        return
    active_goals = (
        (await db.execute(select(Goal).where(Goal.party_id == party_id, Goal.active.is_(True))))
        .scalars()
        .all()
    )
    now = datetime.now(UTC)
    for goal in active_goals:
        remaining = [mid for mid in goal.movers if mid not in removed_seat_holder_ids]
        if len(remaining) != len(goal.movers):
            goal.movers = remaining
            goal.updated_at = now
            if not remaining and goal.goal_type != "open_to_help":
                goal.active = False


async def delete_journey_booking(
    *,
    db: AsyncSession,
    redis: Redis | None = None,
    actor: Actor,
    journey_id: UUID,
    arq_pool: Any | None = None,
    settings: Settings | None = None,
) -> DeleteJourneyResponse:
    ji, booking, party = await _load_actor_journey_context(
        db=db, actor=actor, journey_id=journey_id
    )
    authorize_resource_owner(
        actor,
        "journey.delete",
        owner_user_id=booking.owner_user_id,
        owner_anon_id=booking.owner_anon_id,
    )

    deleted_id = booking.id
    deleted_sh_ids = set(
        (await db.execute(select(SeatHolder.id).where(SeatHolder.booking_id == booking.id)))
        .scalars()
        .all()
    )
    if deleted_sh_ids:
        from saath_api.swaps.service import invalidate_swaps_for_berth_change

        await invalidate_swaps_for_berth_change(
            db=db,
            journey_instance_id=ji.id,
            affected_seat_holder_ids=list(deleted_sh_ids),
            reason="booking_deleted",
        )

    await db.delete(booking)
    await db.flush()

    remaining_rows = (
        await db.execute(
            select(
                PartyMember.seat_holder_id,
                Booking.owner_user_id,
                Booking.owner_anon_id,
            )
            .join(SeatHolder, SeatHolder.id == PartyMember.seat_holder_id)
            .join(Booking, Booking.id == SeatHolder.booking_id)
            .where(PartyMember.party_id == party.id)
            .order_by(PartyMember.joined_at.asc(), SeatHolder.pax_seq.asc())
        )
    ).all()
    if not remaining_rows:
        await db.execute(delete(Party).where(Party.id == party.id))
    else:
        leader_still_present = any(
            (party.leader_user_id is not None and row_uid == party.leader_user_id)
            or (party.leader_anon_id is not None and row_aid == party.leader_anon_id)
            for _, row_uid, row_aid in remaining_rows
        )
        if not leader_still_present:
            _, next_uid, next_aid = remaining_rows[0]
            party.leader_user_id = next_uid
            party.leader_anon_id = next_aid
        await _prune_goal_movers(db=db, party_id=party.id, removed_seat_holder_ids=deleted_sh_ids)

    ji.match_version += 1
    await db.commit()

    from saath_api.matching.service import schedule_or_run_match_recompute

    await schedule_or_run_match_recompute(
        db=db,
        redis=redis,
        journey_instance_id=ji.id,
        arq_pool=arq_pool,
        settings=settings,
    )
    return DeleteJourneyResponse(ok=True, deleted_booking_id=deleted_id)


def list_flight_layouts() -> list[AircraftLayoutSummaryDTO]:
    return [
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
        for spec in AIRCRAFT_LAYOUTS.values()
    ]
