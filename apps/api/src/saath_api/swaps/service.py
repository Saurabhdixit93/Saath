from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

import structlog
from fastapi import status
from redis.asyncio import Redis
from sqlalchemy import bindparam, delete, func, select, text, update
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor
from saath_api.auth.models import AuditLog, User
from saath_api.core.config import Settings, YamlConfigBundle, load_yaml_configs
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7
from saath_api.core.redis import SlidingWindowRateLimiter
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.karma.service import (
    credit_for_completed_proposal,
    evaluate_and_award_badges,
    record_pending_for_proposal,
    reverse_for_proposal,
)
from saath_api.matching.graph import make_pseudonymous_alias
from saath_api.matching.models import Block, MatchCandidate
from saath_api.messaging.moderation import evaluate_message_moderation
from saath_api.messaging.redaction import redact_contact_details
from saath_api.notifications.models import NotificationsOutbox
from saath_api.parties.models import PartyMember
from saath_api.providers.llm import FakeLLMProvider, LLMProvider
from saath_api.swaps.cards import (
    encode_signature_b64,
    generate_public_code,
    sign_swap_card,
    verify_swap_card_signature,
)
from saath_api.swaps.models import SeatLock, SwapCard, SwapParticipant, SwapProposal
from saath_api.swaps.schemas import (
    AcceptSwapRequest,
    ConfirmCompletionRequest,
    CreateSwapRequest,
    DeclineSwapRequest,
    PublicSwapCardVerifyResponse,
    SwapCardJsonResponse,
    SwapCardParticipantDTO,
    SwapDetailDTO,
    SwapListResponse,
    SwapParticipantViewDTO,
)

logger = structlog.get_logger(__name__)

_PUBLIC_CODE_RE = re.compile(r"^SW-[A-Z0-9]{4,16}$")
_REVEALED_STATUSES: frozenset[str] = frozenset(
    {"confirmed", "awaiting_confirmation", "completed", "not_completed"}
)
_ACTIVE_STATUSES: tuple[str, ...] = ("pending", "confirmed", "awaiting_confirmation")
_PAST_STATUSES: tuple[str, ...] = (
    "declined",
    "expired",
    "invalidated",
    "cancelled",
    "completed",
    "not_completed",
)


def _mask_seat(coach: str | None, seat_type: str | None) -> str:
    c = (coach or "CABIN").strip().upper()
    st = (seat_type or "S").strip().upper()
    return f"{c} {st}"


def _is_conflict_db_error(exc: BaseException) -> bool:
    if isinstance(exc, IntegrityError):
        return True
    if isinstance(exc, DBAPIError):
        orig = getattr(exc, "orig", None)
        sqlstate = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
        if sqlstate in ("23505", "40001", "40P01"):
            return True
        msg = str(exc).lower()
        if "could not serialize access" in msg or "duplicate key" in msg:
            return True
    return False


async def _begin_serializable(db: AsyncSession) -> None:
    if db.in_transaction():
        await db.rollback()
    await db.connection(execution_options={"isolation_level": "SERIALIZABLE"})


async def _has_block_among_users(db: AsyncSession, user_ids: set[UUID]) -> bool:
    if len(user_ids) < 2:
        return False
    row = (
        await db.execute(
            select(Block.blocker)
            .where(
                Block.blocker.in_(user_ids),
                Block.blocked.in_(user_ids),
                Block.blocker != Block.blocked,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return row is not None


async def _publish_swap_updated(
    redis: Redis | None,
    *,
    proposal: SwapProposal,
    user_ids: set[UUID],
) -> None:
    if redis is None or not user_ids:
        return
    payload = json.dumps(
        {
            "type": "swap.updated",
            "swap_id": str(proposal.id),
            "journey_instance_id": str(proposal.journey_instance_id),
            "status": proposal.status,
            "version": proposal.version,
        }
    )
    for uid in user_ids:
        try:
            await redis.publish(f"user:{uid}", payload)
        except Exception:
            logger.warning("swap_redis_publish_failed", swap_id=str(proposal.id))


async def _build_swap_detail_dto(
    db: AsyncSession,
    proposal: SwapProposal,
    actor: Actor,
) -> SwapDetailDTO:
    ji = (
        await db.execute(
            select(JourneyInstance).where(JourneyInstance.id == proposal.journey_instance_id)
        )
    ).scalar_one()
    parts = list(
        (
            await db.execute(
                select(SwapParticipant)
                .where(SwapParticipant.proposal_id == proposal.id)
                .order_by(SwapParticipant.seat_holder_id)
            )
        )
        .scalars()
        .all()
    )
    card = (
        await db.execute(select(SwapCard).where(SwapCard.proposal_id == proposal.id))
    ).scalar_one_or_none()

    revealed = proposal.status in _REVEALED_STATUSES
    my_parts: list[SwapParticipant] = []
    part_dtos: list[SwapParticipantViewDTO] = []

    for p in parts:
        is_me = actor.kind == "user" and actor.user_id is not None and p.user_id == actor.user_id
        if is_me:
            my_parts.append(p)
        if revealed:
            gives_val = p.gives_seat
            gets_val = p.gets_seat
        elif is_me:
            gives_val = p.gives_seat
            gets_val = _mask_seat(p.gets_coach, p.gets_seat_type)
        else:
            gives_val = _mask_seat(p.gives_coach, p.gives_seat_type)
            gets_val = _mask_seat(p.gets_coach, p.gets_seat_type)

        part_dtos.append(
            SwapParticipantViewDTO(
                alias=p.alias,
                decision=p.decision,  # type: ignore[arg-type]
                decided_at=p.decided_at,
                post_confirm=p.post_confirm,  # type: ignore[arg-type]
                is_me=is_me,
                gives_seat=gives_val,
                gets_seat=gets_val,
                gives_coach=p.gives_coach,
                gets_coach=p.gets_coach,
                gives_seat_type=p.gives_seat_type,
                gets_seat_type=p.gets_seat_type,
            )
        )

    you_give = (
        ", ".join(p.gives_seat for p in my_parts)
        if my_parts
        else (
            (
                parts[0].gives_seat
                if revealed
                else _mask_seat(parts[0].gives_coach, parts[0].gives_seat_type)
            )
            if parts
            else ""
        )
    )
    you_get_summary = (
        ", ".join(_mask_seat(p.gets_coach, p.gets_seat_type) for p in my_parts)
        if my_parts
        else (_mask_seat(parts[0].gets_coach, parts[0].gets_seat_type) if parts else "")
    )

    can_accept = (
        proposal.status == "pending"
        and bool(my_parts)
        and any(p.decision == "pending" for p in my_parts)
    )
    can_cancel = (
        proposal.status == "pending"
        and actor.kind == "user"
        and actor.user_id is not None
        and proposal.initiator_user_id == actor.user_id
    )
    my_post_confirm = next((p.post_confirm for p in my_parts if p.post_confirm), None)
    can_confirm = (
        proposal.status in ("confirmed", "awaiting_confirmation", "completed")
        and bool(my_parts)
        and my_post_confirm is None
    )

    return SwapDetailDTO(
        id=proposal.id,
        journey_instance_id=proposal.journey_instance_id,
        kind=proposal.kind,  # type: ignore[arg-type]
        status=proposal.status,  # type: ignore[arg-type]
        version=proposal.version,
        expires_at=proposal.expires_at,
        created_at=proposal.created_at,
        confirmed_at=proposal.confirmed_at,
        note=proposal.note,
        decline_reason=proposal.decline_reason,
        service=f"{ji.carrier_code} {ji.service_no}".strip(),
        date=ji.service_date.isoformat(),
        mode=ji.mode,  # type: ignore[arg-type]
        you_give=you_give,
        you_get_summary=you_get_summary,
        participants=part_dtos,
        swap_card_code=card.public_code if card else None,
        can_accept=can_accept,
        can_cancel=can_cancel,
        can_confirm_completion=can_confirm,
        my_post_confirm=my_post_confirm,  # type: ignore[arg-type]
    )


async def _require_proposal_access(
    db: AsyncSession,
    proposal_id: UUID,
    actor: Actor,
) -> tuple[SwapProposal, list[SwapParticipant]]:
    proposal = (
        await db.execute(select(SwapProposal).where(SwapProposal.id == proposal_id))
    ).scalar_one_or_none()
    if proposal is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="swap_not_found",
            title="Swap Not Found",
            detail="Swap proposal was not found.",
        )

    parts = list(
        (
            await db.execute(
                select(SwapParticipant)
                .where(SwapParticipant.proposal_id == proposal.id)
                .order_by(SwapParticipant.seat_holder_id)
            )
        )
        .scalars()
        .all()
    )

    if actor.kind == "admin":
        return proposal, parts

    if actor.kind == "user" and actor.user_id is not None:
        is_member = proposal.initiator_user_id == actor.user_id or any(
            p.user_id == actor.user_id for p in parts
        )
        if is_member:
            return proposal, parts

    raise ProblemDetailError(
        status_code=status.HTTP_403_FORBIDDEN,
        code="forbidden",
        title="Forbidden",
        detail="You are not a participant in this swap.",
    )


async def create_swap_proposal(
    *,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    redis: Redis,
    actor: Actor,
    req: CreateSwapRequest,
    llm_provider: LLMProvider | None = None,
) -> SwapDetailDTO:
    if actor.kind != "user" or actor.user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_auth_required",
            title="Phone Verification Required",
            detail="Verify your phone number to propose a seat swap.",
        )

    user_row = (await db.execute(select(User).where(User.id == actor.user_id))).scalar_one_or_none()
    if user_row is None:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="user_not_found",
            title="Account Not Found",
            detail="Authenticated user account no longer exists.",
        )
    if user_row.status in ("banned", "deleted"):
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="account_disabled",
            title="Account Disabled",
            detail="This account is not permitted to propose seat swaps.",
        )
    if user_row.status == "restricted":
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="account_restricted",
            title="Account Restricted",
            detail="Your swap privileges are temporarily restricted due to safety reports.",
        )

    limiter = SlidingWindowRateLimiter(redis)
    daily_limit = yaml_configs.rate_limits.swaps_created.per_user_per_day
    allowed, retry_after = await limiter.allow(
        f"rl:swaps:user:{actor.user_id}",
        limit=daily_limit,
        window_seconds=86400,
    )
    if not allowed:
        raise ProblemDetailError(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="rate_limited",
            title="Daily Swap Proposal Limit Reached",
            detail="You have reached the daily limit for creating swap proposals.",
            headers={"Retry-After": str(retry_after)},
        )

    cand = (
        await db.execute(select(MatchCandidate).where(MatchCandidate.card_id == req.card_id))
    ).scalar_one_or_none()
    if cand is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="match_card_not_found",
            title="Match Not Found",
            detail="This match candidate is no longer available. Refresh matches.",
        )

    ji = (
        await db.execute(
            select(JourneyInstance).where(JourneyInstance.id == cand.journey_instance_id)
        )
    ).scalar_one()

    # Check actor belongs to cand.for_party_id
    party_bookings = (
        await db.execute(
            select(Booking.id)
            .join(SeatHolder, SeatHolder.booking_id == Booking.id)
            .join(PartyMember, PartyMember.seat_holder_id == SeatHolder.id)
            .where(
                PartyMember.party_id == cand.for_party_id,
                Booking.owner_user_id == actor.user_id,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if party_bookings is None and actor.kind != "admin":
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="You cannot propose a swap from another party's match card.",
        )

    if cand.match_version != ji.match_version:
        raise ProblemDetailError(
            status_code=status.HTTP_409_CONFLICT,
            code="stale_match_version",
            title="Matches Updated",
            detail="Your matches updated after a recent change. Please pick from the latest matches.",
        )

    # Resolve ordered cycles from MatchCandidate
    cycles_to_apply: list[list[UUID]] = []
    if cand.kind == "plan" and isinstance(cand.plan_cycles, dict):
        raw_cycles = cand.plan_cycles.get("cycles") or []
        for raw_c in raw_cycles:
            if isinstance(raw_c, list) and len(raw_c) >= 2:
                cycles_to_apply.append([UUID(str(x)) for x in raw_c])
    if not cycles_to_apply:
        cycles_to_apply = [list(cand.cycle_seat_holders)]

    all_sh_ids: list[UUID] = []
    for cyc in cycles_to_apply:
        all_sh_ids.extend(cyc)

    # Check none are currently locked
    locked = (
        (
            await db.execute(
                select(SeatLock.seat_holder_id).where(SeatLock.seat_holder_id.in_(all_sh_ids))
            )
        )
        .scalars()
        .all()
    )
    if locked:
        raise ProblemDetailError(
            status_code=status.HTTP_409_CONFLICT,
            code="seat_locked",
            title="Seat Already Reserved",
            detail="One of the seats in this swap is already locked by another proposal.",
        )

    sh_rows = (
        await db.execute(
            select(SeatHolder, Booking)
            .join(Booking, Booking.id == SeatHolder.booking_id)
            .where(SeatHolder.id.in_(all_sh_ids))
        )
    ).all()
    sh_map: dict[UUID, tuple[SeatHolder, Booking]] = {sh.id: (sh, bk) for sh, bk in sh_rows}
    if len(sh_map) != len(set(all_sh_ids)):
        raise ProblemDetailError(
            status_code=status.HTTP_409_CONFLICT,
            code="seat_unavailable",
            title="Seat Unavailable",
            detail="One of the seats in this match is no longer available.",
        )

    all_involved_uids: set[UUID] = {actor.user_id}
    for sh, bk in sh_map.values():
        uid = sh.linked_user_id or bk.owner_user_id
        if uid is not None:
            all_involved_uids.add(uid)
    if await _has_block_among_users(db, all_involved_uids):
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_blocked",
            title="User Blocked",
            detail="Cannot create a swap involving a blocked traveller.",
        )

    now = datetime.now(UTC)
    six_hours = now + timedelta(hours=6)
    if ji.departure_at is not None:
        dep_cutoff = ji.departure_at - timedelta(minutes=30)
        expires_at = min(six_hours, dep_cutoff)
        if expires_at <= now:
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="departure_cutoff_passed",
                title="Departure Too Close",
                detail="Swaps close 30 minutes before departure.",
            )
    else:
        expires_at = six_hours

    clean_note: str | None = None
    if req.note and req.note.strip():
        raw_note = req.note.strip()
        locale = "hi" if user_row.locale == "hi" else "en"
        redaction = redact_contact_details(raw_note, locale=locale)
        resolved_llm = llm_provider or FakeLLMProvider()
        mod_outcome = await evaluate_message_moderation(
            clean_text=redaction.text,
            was_redacted=redaction.redacted,
            locale=locale,
            llm_provider=resolved_llm,
        )
        if mod_outcome.moderation == "hidden":
            db.add(
                AuditLog(
                    actor="system:moderation",
                    action="swap_note.hidden",
                    resource=f"user:{actor.user_id}",
                    meta={
                        "card_id": req.card_id,
                        "category": mod_outcome.category,
                        "reason": mod_outcome.reason,
                    },
                )
            )
            await db.commit()
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="note_moderated",
                title="Note Not Allowed",
                detail=(
                    "Your swap note was blocked by safety moderation. "
                    "Please remove unsafe or payment-related content."
                ),
            )
        clean_note = redaction.text[:300]

    proposal = SwapProposal(
        id=uuid7(),
        journey_instance_id=ji.id,
        initiator_user_id=actor.user_id,
        kind=cand.kind,
        status="pending",
        note=clean_note,
        source_card_id=cand.card_id,
        expires_at=expires_at,
        version=0,
    )
    db.add(proposal)
    await db.flush()

    participant_user_ids: set[UUID] = set()
    for cyc in cycles_to_apply:
        n = len(cyc)
        for idx, uid in enumerate(cyc):
            giver_sh, giver_bk = sh_map[uid]
            target_sh, _ = sh_map[cyc[(idx + 1) % n]]
            p_uid = giver_sh.linked_user_id or giver_bk.owner_user_id
            if p_uid is not None:
                participant_user_ids.add(p_uid)

            gives_str = (
                f"{giver_sh.coach}-{giver_sh.seat_no} {giver_sh.seat_type}"
                if giver_sh.coach and giver_sh.coach != "CABIN"
                else f"{giver_sh.seat_no} {giver_sh.seat_type}"
            )
            gets_str = (
                f"{target_sh.coach}-{target_sh.seat_no} {target_sh.seat_type}"
                if target_sh.coach and target_sh.coach != "CABIN"
                else f"{target_sh.seat_no} {target_sh.seat_type}"
            )
            db.add(
                SwapParticipant(
                    proposal_id=proposal.id,
                    seat_holder_id=giver_sh.id,
                    user_id=p_uid,
                    alias=make_pseudonymous_alias(giver_sh.coach, giver_sh.seat_type, giver_sh.id),
                    gives_seat=gives_str,
                    gets_seat=gets_str,
                    gives_coach=giver_sh.coach,
                    gets_coach=target_sh.coach,
                    gives_seat_type=giver_sh.seat_type,
                    gets_seat_type=target_sh.seat_type,
                    gives_bay=giver_sh.bay,
                    gets_bay=target_sh.bay,
                    decision="pending",
                )
            )

    for uid in participant_user_ids:
        db.add(
            NotificationsOutbox(
                user_id=uid,
                event="SwapProposed",
                payload={
                    "swap_id": str(proposal.id),
                    "journey_instance_id": str(ji.id),
                    "kind": proposal.kind,
                },
                idempotency_key=f"swap_proposed:{proposal.id}:{uid}",
            )
        )

    await db.commit()
    await db.refresh(proposal)
    await _publish_swap_updated(redis, proposal=proposal, user_ids=participant_user_ids)
    return await _build_swap_detail_dto(db, proposal, actor)


async def list_swaps(
    *,
    db: AsyncSession,
    actor: Actor,
    state: Literal["active", "past", "all"] = "active",
) -> SwapListResponse:
    if actor.kind != "user" or actor.user_id is None:
        return SwapListResponse(items=[])

    part_prop_ids = select(SwapParticipant.proposal_id).where(
        SwapParticipant.user_id == actor.user_id
    )
    stmt = select(SwapProposal).where(
        (SwapProposal.initiator_user_id == actor.user_id) | SwapProposal.id.in_(part_prop_ids)
    )
    if state == "active":
        stmt = stmt.where(SwapProposal.status.in_(_ACTIVE_STATUSES))
    elif state == "past":
        stmt = stmt.where(SwapProposal.status.in_(_PAST_STATUSES))

    stmt = stmt.order_by(SwapProposal.created_at.desc())
    proposals = list((await db.execute(stmt)).scalars().all())
    items = [await _build_swap_detail_dto(db, prop, actor) for prop in proposals]
    return SwapListResponse(items=items)


async def get_swap_detail(
    *,
    db: AsyncSession,
    actor: Actor,
    swap_id: UUID,
) -> SwapDetailDTO:
    proposal, _ = await _require_proposal_access(db, swap_id, actor)
    return await _build_swap_detail_dto(db, proposal, actor)


async def accept_swap(
    *,
    settings: Settings,
    db: AsyncSession,
    redis: Redis | None,
    actor: Actor,
    swap_id: UUID,
    req: AcceptSwapRequest,
    yaml_configs: YamlConfigBundle | None = None,
) -> SwapDetailDTO:
    if actor.kind != "user" or actor.user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_auth_required",
            title="Phone Verification Required",
            detail="Verify your phone number to accept a swap.",
        )

    try:
        await _begin_serializable(db)

        proposal, parts = await _require_proposal_access(db, swap_id, actor)
        my_parts = [p for p in parts if p.user_id == actor.user_id]
        if not my_parts:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="forbidden",
                title="Forbidden",
                detail="Only swap participants can accept this proposal.",
            )

        if proposal.status != "pending":
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="invalid_swap_state",
                title="Swap No Longer Pending",
                detail=f"Cannot accept a swap with status {proposal.status!r}.",
            )

        now = datetime.now(UTC)
        if proposal.expires_at <= now:
            proposal.status = "expired"
            proposal.version += 1
            await db.execute(delete(SeatLock).where(SeatLock.proposal_id == proposal.id))
            await db.commit()
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="swap_expired",
                title="Swap Expired",
                detail="This swap proposal has expired.",
            )

        all_involved_uids = {p.user_id for p in parts if p.user_id is not None}
        if proposal.initiator_user_id is not None:
            all_involved_uids.add(proposal.initiator_user_id)
        if await _has_block_among_users(db, all_involved_uids):
            proposal.status = "invalidated"
            proposal.version += 1
            await db.execute(delete(SeatLock).where(SeatLock.proposal_id == proposal.id))
            await db.commit()
            await _publish_swap_updated(redis, proposal=proposal, user_ids=all_involved_uids)
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="user_blocked",
                title="User Blocked",
                detail="This swap cannot proceed because a participant is blocked.",
            )

        if proposal.version != req.version:
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="version_conflict",
                title="Swap Updated",
                detail="This swap was updated by another participant. Refreshing latest version.",
            )

        # Acquire seat locks for caller's seats (PK seat_holder_id enforces exclusivity)
        my_sh_ids = [p.seat_holder_id for p in my_parts]
        existing_locks = {
            sl.seat_holder_id: sl.proposal_id
            for sl in (
                await db.execute(select(SeatLock).where(SeatLock.seat_holder_id.in_(my_sh_ids)))
            )
            .scalars()
            .all()
        }
        for sh_id in my_sh_ids:
            owner_prop = existing_locks.get(sh_id)
            if owner_prop is not None and owner_prop != proposal.id:
                raise ProblemDetailError(
                    status_code=status.HTTP_409_CONFLICT,
                    code="seat_locked",
                    title="Seat Already Locked",
                    detail="Your seat is already locked in another active swap.",
                )
            if owner_prop is None:
                db.add(SeatLock(seat_holder_id=sh_id, proposal_id=proposal.id))
        await db.flush()

        for p in my_parts:
            p.decision = "accepted"
            p.decided_at = now

        # Optimistic concurrency bump in SQL
        upd = await db.execute(
            update(SwapProposal)
            .where(
                SwapProposal.id == proposal.id,
                SwapProposal.version == req.version,
                SwapProposal.status == "pending",
            )
            .values(version=req.version + 1)
        )
        if upd.rowcount != 1:  # type: ignore[attr-defined]
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="version_conflict",
                title="Swap Updated",
                detail="This swap was modified concurrently. Please refresh and try again.",
            )
        proposal.version = req.version + 1

        all_accepted = all(p.decision == "accepted" for p in parts)
        participant_user_ids = {p.user_id for p in parts if p.user_id is not None}

        if all_accepted:
            # Ensure all participant seats are locked when confirmed
            all_sh_ids = [p.seat_holder_id for p in parts]
            locked_all = {
                sl.seat_holder_id: sl.proposal_id
                for sl in (
                    await db.execute(
                        select(SeatLock).where(SeatLock.seat_holder_id.in_(all_sh_ids))
                    )
                )
                .scalars()
                .all()
            }
            for sh_id in all_sh_ids:
                owner_prop = locked_all.get(sh_id)
                if owner_prop is not None and owner_prop != proposal.id:
                    raise ProblemDetailError(
                        status_code=status.HTTP_409_CONFLICT,
                        code="seat_locked",
                        title="Seat Already Locked",
                        detail="A partner seat was just locked in another swap.",
                    )
                if owner_prop is None:
                    db.add(SeatLock(seat_holder_id=sh_id, proposal_id=proposal.id))
            await db.flush()

            proposal.status = "confirmed"
            proposal.confirmed_at = now

            if participant_user_ids:
                await db.execute(
                    update(User)
                    .where(User.id.in_(participant_user_ids))
                    .values(reliability_accepted=User.reliability_accepted + 1)
                )

            ji = (
                await db.execute(
                    select(JourneyInstance).where(
                        JourneyInstance.id == proposal.journey_instance_id
                    )
                )
            ).scalar_one()

            await record_pending_for_proposal(
                db=db,
                proposal=proposal,
                parts=parts,
                ji=ji,
                yaml_configs=yaml_configs or load_yaml_configs(settings.config_dir),
            )

            public_code = generate_public_code()
            card_participants = [
                {
                    "alias": p.alias,
                    "from_seat": p.gives_seat,
                    "to_seat": p.gets_seat,
                    "gives_seat": p.gives_seat,
                    "gets_seat": p.gets_seat,
                    "decided_at": (p.decided_at or now).isoformat(),
                }
                for p in parts
            ]
            signed_payload: dict[str, Any] = {
                "proposal_id": str(proposal.id),
                "public_code": public_code,
                "service": f"{ji.carrier_code} {ji.service_no}".strip(),
                "date": ji.service_date.isoformat(),
                "mode": ji.mode,
                "confirmed_at": now.isoformat(),
                "participants": card_participants,
            }
            sig_bytes = sign_swap_card(signed_payload, settings.swap_card_signing_private_key)
            db.add(
                SwapCard(
                    proposal_id=proposal.id,
                    public_code=public_code,
                    payload_json=signed_payload,
                    signature=sig_bytes,
                    revoked=False,
                )
            )

            # Hook for M4 conversations.unmasked when conversations & conversation_members exist
            has_convos = (
                await db.execute(text("SELECT to_regclass('public.conversations')"))
            ).scalar_one_or_none()
            has_convo_members = (
                await db.execute(text("SELECT to_regclass('public.conversation_members')"))
            ).scalar_one_or_none()
            if has_convos is not None and has_convo_members is not None and participant_user_ids:
                unmask_stmt = text(
                    "UPDATE conversations "
                    "SET unmasked = true "
                    "WHERE journey_instance_id = :ji_id "
                    "AND id IN ("
                    "  SELECT cm.conversation_id "
                    "  FROM conversation_members cm "
                    "  GROUP BY cm.conversation_id "
                    "  HAVING COUNT(*) >= 2 "
                    "  AND BOOL_AND(cm.user_id IS NOT NULL AND cm.user_id = ANY(:participant_uids))"
                    ")"
                ).bindparams(
                    bindparam("ji_id", type_=PG_UUID(as_uuid=True)),
                    bindparam("participant_uids", type_=PG_ARRAY(PG_UUID(as_uuid=True))),
                )
                await db.execute(
                    unmask_stmt,
                    {
                        "ji_id": ji.id,
                        "participant_uids": sorted(participant_user_ids),
                    },
                )

            for uid in participant_user_ids:
                db.add(
                    NotificationsOutbox(
                        user_id=uid,
                        event="SwapConfirmed",
                        payload={
                            "swap_id": str(proposal.id),
                            "public_code": public_code,
                            "journey_instance_id": str(ji.id),
                        },
                        idempotency_key=f"swap_confirmed:{proposal.id}:{uid}",
                    )
                )

        await db.commit()
    except ProblemDetailError:
        await db.rollback()
        raise
    except (IntegrityError, DBAPIError) as exc:
        await db.rollback()
        if _is_conflict_db_error(exc):
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="seat_locked",
                title="Seat Lock Conflict",
                detail="Another swap locked one of these seats at the same moment.",
            ) from exc
        raise

    await db.refresh(proposal)
    await _publish_swap_updated(redis, proposal=proposal, user_ids=participant_user_ids)
    return await _build_swap_detail_dto(db, proposal, actor)


async def decline_swap(
    *,
    db: AsyncSession,
    redis: Redis | None,
    actor: Actor,
    swap_id: UUID,
    req: DeclineSwapRequest,
    arq_pool: Any | None = None,
    settings: Settings | None = None,
) -> SwapDetailDTO:
    if actor.kind != "user" or actor.user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_auth_required",
            title="Phone Verification Required",
            detail="Verify your phone number to decline a swap.",
        )

    try:
        await _begin_serializable(db)
        proposal, parts = await _require_proposal_access(db, swap_id, actor)
        my_parts = [p for p in parts if p.user_id == actor.user_id]
        if not my_parts:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="forbidden",
                title="Forbidden",
                detail="Only swap participants can decline this proposal.",
            )
        if proposal.status != "pending":
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="invalid_swap_state",
                title="Swap No Longer Pending",
                detail=f"Cannot decline a swap with status {proposal.status!r}.",
            )

        expected_version = proposal.version
        upd = await db.execute(
            update(SwapProposal)
            .where(
                SwapProposal.id == proposal.id,
                SwapProposal.version == expected_version,
                SwapProposal.status == "pending",
            )
            .values(version=expected_version + 1)
        )
        if upd.rowcount != 1:  # type: ignore[attr-defined]
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="version_conflict",
                title="Swap Updated",
                detail="This swap was modified concurrently. Please refresh and try again.",
            )
        proposal.version = expected_version + 1

        now = datetime.now(UTC)
        for p in my_parts:
            p.decision = "declined"
            p.decided_at = now

        proposal.status = "declined"
        proposal.decline_reason = req.reason.strip() if req.reason else None

        await db.execute(delete(SeatLock).where(SeatLock.proposal_id == proposal.id))

        participant_user_ids = {p.user_id for p in parts if p.user_id is not None}
        for uid in participant_user_ids:
            db.add(
                NotificationsOutbox(
                    user_id=uid,
                    event="ProposalDeclined",
                    payload={
                        "swap_id": str(proposal.id),
                        "journey_instance_id": str(proposal.journey_instance_id),
                    },
                    idempotency_key=f"proposal_declined:{proposal.id}:{uid}",
                )
            )
        await db.commit()
    except ProblemDetailError:
        await db.rollback()
        raise
    except (IntegrityError, DBAPIError) as exc:
        await db.rollback()
        if _is_conflict_db_error(exc):
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="version_conflict",
                title="Swap Updated",
                detail="This swap was modified concurrently. Please refresh and try again.",
            ) from exc
        raise
    except Exception:
        await db.rollback()
        raise

    await db.refresh(proposal)
    from saath_api.matching.service import schedule_or_run_match_recompute

    await schedule_or_run_match_recompute(
        db=db,
        redis=redis,
        journey_instance_id=proposal.journey_instance_id,
        arq_pool=arq_pool,
        settings=settings,
    )
    await _publish_swap_updated(redis, proposal=proposal, user_ids=participant_user_ids)
    return await _build_swap_detail_dto(db, proposal, actor)


async def cancel_swap(
    *,
    db: AsyncSession,
    redis: Redis | None,
    actor: Actor,
    swap_id: UUID,
    arq_pool: Any | None = None,
    settings: Settings | None = None,
) -> SwapDetailDTO:
    if actor.kind != "user" or actor.user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_auth_required",
            title="Phone Verification Required",
            detail="Verify your phone number to cancel a swap.",
        )

    try:
        await _begin_serializable(db)
        proposal, parts = await _require_proposal_access(db, swap_id, actor)
        if proposal.initiator_user_id != actor.user_id and actor.kind != "admin":
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="forbidden",
                title="Forbidden",
                detail="Only the swap initiator can cancel this proposal.",
            )
        if proposal.status != "pending":
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="invalid_swap_state",
                title="Swap No Longer Pending",
                detail=f"Cannot cancel a swap with status {proposal.status!r}.",
            )

        expected_version = proposal.version
        upd = await db.execute(
            update(SwapProposal)
            .where(
                SwapProposal.id == proposal.id,
                SwapProposal.version == expected_version,
                SwapProposal.status == "pending",
            )
            .values(version=expected_version + 1)
        )
        if upd.rowcount != 1:  # type: ignore[attr-defined]
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="version_conflict",
                title="Swap Updated",
                detail="This swap was modified concurrently. Please refresh and try again.",
            )
        proposal.version = expected_version + 1
        proposal.status = "cancelled"
        await db.execute(delete(SeatLock).where(SeatLock.proposal_id == proposal.id))

        participant_user_ids = {p.user_id for p in parts if p.user_id is not None}
        for uid in participant_user_ids:
            db.add(
                NotificationsOutbox(
                    user_id=uid,
                    event="SwapCancelled",
                    payload={
                        "swap_id": str(proposal.id),
                        "journey_instance_id": str(proposal.journey_instance_id),
                    },
                    idempotency_key=f"swap_cancelled:{proposal.id}:{uid}",
                )
            )
        await db.commit()
    except ProblemDetailError:
        await db.rollback()
        raise
    except (IntegrityError, DBAPIError) as exc:
        await db.rollback()
        if _is_conflict_db_error(exc):
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="version_conflict",
                title="Swap Updated",
                detail="This swap was modified concurrently. Please refresh and try again.",
            ) from exc
        raise
    except Exception:
        await db.rollback()
        raise

    await db.refresh(proposal)
    from saath_api.matching.service import schedule_or_run_match_recompute

    await schedule_or_run_match_recompute(
        db=db,
        redis=redis,
        journey_instance_id=proposal.journey_instance_id,
        arq_pool=arq_pool,
        settings=settings,
    )
    await _publish_swap_updated(redis, proposal=proposal, user_ids=participant_user_ids)
    return await _build_swap_detail_dto(db, proposal, actor)


async def confirm_completion(
    *,
    db: AsyncSession,
    redis: Redis | None,
    actor: Actor,
    swap_id: UUID,
    req: ConfirmCompletionRequest,
    yaml_configs: YamlConfigBundle | None = None,
) -> SwapDetailDTO:
    if actor.kind != "user" or actor.user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_auth_required",
            title="Phone Verification Required",
            detail="Verify your phone number to confirm swap completion.",
        )

    participant_user_ids: set[UUID] = set()
    try:
        await _begin_serializable(db)
        proposal, parts = await _require_proposal_access(db, swap_id, actor)
        my_parts = [p for p in parts if p.user_id == actor.user_id]
        if not my_parts:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="forbidden",
                title="Forbidden",
                detail="Only swap participants can confirm completion.",
            )

        if proposal.status not in ("confirmed", "awaiting_confirmation", "completed"):
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="invalid_swap_state",
                title="Swap Not Confirmable",
                detail=f"Cannot confirm completion for swap in state {proposal.status!r}.",
            )

        for p in my_parts:
            if p.post_confirm is not None and p.post_confirm != req.answer:
                raise ProblemDetailError(
                    status_code=status.HTTP_409_CONFLICT,
                    code="conflicting_confirmation",
                    title="Conflicting Confirmation",
                    detail="You have already submitted a different completion answer.",
                )

        if proposal.status == "completed" and all(p.post_confirm == req.answer for p in my_parts):
            await db.rollback()
            return await _build_swap_detail_dto(db, proposal, actor)

        was_already_completed = proposal.status == "completed"
        expected_version = proposal.version
        upd = await db.execute(
            update(SwapProposal)
            .where(
                SwapProposal.id == proposal.id,
                SwapProposal.version == expected_version,
                SwapProposal.status.in_(("confirmed", "awaiting_confirmation", "completed")),
            )
            .values(version=expected_version + 1)
        )
        if upd.rowcount != 1:  # type: ignore[attr-defined]
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="version_conflict",
                title="Swap Updated",
                detail="This swap was modified concurrently. Please refresh and try again.",
            )
        proposal.version = expected_version + 1

        now = datetime.now(UTC)
        for p in my_parts:
            p.post_confirm = req.answer
            p.post_confirmed_at = now

        participant_user_ids = {p.user_id for p in parts if p.user_id is not None}

        if req.answer in ("no", "did_not_board"):
            proposal.status = "not_completed"
            if was_already_completed and participant_user_ids:
                await db.execute(
                    update(User)
                    .where(User.id.in_(participant_user_ids))
                    .values(reliability_completed=func.greatest(0, User.reliability_completed - 1))
                )
            await reverse_for_proposal(
                db=db,
                proposal_id=proposal.id,
                reason=f"dispute:{req.answer}",
            )
            for uid in participant_user_ids:
                db.add(
                    NotificationsOutbox(
                        user_id=uid,
                        event="SwapNotCompleted",
                        payload={"swap_id": str(proposal.id), "reason": req.answer},
                        idempotency_key=f"swap_not_completed:{proposal.id}:{uid}",
                    )
                )
        elif was_already_completed:
            proposal.status = "completed"
        else:
            ji = (
                await db.execute(
                    select(JourneyInstance).where(
                        JourneyInstance.id == proposal.journey_instance_id
                    )
                )
            ).scalar_one()
            all_yes = all(p.post_confirm == "yes" for p in parts)
            one_yes = any(p.post_confirm == "yes" for p in parts)
            chart_corroborates = ji.chart_state == "final" and not any(
                p.post_confirm in ("no", "did_not_board") for p in parts
            )
            if all_yes or (one_yes and chart_corroborates):
                proposal.status = "completed"
                if participant_user_ids:
                    await db.execute(
                        update(User)
                        .where(User.id.in_(participant_user_ids))
                        .values(reliability_completed=User.reliability_completed + 1)
                    )
                await credit_for_completed_proposal(
                    db=db,
                    proposal=proposal,
                    parts=parts,
                    ji=ji,
                    yaml_configs=yaml_configs,
                )
                await evaluate_and_award_badges(
                    db=db,
                    proposal=proposal,
                    parts=parts,
                    ji=ji,
                )
                for uid in participant_user_ids:
                    db.add(
                        NotificationsOutbox(
                            user_id=uid,
                            event="SwapCompleted",
                            payload={
                                "swap_id": str(proposal.id),
                                "journey_instance_id": str(proposal.journey_instance_id),
                            },
                            idempotency_key=f"swap_completed:{proposal.id}:{uid}",
                        )
                    )
            else:
                proposal.status = "awaiting_confirmation"

        await db.commit()
    except ProblemDetailError:
        await db.rollback()
        raise
    except (IntegrityError, DBAPIError) as exc:
        await db.rollback()
        if _is_conflict_db_error(exc):
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="version_conflict",
                title="Swap Updated",
                detail="This swap was modified concurrently. Please refresh and try again.",
            ) from exc
        raise
    except Exception:
        await db.rollback()
        raise

    await db.refresh(proposal)
    await _publish_swap_updated(redis, proposal=proposal, user_ids=participant_user_ids)
    return await _build_swap_detail_dto(db, proposal, actor)


async def invalidate_swaps_for_berth_change(
    *,
    db: AsyncSession,
    journey_instance_id: UUID,
    affected_seat_holder_ids: list[UUID],
    reason: str = "chart_berth_changed",
) -> list[UUID]:
    """Invalidate active proposals touching affected seats and revoke their SwapCards."""
    if not affected_seat_holder_ids:
        return []

    prop_ids = list(
        (
            await db.execute(
                select(SwapProposal.id)
                .join(SwapParticipant, SwapParticipant.proposal_id == SwapProposal.id)
                .where(
                    SwapProposal.journey_instance_id == journey_instance_id,
                    SwapProposal.status.in_(_ACTIVE_STATUSES),
                    SwapParticipant.seat_holder_id.in_(affected_seat_holder_ids),
                )
                .distinct()
            )
        )
        .scalars()
        .all()
    )
    if not prop_ids:
        return []

    proposals = list(
        (await db.execute(select(SwapProposal).where(SwapProposal.id.in_(prop_ids))))
        .scalars()
        .all()
    )
    for prop in proposals:
        prop.status = "invalidated"
        prop.version += 1

    await db.execute(delete(SeatLock).where(SeatLock.proposal_id.in_(prop_ids)))
    await db.execute(
        update(SwapCard)
        .where(SwapCard.proposal_id.in_(prop_ids))
        .values(revoked=True, revoked_reason=reason)
    )

    parts = list(
        (await db.execute(select(SwapParticipant).where(SwapParticipant.proposal_id.in_(prop_ids))))
        .scalars()
        .all()
    )
    notified: set[tuple[UUID, UUID]] = set()
    for p in parts:
        if p.user_id is not None and (p.proposal_id, p.user_id) not in notified:
            notified.add((p.proposal_id, p.user_id))
            db.add(
                NotificationsOutbox(
                    user_id=p.user_id,
                    event="SwapInvalidated",
                    payload={
                        "swap_id": str(p.proposal_id),
                        "journey_instance_id": str(journey_instance_id),
                        "reason": reason,
                    },
                    idempotency_key=f"swap_invalidated:{p.proposal_id}:{p.user_id}",
                )
            )

    return prop_ids


async def invalidate_pending_swaps_for_user_pair(
    *,
    db: AsyncSession,
    user_a: UUID,
    user_b: UUID,
    reason: str = "user_blocked",
) -> list[tuple[SwapProposal, set[UUID]]]:
    """Atomically invalidate pending swap proposals shared between two users and release locks."""
    if user_a == user_b:
        return []

    def _involves_user(uid: UUID) -> Any:
        return (SwapProposal.initiator_user_id == uid) | SwapProposal.id.in_(
            select(SwapParticipant.proposal_id).where(SwapParticipant.user_id == uid)
        )

    candidate_prop_ids = list(
        (
            await db.execute(
                select(SwapProposal.id).where(
                    SwapProposal.status == "pending",
                    _involves_user(user_a),
                    _involves_user(user_b),
                )
            )
        )
        .scalars()
        .all()
    )
    if not candidate_prop_ids:
        return []

    upd_stmt = (
        update(SwapProposal)
        .where(
            SwapProposal.id.in_(candidate_prop_ids),
            SwapProposal.status == "pending",
        )
        .values(status="invalidated", version=SwapProposal.version + 1)
        .returning(SwapProposal.id)
    )
    actually_invalidated_ids = list((await db.execute(upd_stmt)).scalars().all())
    if not actually_invalidated_ids:
        return []

    await db.execute(delete(SeatLock).where(SeatLock.proposal_id.in_(actually_invalidated_ids)))

    proposals = list(
        (
            await db.execute(
                select(SwapProposal)
                .where(SwapProposal.id.in_(actually_invalidated_ids))
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )

    parts = list(
        (
            await db.execute(
                select(SwapParticipant).where(
                    SwapParticipant.proposal_id.in_(actually_invalidated_ids)
                )
            )
        )
        .scalars()
        .all()
    )
    uids_by_prop: dict[UUID, set[UUID]] = {prop.id: set() for prop in proposals}
    for prop in proposals:
        if prop.initiator_user_id is not None:
            uids_by_prop[prop.id].add(prop.initiator_user_id)
    for p in parts:
        if p.user_id is not None:
            uids_by_prop[p.proposal_id].add(p.user_id)

    for prop in proposals:
        for uid in uids_by_prop[prop.id]:
            db.add(
                NotificationsOutbox(
                    user_id=uid,
                    event="SwapInvalidated",
                    payload={
                        "swap_id": str(prop.id),
                        "journey_instance_id": str(prop.journey_instance_id),
                        "reason": reason,
                    },
                    idempotency_key=f"swap_invalidated:{prop.id}:{uid}",
                )
            )

    return [(prop, uids_by_prop[prop.id]) for prop in proposals]


async def get_swap_card_payload(
    *,
    settings: Settings,
    db: AsyncSession,
    actor: Actor,
    swap_id: UUID,
) -> tuple[SwapCardJsonResponse, dict[str, Any], str]:
    proposal, _ = await _require_proposal_access(db, swap_id, actor)
    card = (
        await db.execute(select(SwapCard).where(SwapCard.proposal_id == proposal.id))
    ).scalar_one_or_none()
    if card is None:
        raise ProblemDetailError(
            status_code=status.HTTP_409_CONFLICT,
            code="swap_not_confirmed",
            title="Swap Not Confirmed",
            detail="A Swap Card is issued once all participants accept the swap.",
        )

    payload = dict(card.payload_json)
    qr_url = f"{settings.app_url.rstrip('/')}/v/{card.public_code}"
    participants = [
        SwapCardParticipantDTO(
            alias=str(p.get("alias", "")),
            from_seat=str(p.get("from_seat", p.get("gives_seat", ""))),
            to_seat=str(p.get("to_seat", p.get("gets_seat", ""))),
            gives_seat=str(p.get("gives_seat", p.get("from_seat", ""))),
            gets_seat=str(p.get("gets_seat", p.get("to_seat", ""))),
            decided_at=datetime.fromisoformat(p["decided_at"]) if p.get("decided_at") else None,
        )
        for p in payload.get("participants", [])
    ]

    dto = SwapCardJsonResponse(
        proposal_id=card.proposal_id,
        public_code=card.public_code,
        signature=encode_signature_b64(bytes(card.signature)),
        public_key=settings.swap_card_signing_public_key,
        alg="Ed25519",
        service=str(payload.get("service", "")),
        date=str(payload.get("date", "")),
        mode=payload.get("mode", "train"),
        revoked=card.revoked,
        revoked_reason=card.revoked_reason,
        confirmed_at=datetime.fromisoformat(str(payload["confirmed_at"])),
        qr_url=qr_url,
        participants=participants,
    )
    render_payload = {**payload, "revoked": card.revoked}
    return dto, render_payload, qr_url


async def verify_public_swap_card(
    *,
    settings: Settings,
    db: AsyncSession,
    code: str,
) -> PublicSwapCardVerifyResponse:
    cleaned = code.strip().upper()
    if not _PUBLIC_CODE_RE.fullmatch(cleaned):
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="invalid_swap_card_code",
            title="Invalid Swap Card Code",
            detail="Swap Card code must match SW-XXXXXX format.",
        )

    row = (
        await db.execute(
            select(SwapCard, SwapProposal)
            .join(SwapProposal, SwapProposal.id == SwapCard.proposal_id)
            .where(SwapCard.public_code == cleaned)
        )
    ).first()
    if row is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="swap_card_not_found",
            title="Swap Card Not Found",
            detail="No Swap Card found with this verification code.",
        )

    card, proposal = row
    payload = dict(card.payload_json)
    sig_verified = verify_swap_card_signature(
        payload, bytes(card.signature), settings.swap_card_signing_public_key
    )
    is_valid = (
        not card.revoked
        and sig_verified
        and proposal.status in ("confirmed", "awaiting_confirmation", "completed")
    )

    seats_parts = [
        f"{p.get('gives_seat', p.get('from_seat', ''))} ⇄ {p.get('gets_seat', p.get('to_seat', ''))}"
        for p in payload.get("participants", [])
    ]
    seats_summary = " · ".join(seats_parts)

    return PublicSwapCardVerifyResponse(
        public_code=card.public_code,
        valid=is_valid,
        revoked=card.revoked,
        revoked_reason=card.revoked_reason,
        service=str(payload.get("service", "")),
        date=str(payload.get("date", "")),
        mode=payload.get("mode", "train"),
        seats=seats_summary,
        confirmed_at=datetime.fromisoformat(str(payload["confirmed_at"])),
        signature_verified=sig_verified,
    )


async def expire_pending_swaps(
    *,
    db: AsyncSession,
    redis: Redis | None = None,
) -> int:
    now = datetime.now(UTC)
    expired = list(
        (
            await db.execute(
                select(SwapProposal).where(
                    SwapProposal.status == "pending",
                    SwapProposal.expires_at <= now,
                )
            )
        )
        .scalars()
        .all()
    )
    if not expired:
        return 0

    prop_ids = [p.id for p in expired]
    ji_ids = {p.journey_instance_id for p in expired}
    for prop in expired:
        prop.status = "expired"
        prop.version += 1

    await db.execute(delete(SeatLock).where(SeatLock.proposal_id.in_(prop_ids)))

    parts = list(
        (await db.execute(select(SwapParticipant).where(SwapParticipant.proposal_id.in_(prop_ids))))
        .scalars()
        .all()
    )
    notified: set[tuple[UUID, UUID]] = set()
    for p in parts:
        if p.user_id is not None and (p.proposal_id, p.user_id) not in notified:
            notified.add((p.proposal_id, p.user_id))
            db.add(
                NotificationsOutbox(
                    user_id=p.user_id,
                    event="SwapExpired",
                    payload={"swap_id": str(p.proposal_id)},
                    idempotency_key=f"swap_expired:{p.proposal_id}:{p.user_id}",
                )
            )

    await db.commit()

    by_prop: dict[UUID, set[UUID]] = {}
    for p in parts:
        if p.user_id is not None:
            by_prop.setdefault(p.proposal_id, set()).add(p.user_id)
    for prop in expired:
        await _publish_swap_updated(
            redis,
            proposal=prop,
            user_ids=by_prop.get(prop.id, set()),
        )

    from saath_api.matching.service import schedule_or_run_match_recompute

    for ji_id in ji_ids:
        await schedule_or_run_match_recompute(db=db, redis=redis, journey_instance_id=ji_id)
    return len(expired)


async def transition_awaiting_confirmations(
    *,
    db: AsyncSession,
) -> int:
    cutoff = datetime.now(UTC) - timedelta(hours=1)
    rows = list(
        (
            await db.execute(
                select(SwapProposal)
                .join(
                    JourneyInstance,
                    JourneyInstance.id == SwapProposal.journey_instance_id,
                )
                .where(
                    SwapProposal.status == "confirmed",
                    JourneyInstance.arrival_at.is_not(None),
                    JourneyInstance.arrival_at <= cutoff,
                )
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return 0

    prop_ids = [p.id for p in rows]
    for prop in rows:
        prop.status = "awaiting_confirmation"
        prop.version += 1

    parts = list(
        (await db.execute(select(SwapParticipant).where(SwapParticipant.proposal_id.in_(prop_ids))))
        .scalars()
        .all()
    )
    notified: set[tuple[UUID, UUID]] = set()
    for p in parts:
        if p.user_id is not None and (p.proposal_id, p.user_id) not in notified:
            notified.add((p.proposal_id, p.user_id))
            db.add(
                NotificationsOutbox(
                    user_id=p.user_id,
                    event="PostJourneyConfirmPrompt",
                    payload={"swap_id": str(p.proposal_id)},
                    idempotency_key=f"post_confirm_prompt:{p.proposal_id}:{p.user_id}",
                )
            )
    await db.commit()
    return len(rows)
