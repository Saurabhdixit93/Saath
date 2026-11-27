from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from saath_api.matching.graph import (
    SeatNode,
    SwapGraph,
    _matches_preferred_seats,
    check_segment_overlap,
    is_seated_and_unlocked,
    is_verified_female,
)
from saath_api.matching.scoring import bayesian_reliability


@dataclass(frozen=True)
class PartyBayPlan:
    party_id: UUID
    target_coach: str
    target_bay: int | None
    cycles: tuple[tuple[UUID, ...], ...]
    all_seat_holders: tuple[UUID, ...]
    score: int
    reasons: tuple[str, ...]
    reason_codes: tuple[str, ...]
    segment_overlap: str


def _solve_bipartite_assignment(
    movers: list[SeatNode],
    externals: list[SeatNode],
    edge_scores: dict[tuple[UUID, UUID], int],
) -> list[tuple[SeatNode, SeatNode, int]]:
    """Assign each mover to at most one external seat (1-1) maximizing total score."""
    if not movers or not externals or not edge_scores:
        return []

    try:
        from ortools.sat.python import cp_model

        model = cp_model.CpModel()
        pair_vars: dict[tuple[int, int], cp_model.IntVar] = {}
        for i, m in enumerate(movers):
            for j, ext in enumerate(externals):
                if (m.seat_holder_id, ext.seat_holder_id) in edge_scores:
                    pair_vars[(i, j)] = model.new_bool_var(f"a_{i}_{j}")

        if not pair_vars:
            return []

        for i in range(len(movers)):
            row = [pair_vars[(i, j)] for j in range(len(externals)) if (i, j) in pair_vars]
            if row:
                model.add(sum(row) <= 1)
        for j in range(len(externals)):
            col = [pair_vars[(i, j)] for i in range(len(movers)) if (i, j) in pair_vars]
            if col:
                model.add(sum(col) <= 1)

        model.maximize(
            sum(
                edge_scores[(movers[i].seat_holder_id, externals[j].seat_holder_id)] * var
                for (i, j), var in pair_vars.items()
            )
        )
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 0.5
        solver.parameters.num_search_workers = 1
        status = solver.solve(model)
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            assigned: list[tuple[SeatNode, SeatNode, int]] = []
            for (i, j), var in pair_vars.items():
                if solver.boolean_value(var):
                    m = movers[i]
                    ext = externals[j]
                    assigned.append((m, ext, edge_scores[(m.seat_holder_id, ext.seat_holder_id)]))
            if assigned:
                return assigned
    except ImportError:
        pass

    # Deterministic greedy fallback
    ranked = sorted(edge_scores.items(), key=lambda kv: (-kv[1], kv[0][0].bytes, kv[0][1].bytes))
    mover_map = {m.seat_holder_id: m for m in movers}
    ext_map = {e.seat_holder_id: e for e in externals}
    used_m: set[UUID] = set()
    used_e: set[UUID] = set()
    out: list[tuple[SeatNode, SeatNode, int]] = []
    for (mid, eid), sc in ranked:
        if mid in used_m or eid in used_e:
            continue
        used_m.add(mid)
        used_e.add(eid)
        out.append((mover_map[mid], ext_map[eid], sc))
    return out


def plan_party_bay_swaps(
    graph: SwapGraph,
    party_nodes_by_party: dict[UUID, list[SeatNode]],
) -> list[PartyBayPlan]:
    """Generate atomic multi-seat bay/coach consolidation plans for together/same_coach parties."""
    plans: list[PartyBayPlan] = []
    all_active_externals = [
        n for n in graph.nodes.values() if n.goal_type is not None and is_seated_and_unlocked(n)
    ]

    for party_id, members in party_nodes_by_party.items():
        if not members:
            continue
        leader_node = next((m for m in members if m.goal_type in ("together", "same_coach")), None)
        if leader_node is None:
            continue
        gtype = leader_node.goal_type
        movers = [
            m
            for m in members
            if m.seat_holder_id in leader_node.movers and is_seated_and_unlocked(m)
        ]
        if not movers:
            continue

        # Candidate target (coach, bay) buckets where party members or helpers already sit
        targets: set[tuple[str, int | None]] = set()
        for m in members:
            if m.coach:
                targets.add((m.coach.upper(), m.bay if gtype == "together" else None))
        if not targets:
            for ext in all_active_externals[:12]:
                if ext.party_id != party_id and ext.coach:
                    targets.add((ext.coach.upper(), ext.bay if gtype == "together" else None))

        seen_plan_cycles: set[tuple[tuple[UUID, ...], ...]] = set()
        party_plans: list[PartyBayPlan] = []

        for target_coach, target_bay in sorted(
            targets, key=lambda t: (t[0], t[1] if t[1] is not None else -1)
        ):
            # Movers who are NOT yet at the target bay/coach benefit from moving there
            if gtype == "together" and target_bay is not None:
                need_move = [
                    m
                    for m in movers
                    if (m.coach or "").upper() != target_coach or m.bay != target_bay
                ]
            else:
                need_move = [m for m in movers if (m.coach or "").upper() != target_coach]

            if not need_move:
                continue

            # Candidate external helpers/seekers near target
            party_women_only = any(m.women_only for m in members)
            party_all_female = all(is_verified_female(m) for m in members)
            externals: list[SeatNode] = []
            for ext in all_active_externals:
                if ext.party_id == party_id:
                    continue
                if ext.goal_type != "open_to_help" and ext.seat_holder_id not in ext.movers:
                    continue
                if not ext.coach or ext.coach.upper() != target_coach:
                    continue
                if (
                    gtype == "together"
                    and target_bay is not None
                    and (ext.bay is None or abs(ext.bay - target_bay) > 1)
                ):
                    continue
                if party_women_only and not is_verified_female(ext):
                    continue
                if ext.women_only and not party_all_female:
                    continue
                if any(
                    pm.owner_user_id is not None
                    and ext.owner_user_id is not None
                    and (
                        (pm.owner_user_id, ext.owner_user_id) in graph.blocks
                        or (ext.owner_user_id, pm.owner_user_id) in graph.blocks
                    )
                    for pm in members
                ):
                    continue
                externals.append(ext)

            if not externals:
                continue

            edge_scores: dict[tuple[UUID, UUID], int] = {}
            partial_used = False
            for m in need_move:
                if party_women_only and not is_verified_female(m):
                    continue
                for ext in externals:
                    if (
                        m.owner_user_id
                        and ext.owner_user_id
                        and (
                            (m.owner_user_id, ext.owner_user_id) in graph.blocks
                            or (ext.owner_user_id, m.owner_user_id) in graph.blocks
                        )
                    ):
                        continue
                    if gtype == "together" and target_bay is not None:
                        if ext.bay is None or abs(ext.bay - target_bay) > 1:
                            continue
                        if (
                            (m.coach or "").upper() == target_coach
                            and m.bay is not None
                            and abs(ext.bay - target_bay) >= abs(m.bay - target_bay)
                        ):
                            continue
                    overlap = check_segment_overlap(m, ext)
                    ext_overlap = check_segment_overlap(ext, m)
                    if overlap is None or ext_overlap is None:
                        continue
                    if m.verified_only and ext.trust_tier == "declared":
                        continue
                    if ext.verified_only and m.trust_tier == "declared":
                        continue
                    if m.no_middle and (ext.seat_type or "").upper() in ("MB", "SM", "MS"):
                        continue
                    if ext.no_middle and (m.seat_type or "").upper() in ("MB", "SM", "MS"):
                        continue
                    if (m.women_only or party_women_only) and not is_verified_female(ext):
                        continue
                    if ext.women_only and not is_verified_female(m):
                        continue
                    if m.same_coach_only and (m.coach or "").upper() != (ext.coach or "").upper():
                        continue
                    if ext.same_coach_only and (ext.coach or "").upper() != (m.coach or "").upper():
                        continue

                    # Check if external accepts mover's seat (open_to_help or compatible goal)
                    m_coach = (m.coach or "").upper()
                    m_stype = (m.seat_type or "").upper()
                    ext_accepts = False
                    if ext.goal_type == "open_to_help":
                        if ext.standing_give_to == "women" and not is_verified_female(m):
                            ext_accepts = False
                        else:
                            ext_accepts = True
                    elif (
                        ext.goal_type == "lower"
                        and m_stype in ("LB", "SL")
                        or ext.goal_type == "upper"
                        and m_stype in ("UB", "SU")
                        or ext.goal_type == "window"
                        and m_stype == "WS"
                        or ext.goal_type == "aisle"
                        and m_stype == "AS"
                        or ext.goal_type == "specific_seats"
                        and _matches_preferred_seats(m, ext.preferred_seats)
                        or ext.goal_type == "legroom"
                        and (m.is_exit_row or m_stype in ("SL", "LB"))
                        or ext.goal_type == "together"
                        and (
                            (m.bay is not None and (m_coach, m.bay) in ext.party_coach_bays)
                            or (m_coach in ext.party_coaches)
                        )
                    ):
                        ext_accepts = True

                    if not ext_accepts:
                        continue

                    bay_bonus = (
                        20
                        if (target_bay is not None and ext.bay == target_bay)
                        else (
                            10
                            if target_bay is not None
                            and ext.bay is not None
                            and abs(ext.bay - target_bay) <= 1
                            else 0
                        )
                    )
                    rel = round(
                        bayesian_reliability(ext.reliability_accepted, ext.reliability_completed)
                        * 15
                    )
                    pen = 10 if (overlap == "partial" or ext_overlap == "partial") else 0
                    if pen:
                        partial_used = True
                    pair_score = max(35, min(98, 65 + bay_bonus + rel - pen))
                    edge_scores[(m.seat_holder_id, ext.seat_holder_id)] = pair_score

            assigned = _solve_bipartite_assignment(need_move, externals, edge_scores)
            if not assigned:
                continue

            # Enforce plan-wide women_only & pairwise blocks across all assigned pairs
            assigned.sort(
                key=lambda item: (
                    -item[2],
                    item[0].seat_holder_id.bytes,
                    item[1].seat_holder_id.bytes,
                )
            )
            kept: list[tuple[SeatNode, SeatNode, int]] = []
            for m, ext, sc in assigned:
                cand_nodes = [
                    *members,
                    *(km for km, _, _ in kept),
                    *(ke for _, ke, _ in kept),
                    m,
                    ext,
                ]
                if any(n.women_only for n in cand_nodes) and not all(
                    is_verified_female(n) for n in cand_nodes
                ):
                    continue
                if any(
                    a.owner_user_id is not None
                    and b.owner_user_id is not None
                    and (
                        (a.owner_user_id, b.owner_user_id) in graph.blocks
                        or (b.owner_user_id, a.owner_user_id) in graph.blocks
                    )
                    for a in (m, ext)
                    for b in (*members, *(km for km, _, _ in kept), *(ke for _, ke, _ in kept))
                ):
                    continue
                kept.append((m, ext, sc))
            assigned = kept
            if not assigned:
                continue

            cycles_tuple = tuple((m.seat_holder_id, ext.seat_holder_id) for m, ext, _ in assigned)
            if cycles_tuple in seen_plan_cycles:
                continue
            seen_plan_cycles.add(cycles_tuple)

            flat_ids: list[UUID] = []
            for cyc in cycles_tuple:
                flat_ids.extend(cyc)

            avg_score = round(sum(sc for _, _, sc in assigned) / len(assigned))
            reasons = [
                f"Brings {len(assigned)} party swap(s) into Coach {target_coach}"
                + (f" Bay {target_bay}" if target_bay is not None else ""),
                "Verified co-traveller seats available in target coach",
            ]
            reason_codes = ["party_bay_plan", "same_coach"]

            party_plans.append(
                PartyBayPlan(
                    party_id=party_id,
                    target_coach=target_coach,
                    target_bay=target_bay,
                    cycles=cycles_tuple,
                    all_seat_holders=tuple(flat_ids),
                    score=avg_score,
                    reasons=tuple(reasons),
                    reason_codes=tuple(reason_codes),
                    segment_overlap="partial" if partial_used else "full",
                )
            )

        party_plans.sort(key=lambda p: (-p.score, len(p.cycles)))
        plans.extend(party_plans[:5])

    return plans
