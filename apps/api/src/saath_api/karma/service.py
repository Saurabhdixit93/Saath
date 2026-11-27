from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

import structlog
from fastapi import status
from sqlalchemy import case, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.admin.models import FeatureFlag
from saath_api.auth.dependencies import Actor
from saath_api.auth.models import AuditLog, Device, User
from saath_api.core.config import KarmaConfig, YamlConfigBundle, load_yaml_configs
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.karma.models import Badge, KarmaLedger, RewardItem, RewardRedemption
from saath_api.karma.schemas import (
    KarmaBadgeDTO,
    KarmaLedgerEntryDTO,
    KarmaWalletResponse,
    LeaderboardEntryDTO,
    RedeemRewardRequest,
    RedeemRewardResponse,
    RewardItemDTO,
    RewardRedemptionDTO,
    RewardsCatalogueResponse,
)
from saath_api.notifications.models import NotificationsOutbox
from saath_api.parties.models import Goal, PartyMember
from saath_api.providers.flight.layouts import validate_and_classify_flight_seat
from saath_api.swaps.models import SwapParticipant, SwapProposal

logger = structlog.get_logger(__name__)

_IST = ZoneInfo("Asia/Kolkata")

BADGE_CATALOG: dict[str, dict[str, str]] = {
    "first_swap": {
        "title_en": "First Swap",
        "title_hi": "पहली अदला-बदली",
        "desc_en": "Completed your first verified seat swap on Saath.",
        "desc_hi": "साथ पर अपना पहला सत्यापित सीट स्वैप पूरा किया।",
    },
    "senior_saviour": {
        "title_en": "Senior Saviour",
        "title_hi": "वरिष्ठ सहायक",
        "desc_en": "Gave up a lower or side-lower berth for a senior traveller.",
        "desc_hi": "वरिष्ठ यात्री के लिए लोअर या साइड-लोअर बर्थ दी।",
    },
    "family_uniter": {
        "title_en": "Family Uniter",
        "title_hi": "परिवार मिलन",
        "desc_en": "Helped a family or group sit together on the same journey.",
        "desc_hi": "एक ही यात्रा में परिवार या समूह को साथ बैठने में मदद की।",
    },
    "night_owl": {
        "title_en": "Night Owl",
        "title_hi": "रात्रि प्रहरी",
        "desc_en": "Completed a late-night or early-morning swap (22:00–06:00 IST).",
        "desc_hi": "देर रात या तड़के सुबह (22:00–06:00 IST) स्वैप पूरा किया।",
    },
    "ten_swaps": {
        "title_en": "Ten Swaps",
        "title_hi": "दस अदला-बदली",
        "desc_en": "Completed 10 verified seat swaps across trains or flights.",
        "desc_hi": "ट्रेन या फ्लाइट में 10 सत्यापित सीट स्वैप पूरे किए।",
    },
}


@dataclass(frozen=True)
class _ParticipantContext:
    participant: SwapParticipant
    seat_holder: SeatHolder
    booking: Booking
    user: User | None
    party_id: UUID | None
    party_size: int
    has_together_goal: bool


def _resolve_karma_config(yaml_configs: YamlConfigBundle | None) -> KarmaConfig:
    bundle = yaml_configs or load_yaml_configs()
    return bundle.karma


async def _load_participant_contexts(
    db: AsyncSession,
    parts: list[SwapParticipant],
) -> list[_ParticipantContext]:
    if not parts:
        return []

    sh_ids = [p.seat_holder_id for p in parts]
    sh_rows = (
        await db.execute(
            select(SeatHolder, Booking)
            .join(Booking, Booking.id == SeatHolder.booking_id)
            .where(SeatHolder.id.in_(sh_ids))
        )
    ).all()
    sh_map: dict[UUID, tuple[SeatHolder, Booking]] = {sh.id: (sh, bk) for sh, bk in sh_rows}

    uids = {p.user_id for p in parts if p.user_id is not None}
    user_map: dict[UUID, User] = {}
    if uids:
        users = (await db.execute(select(User).where(User.id.in_(uids)))).scalars().all()
        user_map = {u.id: u for u in users}

    pm_rows = (
        await db.execute(
            select(PartyMember.seat_holder_id, PartyMember.party_id).where(
                PartyMember.seat_holder_id.in_(sh_ids)
            )
        )
    ).all()
    party_by_sh: dict[UUID, UUID] = {sh_id: pid for sh_id, pid in pm_rows}
    party_ids = set(party_by_sh.values())

    party_sizes: dict[UUID, int] = {}
    together_parties: set[UUID] = set()
    if party_ids:
        size_rows = (
            await db.execute(
                select(PartyMember.party_id, func.count(PartyMember.seat_holder_id))
                .where(PartyMember.party_id.in_(party_ids))
                .group_by(PartyMember.party_id)
            )
        ).all()
        party_sizes = {pid: int(cnt) for pid, cnt in size_rows}

        goal_rows = (
            await db.execute(
                select(Goal.party_id)
                .where(
                    Goal.party_id.in_(party_ids),
                    Goal.goal_type == "together",
                )
                .distinct()
            )
        ).all()
        together_parties = {pid for (pid,) in goal_rows}

    contexts: list[_ParticipantContext] = []
    for p in parts:
        pair = sh_map.get(p.seat_holder_id)
        if pair is None:
            continue
        sh, bk = pair
        pid = party_by_sh.get(sh.id)
        contexts.append(
            _ParticipantContext(
                participant=p,
                seat_holder=sh,
                booking=bk,
                user=user_map.get(p.user_id) if p.user_id is not None else None,
                party_id=pid,
                party_size=party_sizes.get(pid, 1) if pid is not None else 1,
                has_together_goal=pid in together_parties if pid is not None else False,
            )
        )
    return contexts


def _calculate_seat_base_points(
    ctx: _ParticipantContext,
    ji: JourneyInstance,
    karma_config: KarmaConfig,
) -> int:
    p = ctx.participant
    sh = ctx.seat_holder
    bk = ctx.booking
    stype = (p.gives_seat_type or sh.seat_type or "").strip().upper()

    if ji.mode == "flight":
        fmap = karma_config.flight
        is_exit_row = False
        seat_no = (sh.seat_no or "").strip()
        if seat_no:
            try:
                classified = validate_and_classify_flight_seat(
                    ji.layout_ref,
                    seat_no,
                    carrier_code=ji.carrier_code,
                )
                is_exit_row = classified.is_exit_row
                if not stype:
                    stype = classified.seat_type
            except ValueError:
                is_exit_row = False
        if is_exit_row:
            return int(fmap.get("EXIT", 100))
        if stype in ("WS", "W"):
            return int(fmap.get("W", 100))
        if stype in ("AS", "A"):
            return int(fmap.get("A", 75))
        if stype in ("MS", "M"):
            return int(fmap.get("M", 50))
        return int(fmap.get("M", 50))

    tmap = karma_config.train
    if stype in tmap:
        return int(tmap[stype])
    tclass = (bk.travel_class or "").strip().upper()
    if tclass in tmap:
        return int(tmap[tclass])
    return 50


def calculate_participant_karma(
    *,
    user_id: UUID,
    proposal: SwapProposal,
    contexts: list[_ParticipantContext],
    ji: JourneyInstance,
    karma_config: KarmaConfig,
) -> int:
    my_ctxs = [c for c in contexts if c.participant.user_id == user_id]
    if not my_ctxs:
        return 0

    other_ctxs = [c for c in contexts if c.participant.user_id != user_id]
    base_points = max(_calculate_seat_base_points(c, ji, karma_config) for c in my_ctxs)
    total = base_points

    gives_lower_to_senior = any(
        (m.participant.gives_seat_type or m.seat_holder.seat_type or "").upper() in ("LB", "SL")
        and o.seat_holder.age_band == "senior"
        and (o.participant.gets_seat_type or "").upper() in ("LB", "SL")
        and bool(m.participant.gives_seat)
        and m.participant.gives_seat == o.participant.gets_seat
        for m in my_ctxs
        for o in other_ctxs
    )
    if gives_lower_to_senior:
        total += int(karma_config.bonus.get("helped_senior", 25))

    helped_solo_woman = any(
        c.party_size == 1
        and (
            c.seat_holder.gender_band == "F"
            or (c.user is not None and c.user.gender_self == "female")
        )
        for c in other_ctxs
    )
    if helped_solo_woman:
        total += int(karma_config.bonus.get("helped_solo_woman", 25))

    is_cycle = proposal.kind in ("cycle3", "cycle4", "plan") or len(contexts) >= 3
    if is_cycle:
        total += int(karma_config.bonus.get("cycle_participant", 10))

    return max(0, int(total))


async def record_pending_for_proposal(
    *,
    db: AsyncSession,
    proposal: SwapProposal,
    parts: list[SwapParticipant],
    ji: JourneyInstance,
    yaml_configs: YamlConfigBundle | None = None,
) -> None:
    karma_config = _resolve_karma_config(yaml_configs)
    contexts = await _load_participant_contexts(db, parts)
    distinct_uids = sorted(
        {p.user_id for p in parts if p.user_id is not None},
        key=str,
    )
    for uid in distinct_uids:
        pts = calculate_participant_karma(
            user_id=uid,
            proposal=proposal,
            contexts=contexts,
            ji=ji,
            karma_config=karma_config,
        )
        if pts <= 0:
            continue
        stmt = (
            pg_insert(KarmaLedger)
            .values(
                user_id=uid,
                proposal_id=proposal.id,
                delta=pts,
                state="pending",
                reason="swap_confirmed_pending",
            )
            .on_conflict_do_nothing(constraint="uq_karma_ledger_user_proposal_state")
        )
        await db.execute(stmt)


async def _find_device_collusion_pairs(
    db: AsyncSession,
    user_ids: set[UUID],
) -> set[UUID]:
    if len(user_ids) < 2:
        return set()
    rows = (
        await db.execute(
            select(Device.user_id, Device.push_endpoint, Device.push_p256dh).where(
                Device.user_id.in_(user_ids)
            )
        )
    ).all()

    by_endpoint: dict[str, set[UUID]] = {}
    by_p256dh: dict[str, set[UUID]] = {}
    for uid, endpoint, p256dh in rows:
        if endpoint and endpoint.strip():
            by_endpoint.setdefault(endpoint.strip(), set()).add(uid)
        if p256dh and p256dh.strip():
            by_p256dh.setdefault(p256dh.strip(), set()).add(uid)

    colluding: set[UUID] = set()
    for uids in by_endpoint.values():
        if len(uids) >= 2:
            colluding.update(uids)
    for uids in by_p256dh.values():
        if len(uids) >= 2:
            colluding.update(uids)
    return colluding


async def _has_recent_same_pair_credit(
    db: AsyncSession,
    *,
    user_id: UUID,
    other_user_ids: set[UUID],
    current_proposal_id: UUID,
    cutoff: datetime,
    limit: int,
) -> bool:
    if not other_user_ids or limit <= 0:
        return False

    prior_prop_ids = (
        (
            await db.execute(
                select(KarmaLedger.proposal_id)
                .where(
                    KarmaLedger.user_id == user_id,
                    KarmaLedger.state == "credited",
                    KarmaLedger.proposal_id.is_not(None),
                    KarmaLedger.proposal_id != current_proposal_id,
                    KarmaLedger.created_at >= cutoff,
                )
                .distinct()
            )
        )
        .scalars()
        .all()
    )

    clean_prop_ids = [pid for pid in prior_prop_ids if pid is not None]
    if not clean_prop_ids:
        return False

    reversed_prop_ids = set(
        (
            await db.execute(
                select(KarmaLedger.proposal_id).where(
                    KarmaLedger.user_id == user_id,
                    KarmaLedger.state == "reversed",
                    KarmaLedger.proposal_id.in_(clean_prop_ids),
                )
            )
        )
        .scalars()
        .all()
    )
    active_prior_ids = [pid for pid in clean_prop_ids if pid not in reversed_prop_ids]
    if not active_prior_ids:
        return False

    overlapping_count = (
        await db.execute(
            select(func.count(func.distinct(SwapParticipant.proposal_id))).where(
                SwapParticipant.proposal_id.in_(active_prior_ids),
                SwapParticipant.user_id.in_(other_user_ids),
            )
        )
    ).scalar_one()
    return int(overlapping_count) >= limit


async def credit_for_completed_proposal(
    *,
    db: AsyncSession,
    proposal: SwapProposal,
    parts: list[SwapParticipant],
    ji: JourneyInstance,
    yaml_configs: YamlConfigBundle | None = None,
) -> dict[UUID, int]:
    karma_config = _resolve_karma_config(yaml_configs)
    contexts = await _load_participant_contexts(db, parts)
    distinct_uids = sorted(
        {p.user_id for p in parts if p.user_id is not None},
        key=str,
    )
    if not distinct_uids:
        return {}

    colluding_uids = await _find_device_collusion_pairs(db, set(distinct_uids))
    now = datetime.now(UTC)
    pair_cutoff = now - timedelta(days=90)
    day_cutoff = now - timedelta(hours=24)

    awarded_map: dict[UUID, int] = {}

    for uid in distinct_uids:
        existing_credit = (
            await db.execute(
                select(KarmaLedger.id).where(
                    KarmaLedger.user_id == uid,
                    KarmaLedger.proposal_id == proposal.id,
                    KarmaLedger.state == "credited",
                )
            )
        ).scalar_one_or_none()
        if existing_credit is not None:
            continue

        if uid in colluding_uids:
            db.add(
                AuditLog(
                    actor="system:karma",
                    action="karma.collusion_blocked",
                    resource=f"swap:{proposal.id}",
                    meta={"user_id": str(uid), "reason": "shared_device_push_key"},
                )
            )
            continue

        other_uids = {other for other in distinct_uids if other != uid}
        if await _has_recent_same_pair_credit(
            db,
            user_id=uid,
            other_user_ids=other_uids,
            current_proposal_id=proposal.id,
            cutoff=pair_cutoff,
            limit=karma_config.caps.same_pair_per_90d,
        ):
            db.add(
                AuditLog(
                    actor="system:karma",
                    action="karma.same_pair_cap_blocked",
                    resource=f"swap:{proposal.id}",
                    meta={
                        "user_id": str(uid),
                        "cap_days": 90,
                        "limit": karma_config.caps.same_pair_per_90d,
                    },
                )
            )
            continue

        raw_points = calculate_participant_karma(
            user_id=uid,
            proposal=proposal,
            contexts=contexts,
            ji=ji,
            karma_config=karma_config,
        )
        if raw_points <= 0:
            continue

        net_today_raw = (
            await db.execute(
                select(func.coalesce(func.sum(KarmaLedger.delta), 0)).where(
                    KarmaLedger.user_id == uid,
                    KarmaLedger.state.in_(("credited", "reversed")),
                    KarmaLedger.created_at >= day_cutoff,
                )
            )
        ).scalar_one()
        net_today = max(0, int(net_today_raw))
        remaining_daily = max(0, karma_config.caps.per_user_per_day - net_today)
        awarded = min(raw_points, remaining_daily)
        if awarded <= 0:
            db.add(
                AuditLog(
                    actor="system:karma",
                    action="karma.daily_cap_blocked",
                    resource=f"swap:{proposal.id}",
                    meta={
                        "user_id": str(uid),
                        "daily_cap": karma_config.caps.per_user_per_day,
                        "net_today": net_today,
                    },
                )
            )
            continue

        insert_stmt = (
            pg_insert(KarmaLedger)
            .values(
                user_id=uid,
                proposal_id=proposal.id,
                delta=awarded,
                state="credited",
                reason="swap_completed",
            )
            .on_conflict_do_nothing(constraint="uq_karma_ledger_user_proposal_state")
            .returning(KarmaLedger.id)
        )
        inserted_id = (await db.execute(insert_stmt)).scalar_one_or_none()
        if inserted_id is not None:
            awarded_map[uid] = awarded
            db.add(
                NotificationsOutbox(
                    user_id=uid,
                    event="KarmaCredited",
                    payload={
                        "swap_id": str(proposal.id),
                        "points": awarded,
                    },
                    idempotency_key=f"karma_credited:{proposal.id}:{uid}",
                )
            )

    return awarded_map


async def reverse_for_proposal(
    *,
    db: AsyncSession,
    proposal_id: UUID,
    reason: str = "swap_disputed",
) -> list[UUID]:
    credited_rows = (
        (
            await db.execute(
                select(KarmaLedger).where(
                    KarmaLedger.proposal_id == proposal_id,
                    KarmaLedger.state == "credited",
                    KarmaLedger.user_id.is_not(None),
                )
            )
        )
        .scalars()
        .all()
    )

    reversed_uids: list[UUID] = []
    for row in credited_rows:
        if row.user_id is None:
            continue
        rev_amount = -abs(int(row.delta))
        stmt = (
            pg_insert(KarmaLedger)
            .values(
                user_id=row.user_id,
                proposal_id=proposal_id,
                delta=rev_amount,
                state="reversed",
                reason=reason,
            )
            .on_conflict_do_nothing(constraint="uq_karma_ledger_user_proposal_state")
            .returning(KarmaLedger.id)
        )
        inserted = (await db.execute(stmt)).scalar_one_or_none()
        if inserted is not None:
            reversed_uids.append(row.user_id)
            db.add(
                NotificationsOutbox(
                    user_id=row.user_id,
                    event="KarmaReversed",
                    payload={
                        "swap_id": str(proposal_id),
                        "points": abs(rev_amount),
                        "reason": reason,
                    },
                    idempotency_key=f"karma_reversed:{proposal_id}:{row.user_id}",
                )
            )
    return reversed_uids


def _is_night_owl_timestamp(dt: datetime | None) -> bool:
    if dt is None:
        return False
    aware = dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)
    hour = aware.astimezone(_IST).hour
    return hour >= 22 or hour < 6


async def evaluate_and_award_badges(
    *,
    db: AsyncSession,
    proposal: SwapProposal,
    parts: list[SwapParticipant],
    ji: JourneyInstance,
) -> dict[UUID, list[str]]:
    contexts = await _load_participant_contexts(db, parts)
    distinct_uids = sorted(
        {p.user_id for p in parts if p.user_id is not None},
        key=str,
    )
    if not distinct_uids:
        return {}

    has_family_group = proposal.kind == "plan" or any(
        c.has_together_goal or c.party_size >= 2 for c in contexts
    )
    is_night_owl = _is_night_owl_timestamp(ji.departure_at) or _is_night_owl_timestamp(
        proposal.confirmed_at
    )

    users = (await db.execute(select(User).where(User.id.in_(distinct_uids)))).scalars().all()
    user_map = {u.id: u for u in users}

    awarded_badges: dict[UUID, list[str]] = {}

    for uid in distinct_uids:
        to_award: list[str] = []
        user = user_map.get(uid)
        completed_count = int(user.reliability_completed) if user is not None else 0
        if completed_count < 1:
            cnt_row = (
                await db.execute(
                    select(func.count(func.distinct(SwapProposal.id)))
                    .join(SwapParticipant, SwapParticipant.proposal_id == SwapProposal.id)
                    .where(
                        SwapParticipant.user_id == uid,
                        SwapProposal.status == "completed",
                    )
                )
            ).scalar_one()
            completed_count = int(cnt_row)

        if completed_count >= 1:
            to_award.append("first_swap")
        if completed_count >= 10:
            to_award.append("ten_swaps")

        my_ctxs = [c for c in contexts if c.participant.user_id == uid]
        other_ctxs = [c for c in contexts if c.participant.user_id != uid]
        gives_lower_to_senior = any(
            (m.participant.gives_seat_type or m.seat_holder.seat_type or "").upper() in ("LB", "SL")
            and o.seat_holder.age_band == "senior"
            and (o.participant.gets_seat_type or "").upper() in ("LB", "SL")
            and bool(m.participant.gives_seat)
            and m.participant.gives_seat == o.participant.gets_seat
            for m in my_ctxs
            for o in other_ctxs
        )
        if gives_lower_to_senior:
            to_award.append("senior_saviour")

        if has_family_group:
            to_award.append("family_uniter")

        if is_night_owl:
            to_award.append("night_owl")

        newly_inserted: list[str] = []
        for code in to_award:
            stmt = (
                pg_insert(Badge)
                .values(user_id=uid, code=code)
                .on_conflict_do_nothing(index_elements=[Badge.user_id, Badge.code])
                .returning(Badge.code)
            )
            inserted = (await db.execute(stmt)).scalar_one_or_none()
            if inserted is not None:
                newly_inserted.append(code)
                db.add(
                    NotificationsOutbox(
                        user_id=uid,
                        event="BadgeUnlocked",
                        payload={
                            "swap_id": str(proposal.id),
                            "badge_code": code,
                        },
                        idempotency_key=f"badge_unlocked:{uid}:{code}",
                    )
                )
        if newly_inserted:
            awarded_badges[uid] = newly_inserted

    return awarded_badges


async def get_karma_wallet(
    *,
    db: AsyncSession,
    actor: Actor,
) -> KarmaWalletResponse:
    if actor.kind != "user" or actor.user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_auth_required",
            title="Phone Verification Required",
            detail="Verify your phone number to view your Karma wallet.",
        )

    user = (await db.execute(select(User).where(User.id == actor.user_id))).scalar_one_or_none()
    locale = user.locale if user is not None and user.locale == "hi" else "en"

    ledger_rows = (
        (
            await db.execute(
                select(KarmaLedger)
                .where(KarmaLedger.user_id == actor.user_id)
                .order_by(KarmaLedger.created_at.desc(), KarmaLedger.id.desc())
            )
        )
        .scalars()
        .all()
    )

    settled_proposal_ids: set[UUID] = {
        row.proposal_id
        for row in ledger_rows
        if row.proposal_id is not None and row.state in ("credited", "reversed")
    }
    pending_proposal_ids: list[UUID] = [
        row.proposal_id
        for row in ledger_rows
        if row.state == "pending"
        and row.proposal_id is not None
        and row.proposal_id not in settled_proposal_ids
    ]
    active_pending_props: set[UUID] = set()
    if pending_proposal_ids:
        active_pending_props = set(
            (
                await db.execute(
                    select(SwapProposal.id).where(
                        SwapProposal.id.in_(pending_proposal_ids),
                        SwapProposal.status.in_(("confirmed", "awaiting_confirmation")),
                    )
                )
            )
            .scalars()
            .all()
        )

    credited_sum = sum(row.delta for row in ledger_rows if row.state == "credited")
    reversed_abs_sum = sum(abs(row.delta) for row in ledger_rows if row.state == "reversed")
    balance = credited_sum - reversed_abs_sum

    pending_sum = sum(
        row.delta
        for row in ledger_rows
        if row.state == "pending"
        and row.proposal_id is not None
        and row.proposal_id in active_pending_props
    )

    redeemed_raw = (
        await db.execute(
            select(func.coalesce(func.sum(RewardRedemption.points_spent), 0)).where(
                RewardRedemption.user_id == actor.user_id,
                RewardRedemption.status.in_(("pending", "approved", "fulfilled")),
            )
        )
    ).scalar_one()
    redeemed_points = int(redeemed_raw)
    available_balance = max(0, balance - redeemed_points)

    history = [
        KarmaLedgerEntryDTO(
            id=int(row.id),
            proposal_id=row.proposal_id,
            delta=int(row.delta),
            points=abs(int(row.delta)),
            state=row.state,
            reason=row.reason or row.state,
            created_at=row.created_at,
        )
        for row in ledger_rows
    ]

    badge_rows = (
        (
            await db.execute(
                select(Badge)
                .where(Badge.user_id == actor.user_id)
                .order_by(Badge.earned_at.asc(), Badge.code.asc())
            )
        )
        .scalars()
        .all()
    )
    badges: list[KarmaBadgeDTO] = []
    for b in badge_rows:
        meta = BADGE_CATALOG.get(b.code)
        title = (
            (meta["title_hi"] if locale == "hi" else meta["title_en"])
            if meta
            else b.code.replace("_", " ").title()
        )
        desc = (meta["desc_hi"] if locale == "hi" else meta["desc_en"]) if meta else b.code
        badges.append(
            KarmaBadgeDTO(
                code=b.code,
                title=title,
                description=desc,
                earned_at=b.earned_at,
            )
        )

    points_expr = func.coalesce(
        func.sum(
            case(
                (KarmaLedger.state == "credited", KarmaLedger.delta),
                (KarmaLedger.state == "reversed", -func.abs(KarmaLedger.delta)),
                else_=0,
            )
        ),
        0,
    )
    lb_rows = (
        await db.execute(
            select(
                User.display_alias,
                User.reliability_completed,
                points_expr.label("points"),
            )
            .outerjoin(KarmaLedger, KarmaLedger.user_id == User.id)
            .where(
                User.leaderboard_opt_in.is_(True),
                User.status == "active",
                User.erased_at.is_(None),
                User.deleted_at.is_(None),
            )
            .group_by(User.id, User.display_alias, User.reliability_completed, User.created_at)
            .order_by(
                points_expr.desc(),
                User.reliability_completed.desc(),
                User.created_at.asc(),
            )
            .limit(20)
        )
    ).all()

    leaderboard: list[LeaderboardEntryDTO] = []
    for idx, (alias, swaps_completed, pts) in enumerate(lb_rows, start=1):
        clean_alias = (
            alias.strip() if isinstance(alias, str) and alias.strip() else "Saath Traveller"
        )
        leaderboard.append(
            LeaderboardEntryDTO(
                rank=idx,
                display_alias=clean_alias,
                points=int(pts),
                swaps_completed=int(swaps_completed),
            )
        )

    return KarmaWalletResponse(
        balance=balance,
        pending=pending_sum,
        redeemed_points=redeemed_points,
        available_balance=available_balance,
        history=history,
        badges=badges,
        leaderboard=leaderboard,
    )


async def _is_rewards_catalogue_enabled(db: AsyncSession) -> bool:
    flag = (
        await db.execute(select(FeatureFlag).where(FeatureFlag.key == "rewards_catalogue_enabled"))
    ).scalar_one_or_none()
    if flag is None:
        return False
    if isinstance(flag.value, bool):
        return flag.value
    if isinstance(flag.value, dict):
        return bool(flag.value.get("enabled", False))
    return False


def _require_rewards_enabled(enabled: bool) -> None:
    if not enabled:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="rewards_disabled",
            title="Rewards Catalogue Disabled",
            detail="The Karma rewards catalogue is not enabled in this environment.",
        )


async def get_rewards_catalogue(
    *,
    db: AsyncSession,
    actor: Actor,
) -> RewardsCatalogueResponse:
    if actor.kind != "user" or actor.user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_auth_required",
            title="Phone Verification Required",
            detail="Verify your phone number to view Karma rewards.",
        )

    enabled = await _is_rewards_catalogue_enabled(db)
    _require_rewards_enabled(enabled)

    items = (
        (
            await db.execute(
                select(RewardItem)
                .where(RewardItem.active.is_(True))
                .order_by(RewardItem.cost_points.asc(), RewardItem.code.asc())
            )
        )
        .scalars()
        .all()
    )

    redemptions_rows = (
        await db.execute(
            select(RewardRedemption, RewardItem.code)
            .join(RewardItem, RewardItem.id == RewardRedemption.reward_item_id)
            .where(RewardRedemption.user_id == actor.user_id)
            .order_by(RewardRedemption.created_at.desc())
        )
    ).all()

    return RewardsCatalogueResponse(
        enabled=True,
        items=[
            RewardItemDTO(
                code=item.code,
                title_en=item.title_en,
                title_hi=item.title_hi,
                description_en=item.description_en,
                description_hi=item.description_hi,
                cost_points=int(item.cost_points),
                stock=int(item.stock) if item.stock is not None else None,
            )
            for item in items
        ],
        redemptions=[
            RewardRedemptionDTO(
                id=red.id,
                reward_code=code,
                points_spent=int(red.points_spent),
                status=red.status,
                created_at=red.created_at,
            )
            for red, code in redemptions_rows
        ],
    )


async def redeem_reward(
    *,
    db: AsyncSession,
    actor: Actor,
    req: RedeemRewardRequest,
) -> RedeemRewardResponse:
    if actor.kind != "user" or actor.user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_auth_required",
            title="Phone Verification Required",
            detail="Verify your phone number to redeem Karma rewards.",
        )

    enabled = await _is_rewards_catalogue_enabled(db)
    _require_rewards_enabled(enabled)

    # Lock caller user row to serialize concurrent redemptions for the same account.
    await db.execute(select(User.id).where(User.id == actor.user_id).with_for_update())

    item = (
        await db.execute(
            select(RewardItem).where(RewardItem.code == req.reward_code.strip()).with_for_update()
        )
    ).scalar_one_or_none()
    if item is None or not item.active:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="reward_not_found",
            title="Reward Not Found",
            detail="The requested reward item is not available.",
        )

    if item.stock is not None and item.stock <= 0:
        raise ProblemDetailError(
            status_code=status.HTTP_409_CONFLICT,
            code="reward_out_of_stock",
            title="Reward Out of Stock",
            detail="This reward item is currently out of stock.",
        )

    ledger_sum_raw = (
        await db.execute(
            select(
                func.coalesce(
                    func.sum(
                        case(
                            (KarmaLedger.state == "credited", KarmaLedger.delta),
                            (KarmaLedger.state == "reversed", -func.abs(KarmaLedger.delta)),
                            else_=0,
                        )
                    ),
                    0,
                )
            ).where(KarmaLedger.user_id == actor.user_id)
        )
    ).scalar_one()
    redeemed_raw = (
        await db.execute(
            select(func.coalesce(func.sum(RewardRedemption.points_spent), 0)).where(
                RewardRedemption.user_id == actor.user_id,
                RewardRedemption.status.in_(("pending", "approved", "fulfilled")),
            )
        )
    ).scalar_one()
    available = int(ledger_sum_raw) - int(redeemed_raw)
    if available < item.cost_points:
        raise ProblemDetailError(
            status_code=status.HTTP_409_CONFLICT,
            code="insufficient_karma",
            title="Insufficient Karma Points",
            detail=(
                f"You need {item.cost_points} Karma points to redeem this reward "
                f"(available: {max(0, available)})."
            ),
        )

    if item.stock is not None:
        item.stock -= 1

    redemption = RewardRedemption(
        id=uuid7(),
        user_id=actor.user_id,
        reward_item_id=item.id,
        points_spent=item.cost_points,
        status="pending",
    )
    db.add(redemption)
    await db.flush()

    db.add(
        NotificationsOutbox(
            user_id=actor.user_id,
            event="RewardRedemptionRequested",
            payload={
                "redemption_id": str(redemption.id),
                "reward_code": item.code,
                "points_spent": int(item.cost_points),
            },
            idempotency_key=f"reward_redemption:{redemption.id}",
        )
    )
    await db.commit()
    await db.refresh(redemption)

    return RedeemRewardResponse(
        id=redemption.id,
        reward_code=item.code,
        points_spent=int(redemption.points_spent),
        status=redemption.status,
        created_at=redemption.created_at,
    )
