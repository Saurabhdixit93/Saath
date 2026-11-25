from __future__ import annotations

import secrets
from collections import Counter
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import status
from redis.asyncio import Redis
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, authorize_resource_owner
from saath_api.auth.models import User
from saath_api.core.config import Settings, YamlConfigBundle
from saath_api.core.crypto import hash_invite_token
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.journeys.schemas import JourneyHubResponse, VerifyJourneyRequest
from saath_api.journeys.service import (
    _build_journey_hub,
    _goal_dto,
    _load_actor_journey_context,
    resolve_party_entitlement_limits,
    verify_and_persist_booking,
)
from saath_api.notifications.models import NotificationsOutbox
from saath_api.parties.models import Goal, Party, PartyMember
from saath_api.parties.schemas import (
    DeleteGoalResponse,
    GoalMutationResponse,
    OrganiserCoachBucket,
    OrganiserSummaryResponse,
    PartyInviteResponse,
    PartyJoinRequest,
    PutGoalRequest,
)
from saath_api.providers.flight.schedule import FlightScheduleProvider
from saath_api.providers.rail.router import ProviderRouter


async def create_party_invite(
    *,
    settings: Settings,
    db: AsyncSession,
    actor: Actor,
    journey_id: UUID,
) -> PartyInviteResponse:
    _, _, party = await _load_actor_journey_context(
        db=db, actor=actor, journey_id=journey_id
    )

    raw_token = secrets.token_urlsafe(16)
    token_hash = hash_invite_token(raw_token, settings.invite_token_secret)
    expires_at = datetime.now(UTC) + timedelta(hours=48)

    party.invite_token_hash = token_hash
    party.invite_expires_at = expires_at
    await db.commit()

    base_url = settings.app_url.rstrip("/")
    return PartyInviteResponse(
        party_id=party.id,
        invite_token=raw_token,
        invite_url=f"{base_url}/party/join?token={raw_token}",
        expires_at=expires_at,
    )


async def join_party_via_invite(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    redis: Redis,
    rail_router: ProviderRouter,
    flight_provider: FlightScheduleProvider,
    actor: Actor,
    req: PartyJoinRequest,
    client_ip: str,
) -> JourneyHubResponse:
    token_hash = hash_invite_token(req.invite_token, settings.invite_token_secret)
    party_res = await db.execute(
        select(Party).where(Party.invite_token_hash == token_hash)
    )
    target_party = party_res.scalar_one_or_none()
    if target_party is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="invalid_invite_token",
            title="Invalid Invite Link",
            detail="This party invite link is invalid or no longer active.",
        )

    now = datetime.now(UTC)
    if target_party.invite_expires_at is None or target_party.invite_expires_at <= now:
        raise ProblemDetailError(
            status_code=status.HTTP_410_GONE,
            code="invite_expired",
            title="Invite Link Expired",
            detail="This invite link has expired after 48 hours. Ask your group leader for a fresh link.",
        )

    verify_req = VerifyJourneyRequest(
        mode=req.mode,
        pnr=req.pnr,
        sms_text=req.sms_text,
        bcbp=req.bcbp,
        leg_index=req.leg_index,
        declared=req.declared,
        layout_ref=req.layout_ref,
    )
    ji, booking, seat_holders, solo_party = await verify_and_persist_booking(
        settings=settings,
        yaml_configs=yaml_configs,
        db=db,
        redis=redis,
        rail_router=rail_router,
        flight_provider=flight_provider,
        actor=actor,
        req=verify_req,
        client_ip=client_ip,
    )

    if ji.id != target_party.journey_instance_id:
        await db.rollback()
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="cross_journey_join_forbidden",
            title="Different Train or Flight",
            detail="You can only join a party on the same train or flight and date.",
        )

    existing_target_res = await db.execute(
        select(PartyMember.seat_holder_id).where(PartyMember.party_id == target_party.id)
    )
    existing_target_ids = set(existing_target_res.scalars().all())
    incoming_ids = [sh.id for sh in seat_holders if sh.id not in existing_target_ids]

    max_members, _ = await resolve_party_entitlement_limits(
        db=db, yaml_configs=yaml_configs, party=target_party, actor=actor
    )
    projected_count = len(existing_target_ids) + len(incoming_ids)
    if projected_count > max_members:
        await db.rollback()
        raise ProblemDetailError(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            code="organiser_pass_required",
            title="Group-Organiser Trip Pass Required",
            detail=(
                f"Free parties support up to {max_members} passengers. "
                "Unlock multi-PNR coordination up to 50 travellers with the Group-Organiser Trip Pass (₹199)."
            ),
        )

    if incoming_ids:
        # Remove from any prior solo/other party before joining target_party
        await db.execute(
            delete(PartyMember).where(PartyMember.seat_holder_id.in_(incoming_ids))
        )
        for sh_id in incoming_ids:
            db.add(PartyMember(party_id=target_party.id, seat_holder_id=sh_id))
        await db.flush()

        if solo_party.id != target_party.id:
            rem_res = await db.execute(
                select(func.count(PartyMember.seat_holder_id)).where(
                    PartyMember.party_id == solo_party.id
                )
            )
            if int(rem_res.scalar_one() or 0) == 0:
                await db.execute(delete(Party).where(Party.id == solo_party.id))

        ji.match_version += 1
        db.add(
            NotificationsOutbox(
                user_id=target_party.leader_user_id or actor.user_id,
                event="PartyJoined",
                payload={
                    "party_id": str(target_party.id),
                    "journey_instance_id": str(ji.id),
                    "added_members": len(incoming_ids),
                },
                idempotency_key=f"party_joined:{target_party.id}:{booking.id}",
            )
        )

    await db.commit()
    await db.refresh(ji)
    return await _build_journey_hub(
        db=db,
        yaml_configs=yaml_configs,
        actor=actor,
        ji=ji,
        booking=booking,
        party=target_party,
    )


async def _load_party_and_actor_membership(
    *,
    db: AsyncSession,
    actor: Actor,
    party_id: UUID,
) -> tuple[Party, JourneyInstance, Booking]:
    party_res = await db.execute(select(Party).where(Party.id == party_id))
    party = party_res.scalar_one_or_none()
    if party is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="party_not_found",
            title="Party Not Found",
            detail="Party was not found.",
        )

    ji_res = await db.execute(
        select(JourneyInstance).where(JourneyInstance.id == party.journey_instance_id)
    )
    ji = ji_res.scalar_one()

    booking_stmt = (
        select(Booking)
        .join(SeatHolder, SeatHolder.booking_id == Booking.id)
        .join(PartyMember, PartyMember.seat_holder_id == SeatHolder.id)
        .where(PartyMember.party_id == party.id)
    )
    if actor.kind == "user" and actor.user_id is not None:
        booking_stmt = booking_stmt.where(Booking.owner_user_id == actor.user_id)
    elif actor.kind == "anon" and actor.anon_id is not None:
        booking_stmt = booking_stmt.where(Booking.owner_anon_id == actor.anon_id)
    elif actor.kind != "admin":
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="You are not a member of this party.",
        )

    booking = (await db.execute(booking_stmt)).scalars().first()
    if booking is None:
        # Check if actor is the party leader directly
        is_leader = (
            (actor.kind == "user" and party.leader_user_id == actor.user_id)
            or (actor.kind == "anon" and party.leader_anon_id == actor.anon_id)
            or actor.kind == "admin"
        )
        if not is_leader:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="forbidden",
                title="Forbidden",
                detail="You are not a member of this party.",
            )
        fallback_booking = (
            await db.execute(
                select(Booking)
                .where(Booking.journey_instance_id == party.journey_instance_id)
                .limit(1)
            )
        ).scalars().first()
        if fallback_booking is None:
            raise ProblemDetailError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="booking_not_found",
                title="Booking Not Found",
                detail="No booking found for this party.",
            )
        booking = fallback_booking

    return party, ji, booking


async def remove_party_member(
    *,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    actor: Actor,
    party_id: UUID,
    seat_holder_id: UUID,
) -> JourneyHubResponse:
    party, ji, booking = await _load_party_and_actor_membership(
        db=db, actor=actor, party_id=party_id
    )
    authorize_resource_owner(
        actor,
        "party.remove_member",
        owner_user_id=party.leader_user_id,
        owner_anon_id=party.leader_anon_id,
    )

    pm_res = await db.execute(
        select(PartyMember).where(
            PartyMember.party_id == party.id,
            PartyMember.seat_holder_id == seat_holder_id,
        )
    )
    pm = pm_res.scalar_one_or_none()
    if pm is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="member_not_found",
            title="Member Not Found",
            detail="That passenger is not in this party.",
        )

    total_res = await db.execute(
        select(func.count(PartyMember.seat_holder_id)).where(
            PartyMember.party_id == party.id
        )
    )
    if int(total_res.scalar_one() or 0) <= 1:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="cannot_remove_last_member",
            title="Cannot Remove Last Member",
            detail="A party must keep at least one traveller. Delete the journey instead.",
        )

    await db.delete(pm)
    ji.match_version += 1
    await db.commit()
    await db.refresh(ji)
    return await _build_journey_hub(
        db=db, yaml_configs=yaml_configs, actor=actor, ji=ji, booking=booking, party=party
    )


async def put_party_goal(
    *,
    db: AsyncSession,
    actor: Actor,
    party_id: UUID,
    req: PutGoalRequest,
) -> GoalMutationResponse:
    party, ji, _ = await _load_party_and_actor_membership(
        db=db, actor=actor, party_id=party_id
    )

    member_sh_res = await db.execute(
        select(SeatHolder)
        .join(PartyMember, PartyMember.seat_holder_id == SeatHolder.id)
        .where(PartyMember.party_id == party.id)
    )
    member_shs = list(member_sh_res.scalars().all())
    member_map = {sh.id: sh for sh in member_shs}

    movers = list(req.movers)
    if not movers:
        if req.goal_type == "open_to_help":
            movers = [sh.id for sh in member_shs]
        else:
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="movers_required",
                title="Select Passengers",
                detail="Select at least one passenger in your party.",
            )

    invalid_movers = [mid for mid in movers if mid not in member_map]
    if invalid_movers:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="invalid_movers",
            title="Invalid Party Passenger",
            detail="All selected movers must belong to your party.",
        )

    if req.goal_type == "specific_seats":
        if not (1 <= len(req.preferred_seats) <= 4):
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_preferred_seats",
                title="Select Specific Seats",
                detail="Pick between 1 and 4 preferred seats for this goal.",
            )

    if req.constraints.women_only:
        user_is_female = False
        if actor.kind == "user" and actor.user_id is not None:
            user_gender = (
                await db.execute(select(User.gender_self).where(User.id == actor.user_id))
            ).scalar_one_or_none()
            user_is_female = user_gender == "female"
        movers_all_female = all(member_map[mid].gender_band == "F" for mid in movers)
        if not user_is_female and not movers_all_female:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="women_only_not_eligible",
                title="Women-Only Guard",
                detail=(
                    "Women-only swap mode requires a female profile or verified female "
                    "passenger berth records."
                ),
            )

    await db.execute(
        update(Goal)
        .where(Goal.party_id == party.id, Goal.active.is_(True))
        .values(active=False)
    )
    now = datetime.now(UTC)
    goal = Goal(
        id=uuid7(),
        party_id=party.id,
        goal_type=req.goal_type,
        movers=movers,
        preferred_seats=[s.strip().upper() for s in req.preferred_seats],
        constraints=req.constraints.model_dump(),
        standing_offer=req.standing_offer.model_dump() if req.standing_offer else None,
        active=True,
        updated_at=now,
    )
    db.add(goal)
    ji.match_version += 1
    db.add(
        NotificationsOutbox(
            user_id=actor.user_id,
            event="GoalChanged",
            payload={
                "party_id": str(party.id),
                "journey_instance_id": str(ji.id),
                "goal_id": str(goal.id),
                "goal_type": goal.goal_type,
                "match_version": ji.match_version,
            },
            idempotency_key=f"goal_changed:{party.id}:{ji.match_version}",
        )
    )
    await db.commit()
    await db.refresh(goal)
    await db.refresh(ji)

    dto = _goal_dto(goal)
    assert dto is not None
    return GoalMutationResponse(goal=dto, match_version=ji.match_version)


async def delete_party_goal(
    *,
    db: AsyncSession,
    actor: Actor,
    party_id: UUID,
) -> DeleteGoalResponse:
    party, ji, _ = await _load_party_and_actor_membership(
        db=db, actor=actor, party_id=party_id
    )
    await db.execute(
        update(Goal)
        .where(Goal.party_id == party.id, Goal.active.is_(True))
        .values(active=False)
    )
    ji.match_version += 1
    await db.commit()
    await db.refresh(ji)
    return DeleteGoalResponse(ok=True, match_version=ji.match_version)


async def get_organiser_summary(
    *,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    actor: Actor,
    party_id: UUID,
) -> OrganiserSummaryResponse:
    party, ji, _ = await _load_party_and_actor_membership(
        db=db, actor=actor, party_id=party_id
    )
    _, has_pass = await resolve_party_entitlement_limits(
        db=db, yaml_configs=yaml_configs, party=party, actor=actor
    )
    if not has_pass:
        raise ProblemDetailError(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            code="organiser_pass_required",
            title="Group-Organiser Trip Pass Required",
            detail="Active Group-Organiser Trip Pass (₹199/trip) or B2B Partner entitlement is required to access organiser summaries.",
        )

    members_res = await db.execute(
        select(SeatHolder)
        .join(PartyMember, PartyMember.seat_holder_id == SeatHolder.id)
        .where(PartyMember.party_id == party.id)
    )
    members = list(members_res.scalars().all())
    bookings_count = len({sh.booking_id for sh in members})

    coach_groups: dict[str, list[SeatHolder]] = {}
    seat_type_counts: Counter[str] = Counter()
    status_counts: Counter[str] = Counter()
    for sh in members:
        coach_key = sh.coach or "UNASSIGNED"
        coach_groups.setdefault(coach_key, []).append(sh)
        seat_type_counts[sh.seat_type or "UNKNOWN"] += 1
        status_counts[sh.current_status or sh.booking_status or "UNKNOWN"] += 1

    coach_breakdown = [
        OrganiserCoachBucket(
            coach=coach_name,
            member_count=len(group),
            seat_types=dict(Counter((m.seat_type or "UNKNOWN") for m in group)),
        )
        for coach_name, group in sorted(coach_groups.items())
    ]

    return OrganiserSummaryResponse(
        party_id=party.id,
        journey_instance_id=ji.id,
        mode=ji.mode,  # type: ignore[arg-type]
        service_no=ji.service_no,
        service_date=ji.service_date,
        member_count=len(members),
        bookings_count=bookings_count,
        coach_breakdown=coach_breakdown,
        seat_type_breakdown=dict(seat_type_counts),
        status_breakdown=dict(status_counts),
    )
