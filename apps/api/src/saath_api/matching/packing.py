from __future__ import annotations

from collections import defaultdict
from uuid import UUID

from saath_api.matching.cycles import CandidateCycle
from saath_api.matching.graph import SeatNode, is_verified_female


def _cycle_priority_value(cycle: CandidateCycle, nodes: dict[UUID, SeatNode]) -> int:
    base = cycle.score * 10
    length_bonus = 20 if len(cycle.nodes) == 2 else (12 if len(cycle.nodes) == 3 else 6)
    social_bonus = 0
    for uid in cycle.nodes:
        node = nodes.get(uid)
        if node is None:
            continue
        if node.age_band == "senior":
            social_bonus += 8
        if node.women_only and is_verified_female(node):
            social_bonus += 6
    return base + length_bonus + social_bonus


def _greedy_pack(
    cycles: list[CandidateCycle],
    nodes: dict[UUID, SeatNode],
) -> list[CandidateCycle]:
    ranked = sorted(
        cycles,
        key=lambda c: (-_cycle_priority_value(c, nodes), len(c.nodes)),
    )
    used_nodes: set[UUID] = set()
    chosen: list[CandidateCycle] = []
    for cyc in ranked:
        if any(uid in used_nodes for uid in cyc.nodes):
            continue
        used_nodes.update(cyc.nodes)
        chosen.append(cyc)
    return chosen


def pack_disjoint_cycles(
    cycles: list[CandidateCycle],
    nodes: dict[UUID, SeatNode],
    *,
    time_limit_seconds: float = 1.0,
) -> list[CandidateCycle]:
    """Select globally optimal node-disjoint swap cycles.

    Uses OR-Tools CP-SAT with a greedy fallback.
    """
    if not cycles:
        return []

    try:
        from ortools.sat.python import cp_model
    except ImportError:
        return _greedy_pack(cycles, nodes)

    model = cp_model.CpModel()
    x_vars = [model.new_bool_var(f"c_{i}") for i in range(len(cycles))]

    node_to_cycles: dict[UUID, list[int]] = defaultdict(list)
    for idx, cyc in enumerate(cycles):
        for uid in cyc.nodes:
            node_to_cycles[uid].append(idx)

    for cyc_indices in node_to_cycles.values():
        if len(cyc_indices) > 1:
            model.add(sum(x_vars[i] for i in cyc_indices) <= 1)

    model.maximize(
        sum(_cycle_priority_value(cyc, nodes) * x_vars[i] for i, cyc in enumerate(cycles))
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_seconds
    solver.parameters.num_search_workers = 1
    status = solver.solve(model)

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return [cyc for i, cyc in enumerate(cycles) if solver.boolean_value(x_vars[i])]

    return _greedy_pack(cycles, nodes)
