from __future__ import annotations

import json
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

import structlog
from fastapi import status
from redis.asyncio import Redis
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor
from saath_api.auth.models import User
from saath_api.core.config import YamlConfigBundle
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7
from saath_api.journeys.geometry import build_coach_layout, normalize_coach_class
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.journeys.service import _load_actor_journey_context
from saath_api.matching.cycles import (
    CandidateCycle,
    build_swap_graph,
    enumerate_bounded_cycles,
)
from saath_api.matching.graph import (
    SeatNode,
    SwapGraph,
    format_seat_descriptor,
    make_pseudonymous_alias,
)
from saath_api.matching.models import Block, MatchCandidate
from saath_api.matching.packing import pack_disjoint_cycles
from saath_api.matching.party import PartyBayPlan, plan_party_bay_swaps
from saath_api.matching.schemas import (
    CoachMapResponse,
    CoachMapSeatDTO,
    MatchCardDTO,
    MatchesResponse,
    MatchKarmaPreviewDTO,
    MatchOtherDTO,
    MatchSegmentDTO,
    YouGetDTO,
)
from saath_api.matching.scoring import (
    estimate_karma_preview,
    estimate_responsiveness,
    format_reliability_text,
    score_to_label,
)
from saath_api.parties.models import Goal, Party, PartyMember
from saath_api.parties.service import _load_party_and_actor_membership
from saath_api.providers.flight.layouts import (
    _seat_type_for_column,
    resolve_aircraft_layout,
)
from saath_api.providers.rail.router import ProviderRouter
from saath_api.swaps.models import SeatLock

logger = structlog.get_logger(__name__)

_COMPUTED_MARKER_TTL_SECONDS = 300


@dataclass(frozen=True)
class ComputedMatchOutput:
    graph: SwapGraph
    all_cycles: list[CandidateCycle]
    packed_cycles: list[CandidateCycle]
    party_plans: list[PartyBayPlan]
    elapsed_ms: float


def compute_matches_in_memory(
    nodes: list[SeatNode],
    *,
    blocks: frozenset[tuple[UUID, UUID]] = frozenset(),
) -> ComputedMatchOutput:
    """Pure in-memory OR-Tools matching pipeline (used by service & benchmark/property tests)."""
    t0 = time.perf_counter()
    graph = build_swap_graph(nodes, blocks=blocks, max_out_degree=25)
    all_cycles = enumerate_bounded_cycles(graph, max_cycle_len=4, max_cycles_per_root=30)
    packed_cycles = pack_disjoint_cycles(all_cycles, graph.nodes, time_limit_seconds=1.0)

    by_party: dict[UUID, list[SeatNode]] = defaultdict(list)
    for n in nodes:
        by_party[n.party_id].append(n)
    party_plans = plan_party_bay_swaps(graph, by_party)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    return ComputedMatchOutput(
        graph=graph,
        all_cycles=all_cycles,
        packed_cycles=packed_cycles,
        party_plans=party_plans,
        elapsed_ms=elapsed_ms,
    )


async def _load_journey_nodes(
    db: AsyncSession,
    journey_instance_id: UUID,
    *,
    mode: str,
    layout_ref: str | None,
) -> tuple[list[SeatNode], frozenset[tuple[UUID, UUID]], dict[UUID, set[UUID]]]:
    rows = (
        await db.execute(
            select(SeatHolder, Booking, PartyMember.party_id)
            .join(Booking, Booking.id == SeatHolder.booking_id)
            .join(PartyMember, PartyMember.seat_holder_id == SeatHolder.id)
            .where(Booking.journey_instance_id == journey_instance_id)
        )
    ).all()

    if not rows:
        return [], frozenset(), {}

    party_ids = {party_id for _, _, party_id in rows}
    goals_res = await db.execute(
        select(Goal).where(Goal.party_id.in_(party_ids), Goal.active.is_(True))
    )
    goal_by_party: dict[UUID, Goal] = {g.party_id: g for g in goals_res.scalars().all()}

    sh_ids = [sh.id for sh, _, _ in rows]
    locked_res = await db.execute(
        select(SeatLock.seat_holder_id).where(SeatLock.seat_holder_id.in_(sh_ids))
    )
    locked_ids = set(locked_res.scalars().all())

    user_ids: set[UUID] = set()
    party_user_ids: dict[UUID, set[UUID]] = defaultdict(set)
    for sh, booking, party_id in rows:
        uid = sh.linked_user_id or booking.owner_user_id
        if uid is not None:
            user_ids.add(uid)
            party_user_ids[party_id].add(uid)

    users_by_id: dict[UUID, User] = {}
    blocks_set: set[tuple[UUID, UUID]] = set()
    if user_ids:
        u_res = await db.execute(select(User).where(User.id.in_(user_ids)))
        users_by_id = {u.id: u for u in u_res.scalars().all()}

        b_res = await db.execute(
            select(Block).where(
                Block.blocker.in_(user_ids) | Block.blocked.in_(user_ids)
            )
        )
        for blk in b_res.scalars().all():
            blocks_set.add((blk.blocker, blk.blocked))

    # Build party coach/bay maps
    party_coaches: dict[UUID, set[str]] = defaultdict(set)
    party_coach_bays: dict[UUID, set[tuple[str, int]]] = defaultdict(set)
    for sh, _, party_id in rows:
        if sh.coach:
            party_coaches[party_id].add(sh.coach.upper())
            if sh.bay is not None:
                party_coach_bays[party_id].add((sh.coach.upper(), int(sh.bay)))

    exit_rows: frozenset[int] = frozenset()
    if mode == "flight":
        spec = resolve_aircraft_layout(layout_ref)
        exit_rows = spec.exit_rows

    nodes: list[SeatNode] = []
    for sh, booking, party_id in rows:
        goal = goal_by_party.get(party_id)
        uid = sh.linked_user_id or booking.owner_user_id
        user_obj = users_by_id.get(uid) if uid else None
        constraints = (goal.constraints or {}) if goal else {}
        standing = (goal.standing_offer or {}) if goal and goal.standing_offer else {}
        is_exit = bool(mode == "flight" and sh.bay is not None and sh.bay in exit_rows)

        nodes.append(
            SeatNode(
                seat_holder_id=sh.id,
                party_id=party_id,
                booking_id=booking.id,
                owner_user_id=uid,
                owner_anon_id=booking.owner_anon_id,
                coach=sh.coach,
                seat_no=sh.seat_no,
                seat_type=sh.seat_type,
                bay=sh.bay,
                age_band=sh.age_band,
                gender_band=sh.gender_band,
                user_gender_self=user_obj.gender_self if user_obj else None,
                trust_tier=booking.trust_tier,
                from_seq=booking.from_seq,
                to_seq=booking.to_seq,
                goal_type=goal.goal_type if goal else None,
                movers=frozenset(goal.movers) if goal else frozenset(),
                preferred_seats=frozenset(s.strip().upper() for s in goal.preferred_seats)
                if goal
                else frozenset(),
                women_only=bool(constraints.get("women_only", False)),
                no_middle=bool(constraints.get("no_middle", False)),
                same_coach_only=bool(constraints.get("same_coach_only", False)),
                verified_only=bool(constraints.get("verified_only", False)),
                standing_give_to=str(standing.get("give_to"))
                if standing.get("give_to")
                else None,
                reliability_accepted=user_obj.reliability_accepted if user_obj else 0,
                reliability_completed=user_obj.reliability_completed if user_obj else 0,
                is_locked=sh.id in locked_ids,
                current_status=sh.current_status,
                is_exit_row=is_exit,
                mode=mode,
                party_coach_bays=frozenset(party_coach_bays[party_id]),
                party_coaches=frozenset(party_coaches[party_id]),
            )
        )

    return nodes, frozenset(blocks_set), party_user_ids


async def recompute_journey_matches(
    *,
    db: AsyncSession,
    redis: Redis | None,
    journey_instance_id: UUID,
    publish_events: bool = True,
) -> int:
    ji = (
        await db.execute(
            select(JourneyInstance).where(JourneyInstance.id == journey_instance_id)
        )
    ).scalar_one_or_none()
    if ji is None:
        return 0

    lock_key = f"lock:match:{journey_instance_id}"
    lock_acquired = False
    if redis is not None:
        try:
            lock_acquired = bool(await redis.set(lock_key, "1", nx=True, ex=10))
        except Exception:
            lock_acquired = False

    try:
        nodes, blocks, party_user_ids = await _load_journey_nodes(
            db, journey_instance_id, mode=ji.mode, layout_ref=ji.layout_ref
        )
        computed = compute_matches_in_memory(nodes, blocks=blocks)
        packed_set = {c.nodes for c in computed.packed_cycles}

        await db.execute(
            delete(MatchCandidate).where(
                MatchCandidate.journey_instance_id == journey_instance_id,
                MatchCandidate.match_version == ji.match_version,
            )
        )
        await db.execute(
            delete(MatchCandidate).where(
                MatchCandidate.journey_instance_id == journey_instance_id,
                MatchCandidate.match_version < ji.match_version - 2,
            )
        )

        # Group cycles per party (packed global cycles boosted to top, plus up to 20 alternatives)
        party_cycles: dict[UUID, list[CandidateCycle]] = defaultdict(list)
        for cyc in computed.all_cycles:
            involved_parties = {computed.graph.nodes[uid].party_id for uid in cyc.nodes}
            for pid in involved_parties:
                party_cycles[pid].append(cyc)

        seen_cards_per_party: dict[UUID, set[tuple[UUID, ...]]] = defaultdict(set)
        candidates_to_add: list[MatchCandidate] = []

        # Emit party bay plans first for together/same_coach parties
        for plan in computed.party_plans:
            candidates_to_add.append(
                MatchCandidate(
                    id=uuid7(),
                    journey_instance_id=journey_instance_id,
                    match_version=ji.match_version,
                    for_party_id=plan.party_id,
                    card_id=f"mc_{uuid7().hex}",
                    cycle_seat_holders=list(plan.all_seat_holders),
                    plan_cycles={
                        "target_coach": plan.target_coach,
                        "target_bay": plan.target_bay,
                        "cycles": [[str(u) for u in cyc] for cyc in plan.cycles],
                        "segment_overlap": plan.segment_overlap,
                        "reason_codes": list(plan.reason_codes),
                    },
                    score=plan.score,
                    reasons=list(plan.reasons),
                    kind="plan",
                )
            )

        for pid, cyc_list in party_cycles.items():
            # Only emit match cards for parties with an active goal
            party_nodes = [n for n in nodes if n.party_id == pid]
            if not any(n.goal_type is not None for n in party_nodes):
                continue

            cyc_list.sort(
                key=lambda c: (
                    0 if c.nodes in packed_set else 1,
                    -c.score,
                    len(c.nodes),
                )
            )
            emitted = 0
            for cyc in cyc_list:
                if cyc.nodes in seen_cards_per_party[pid]:
                    continue
                seen_cards_per_party[pid].add(cyc.nodes)
                candidates_to_add.append(
                    MatchCandidate(
                        id=uuid7(),
                        journey_instance_id=journey_instance_id,
                        match_version=ji.match_version,
                        for_party_id=pid,
                        card_id=f"mc_{uuid7().hex}",
                        cycle_seat_holders=list(cyc.nodes),
                        plan_cycles={
                            "segment_overlap": cyc.segment_overlap,
                            "reason_codes": list(cyc.reason_codes),
                        },
                        score=cyc.score,
                        reasons=list(cyc.reasons),
                        kind=cyc.kind,
                    )
                )
                emitted += 1
                if emitted >= 20:
                    break

        for cand in candidates_to_add:
            db.add(cand)
        await db.commit()

        if redis is not None:
            try:
                await redis.set(
                    f"match:computed:{journey_instance_id}:{ji.match_version}",
                    "1",
                    ex=_COMPUTED_MARKER_TTL_SECONDS,
                )
                if publish_events:
                    for pid, uids in party_user_ids.items():
                        event_payload = json.dumps(
                            {
                                "type": "match.updated",
                                "party_id": str(pid),
                                "journey_instance_id": str(journey_instance_id),
                                "match_version": ji.match_version,
                            }
                        )
                        for uid in uids:
                            await redis.publish(f"user:{uid}", event_payload)
            except Exception:
                logger.warning(
                    "match_redis_publish_failed",
                    journey_instance_id=str(journey_instance_id),
                )

        logger.info(
            "matches_recomputed",
            journey_instance_id=str(journey_instance_id),
            match_version=ji.match_version,
            node_count=len(nodes),
            candidate_count=len(candidates_to_add),
            elapsed_ms=round(computed.elapsed_ms, 2),
        )
        return ji.match_version
    finally:
        if redis is not None and lock_acquired:
            try:
                await redis.delete(lock_key)
            except Exception:
                pass


async def schedule_or_run_match_recompute(
    *,
    db: AsyncSession,
    redis: Redis | None,
    journey_instance_id: UUID,
) -> None:
    """Recompute matches after a state transition so results & WS events are immediately fresh."""
    await recompute_journey_matches(
        db=db,
        redis=redis,
        journey_instance_id=journey_instance_id,
        publish_events=True,
    )


async def _ensure_matches_computed_for_version(
    *,
    db: AsyncSession,
    redis: Redis | None,
    ji: JourneyInstance,
    party_id: UUID,
) -> None:
    marker_exists = False
    if redis is not None:
        try:
            marker_exists = bool(
                await redis.get(f"match:computed:{ji.id}:{ji.match_version}")
            )
        except Exception:
            marker_exists = False

    if marker_exists:
        return

    existing_any = (
        await db.execute(
            select(MatchCandidate.id)
            .where(
                MatchCandidate.journey_instance_id == ji.id,
                MatchCandidate.match_version == ji.match_version,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if existing_any is not None:
        return

    await recompute_journey_matches(
        db=db,
        redis=redis,
        journey_instance_id=ji.id,
        publish_events=False,
    )


def _node_by_seat_holder_map(nodes: list[SeatNode]) -> dict[UUID, SeatNode]:
    return {n.seat_holder_id: n for n in nodes}


async def get_party_matches(
    *,
    db: AsyncSession,
    redis: Redis | None,
    yaml_configs: YamlConfigBundle,
    actor: Actor,
    party_id: UUID,
    kind: Literal["pair", "cycle", "plan"] | None = None,
) -> MatchesResponse:
    party, ji, _ = await _load_party_and_actor_membership(
        db=db, actor=actor, party_id=party_id
    )
    await _ensure_matches_computed_for_version(
        db=db, redis=redis, ji=ji, party_id=party.id
    )

    stmt = (
        select(MatchCandidate)
        .where(
            MatchCandidate.for_party_id == party.id,
            MatchCandidate.match_version == ji.match_version,
        )
        .order_by(MatchCandidate.score.desc(), MatchCandidate.created_at.asc())
    )
    if kind == "pair":
        stmt = stmt.where(MatchCandidate.kind == "pair")
    elif kind == "cycle":
        stmt = stmt.where(MatchCandidate.kind.in_(("cycle3", "cycle4")))
    elif kind == "plan":
        stmt = stmt.where(MatchCandidate.kind == "plan")

    candidates = list((await db.execute(stmt)).scalars().all())
    if not candidates:
        return MatchesResponse(match_version=ji.match_version, items=[])

    nodes, _, _ = await _load_journey_nodes(
        db, ji.id, mode=ji.mode, layout_ref=ji.layout_ref
    )
    node_map = _node_by_seat_holder_map(nodes)

    items: list[MatchCardDTO] = []
    for mc in candidates:
        # Check none of the cycle seats became locked since recompute
        cycle_nodes = [node_map.get(uid) for uid in mc.cycle_seat_holders]
        if any(n is None or n.is_locked for n in cycle_nodes):
            continue
        resolved_nodes = [n for n in cycle_nodes if n is not None]
        if not resolved_nodes:
            continue

        my_indices = [
            idx for idx, n in enumerate(resolved_nodes) if n.party_id == party.id
        ]
        if not my_indices:
            continue

        meta = mc.plan_cycles if isinstance(mc.plan_cycles, dict) else {}
        overlap: Literal["full", "partial"] = (
            "partial" if meta.get("segment_overlap") == "partial" else "full"
        )
        reason_codes = [str(c) for c in (meta.get("reason_codes") or [])]

        if mc.kind == "plan":
            raw_cycles = meta.get("cycles") or []
            my_gives: list[str] = []
            others_dtos: list[MatchOtherDTO] = []
            seen_others: set[UUID] = set()
            first_partner: SeatNode | None = None
            for cyc_str in raw_cycles:
                if not isinstance(cyc_str, list) or len(cyc_str) < 2:
                    continue
                cyc_uuids = [UUID(str(x)) for x in cyc_str]
                for idx, uid in enumerate(cyc_uuids):
                    node = node_map.get(uid)
                    if node is None:
                        continue
                    if node.party_id == party.id:
                        my_gives.append(format_seat_descriptor(node))
                        nxt = node_map.get(cyc_uuids[(idx + 1) % len(cyc_uuids)])
                        if nxt is not None and nxt.party_id != party.id and first_partner is None:
                            first_partner = nxt
                    elif uid not in seen_others:
                        seen_others.add(uid)
                        _, resp_time = estimate_responsiveness(node)
                        others_dtos.append(
                            MatchOtherDTO(
                                alias=make_pseudonymous_alias(
                                    node.coach, node.seat_type, node.seat_holder_id
                                ),
                                trust=node.trust_tier,
                                reliability=format_reliability_text(
                                    node.reliability_accepted, node.reliability_completed
                                ),
                                responds_in=resp_time,
                            )
                        )
            my_primary = node_map[resolved_nodes[my_indices[0]].seat_holder_id]
            target_coach = str(meta.get("target_coach") or (first_partner.coach if first_partner else my_primary.coach) or "B3")
            target_bay = meta.get("target_bay")
            if first_partner is None:
                first_partner = next((n for n in resolved_nodes if n.party_id != party.id), my_primary)
            you_give_str = ", ".join(my_gives[:2]) if my_gives else format_seat_descriptor(my_primary)
            you_get_dto = YouGetDTO(
                coach=target_coach,
                seat_type=(first_partner.seat_type or "LB"),
                bay=int(target_bay) if target_bay is not None else first_partner.bay,
            )
            karma_pts = estimate_karma_preview(my_primary, yaml_configs.karma, is_cycle=False)
        else:
            my_idx = my_indices[0]
            my_node = resolved_nodes[my_idx]
            nxt_node = resolved_nodes[(my_idx + 1) % len(resolved_nodes)]
            others_nodes = [
                n for idx, n in enumerate(resolved_nodes) if idx != my_idx
            ]
            you_give_str = format_seat_descriptor(my_node)
            you_get_dto = YouGetDTO(
                coach=(nxt_node.coach or "CABIN"),
                seat_type=(nxt_node.seat_type or "S"),
                bay=nxt_node.bay,
            )
            others_dtos = []
            for o in others_nodes:
                _, resp_time = estimate_responsiveness(o)
                others_dtos.append(
                    MatchOtherDTO(
                        alias=make_pseudonymous_alias(o.coach, o.seat_type, o.seat_holder_id),
                        trust=o.trust_tier,
                        reliability=format_reliability_text(
                            o.reliability_accepted, o.reliability_completed
                        ),
                        responds_in=resp_time,
                    )
                )
            karma_pts = estimate_karma_preview(
                my_node, yaml_configs.karma, is_cycle=(mc.kind in ("cycle3", "cycle4"))
            )

        items.append(
            MatchCardDTO(
                card_id=mc.card_id,
                kind=mc.kind,  # type: ignore[arg-type]
                score=int(mc.score),
                label=score_to_label(int(mc.score)),
                you_give=you_give_str,
                you_get=you_get_dto,
                others=others_dtos,
                reasons=[str(r) for r in (mc.reasons or [])],
                reason_codes=reason_codes,
                segment=MatchSegmentDTO(overlap=overlap),
                karma_preview=MatchKarmaPreviewDTO(you=karma_pts),
            )
        )

    return MatchesResponse(match_version=ji.match_version, items=items)


async def get_coach_map(
    *,
    db: AsyncSession,
    redis: Redis | None,
    rail_router: ProviderRouter,
    actor: Actor,
    journey_id: UUID,
    coach: str | None = None,
) -> CoachMapResponse:
    ji, booking, party = await _load_actor_journey_context(
        db=db, actor=actor, journey_id=journey_id
    )
    await _ensure_matches_computed_for_version(
        db=db, redis=redis, ji=ji, party_id=party.id
    )

    nodes, blocks, _ = await _load_journey_nodes(
        db, ji.id, mode=ji.mode, layout_ref=ji.layout_ref
    )
    node_map = _node_by_seat_holder_map(nodes)
    own_sh_ids = {n.seat_holder_id for n in nodes if n.booking_id == booking.id}
    party_sh_ids = {n.seat_holder_id for n in nodes if n.party_id == party.id}

    # Build match target map (seat_holder_id -> card_id) and incoming edges
    match_card_by_target: dict[UUID, str] = {}
    cand_rows = (
        await db.execute(
            select(MatchCandidate)
            .where(
                MatchCandidate.for_party_id == party.id,
                MatchCandidate.match_version == ji.match_version,
            )
            .order_by(MatchCandidate.score.desc())
        )
    ).scalars().all()

    for mc in cand_rows:
        cyc = mc.cycle_seat_holders
        for idx, uid in enumerate(cyc):
            if uid in party_sh_ids:
                nxt_id = cyc[(idx + 1) % len(cyc)]
                if nxt_id not in party_sh_ids:
                    match_card_by_target.setdefault(nxt_id, mc.card_id)

    graph = build_swap_graph(nodes, blocks=blocks)
    incoming_sh_ids: set[UUID] = set()
    for uid, out_edges in graph.edges.items():
        if uid in party_sh_ids:
            continue
        if any(e.v in party_sh_ids for e in out_edges):
            incoming_sh_ids.add(uid)

    if ji.mode == "flight":
        spec = resolve_aircraft_layout(ji.layout_ref, ji.carrier_code)
        req_coach = (coach or "CABIN").strip().upper()
        if req_coach != "CABIN":
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_coach",
                title="Invalid Cabin",
                detail=f"Unknown cabin {coach!r} for flight {ji.service_no}.",
            )
        by_seat_no: dict[str, SeatNode] = {
            (n.seat_no or "").strip().upper(): n for n in nodes if n.seat_no
        }
        seat_dtos: list[CoachMapSeatDTO] = []
        for row in range(1, spec.rows + 1):
            for col_idx, letter in enumerate(spec.columns):
                seat_no = f"{row}{letter}"
                if seat_no in spec.excluded_seats:
                    continue
                stype = _seat_type_for_column(spec, col_idx)
                occ = by_seat_no.get(seat_no)
                state: Literal["mine", "party", "match", "incoming", "occupied", "unknown"] = "unknown"
                card_id: str | None = None
                alias: str | None = None
                if occ is not None:
                    if occ.seat_holder_id in own_sh_ids:
                        state = "mine"
                    elif occ.seat_holder_id in party_sh_ids:
                        state = "party"
                    elif occ.seat_holder_id in match_card_by_target:
                        state = "match"
                        card_id = match_card_by_target[occ.seat_holder_id]
                        alias = make_pseudonymous_alias(
                            occ.coach, occ.seat_type, occ.seat_holder_id
                        )
                    elif occ.seat_holder_id in incoming_sh_ids:
                        state = "incoming"
                        alias = make_pseudonymous_alias(
                            occ.coach, occ.seat_type, occ.seat_holder_id
                        )
                    else:
                        state = "occupied"
                seat_dtos.append(
                    CoachMapSeatDTO(
                        seat_no=seat_no,
                        bay=row,
                        seat_type=stype,
                        is_side=False,
                        is_exit_row=row in spec.exit_rows,
                        is_premium=row in spec.premium_rows,
                        state=state,
                        card_id=card_id,
                        alias=alias,
                    )
                )
        return CoachMapResponse(
            journey_id=ji.id,
            mode="flight",
            coach="CABIN",
            travel_class=booking.travel_class or "Y",
            layout_ref=spec.layout_ref,
            match_version=ji.match_version,
            coaches=["CABIN"],
            seats=seat_dtos,
        )

    # Train coach map
    composition_coaches: list[str] = []
    comp_class_by_coach: dict[str, str] = {}
    try:
        comp = await rail_router.get_composition(ji.service_no, ji.service_date)
        for c in comp:
            code = c.coach.strip().upper()
            if code not in composition_coaches:
                composition_coaches.append(code)
            comp_class_by_coach[code] = c.travel_class
    except Exception:
        composition_coaches = []

    for n in nodes:
        if n.coach:
            c_up = n.coach.strip().upper()
            if c_up not in composition_coaches:
                composition_coaches.append(c_up)

    if not composition_coaches:
        composition_coaches = ["B1", "B2", "B3", "B4", "B5"]

    default_coach = next(
        (n.coach.upper() for n in nodes if n.seat_holder_id in own_sh_ids and n.coach),
        composition_coaches[0],
    )
    target_coach = (coach or default_coach).strip().upper()

    if target_coach not in composition_coaches:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="invalid_coach",
            title="Invalid Coach",
            detail=f"Coach {target_coach} is not part of train {ji.service_no}.",
        )

    tclass = normalize_coach_class(
        comp_class_by_coach.get(target_coach) or booking.travel_class,
        target_coach,
    )
    coach_spec = build_coach_layout(tclass)

    # Map occupied seats in target_coach (prefer mine/party/match if multiple segments share a physical seat)
    occupants_by_seat: dict[str, list[SeatNode]] = defaultdict(list)
    for n in nodes:
        if n.coach and n.coach.strip().upper() == target_coach and n.seat_no:
            occupants_by_seat[n.seat_no.strip().upper()].append(n)

    def _pick_occupant(cands: list[SeatNode]) -> SeatNode | None:
        if not cands:
            return None
        for n in cands:
            if n.seat_holder_id in own_sh_ids:
                return n
        for n in cands:
            if n.seat_holder_id in party_sh_ids:
                return n
        for n in cands:
            if n.seat_holder_id in match_card_by_target:
                return n
        for n in cands:
            if n.seat_holder_id in incoming_sh_ids:
                return n
        return cands[0]

    seat_dtos = []
    for slot in coach_spec.slots:
        s_key = str(slot.seat_no)
        occ = _pick_occupant(occupants_by_seat.get(s_key, []))
        state = "unknown"
        card_id = None
        alias = None
        if occ is not None:
            if occ.seat_holder_id in own_sh_ids:
                state = "mine"
            elif occ.seat_holder_id in party_sh_ids:
                state = "party"
            elif occ.seat_holder_id in match_card_by_target:
                state = "match"
                card_id = match_card_by_target[occ.seat_holder_id]
                alias = make_pseudonymous_alias(occ.coach, occ.seat_type, occ.seat_holder_id)
            elif occ.seat_holder_id in incoming_sh_ids:
                state = "incoming"
                alias = make_pseudonymous_alias(occ.coach, occ.seat_type, occ.seat_holder_id)
            else:
                state = "occupied"
        seat_dtos.append(
            CoachMapSeatDTO(
                seat_no=s_key,
                bay=slot.bay,
                seat_type=slot.seat_type,
                is_side=slot.is_side,
                is_exit_row=False,
                is_premium=False,
                state=state,
                card_id=card_id,
                alias=alias,
            )
        )

    return CoachMapResponse(
        journey_id=ji.id,
        mode="train",
        coach=target_coach,
        travel_class=coach_spec.travel_class,
        layout_ref=coach_spec.layout_ref,
        match_version=ji.match_version,
        coaches=composition_coaches,
        seats=seat_dtos,
    )
