from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from saath_api.matching.graph import (
    SeatNode,
    SwapEdge,
    SwapGraph,
    is_verified_female,
)
from saath_api.matching.scoring import score_directed_edge


@dataclass(frozen=True)
class CandidateCycle:
    nodes: tuple[UUID, ...]
    edges: tuple[SwapEdge, ...]
    score: int
    kind: Literal["pair", "cycle3", "cycle4"]
    reasons: tuple[str, ...]
    reason_codes: tuple[str, ...]
    segment_overlap: Literal["full", "partial"]


def _canonical_cycle_rotation(nodes: list[UUID], edges: list[SwapEdge]) -> tuple[tuple[UUID, ...], tuple[SwapEdge, ...]]:
    min_idx = min(range(len(nodes)), key=lambda idx: nodes[idx].bytes)
    rot_nodes = tuple(nodes[min_idx:] + nodes[:min_idx])
    rot_edges = tuple(edges[min_idx:] + edges[:min_idx])
    return rot_nodes, rot_edges


def build_swap_graph(
    nodes: list[SeatNode],
    *,
    blocks: frozenset[tuple[UUID, UUID]] = frozenset(),
    max_out_degree: int = 25,
) -> SwapGraph:
    node_map = {n.seat_holder_id: n for n in nodes}
    edges: dict[UUID, list[SwapEdge]] = {n.seat_holder_id: [] for n in nodes}

    active_nodes = [n for n in nodes if n.goal_type is not None]
    for u in active_nodes:
        out_edges: list[SwapEdge] = []
        for v in active_nodes:
            if u.seat_holder_id == v.seat_holder_id:
                continue
            edge = score_directed_edge(u, v, blocks=blocks)
            if edge is not None:
                out_edges.append(edge)
        out_edges.sort(key=lambda e: (-e.weight, e.v.bytes))
        edges[u.seat_holder_id] = out_edges[:max_out_degree]

    return SwapGraph(nodes=node_map, edges=edges, blocks=blocks)


def _has_block_between(
    node_a: SeatNode,
    node_b: SeatNode,
    blocks: frozenset[tuple[UUID, UUID]],
) -> bool:
    if node_a.owner_user_id is None or node_b.owner_user_id is None:
        return False
    return (node_a.owner_user_id, node_b.owner_user_id) in blocks or (
        node_b.owner_user_id,
        node_a.owner_user_id,
    ) in blocks


def enumerate_bounded_cycles(
    graph: SwapGraph,
    *,
    max_cycle_len: int = 4,
    max_cycles_per_root: int = 40,
) -> list[CandidateCycle]:
    """Bounded simple cycle enumeration (2..4 nodes) with cycle-wide safety & party invariants."""
    seen: set[tuple[UUID, ...]] = set()
    cycles: list[CandidateCycle] = []

    seekers = [
        uid
        for uid, node in graph.nodes.items()
        if node.goal_type is not None and node.goal_type != "open_to_help"
    ]
    seekers.sort(key=lambda u: u.bytes)

    for root in seekers:
        root_found = 0
        path_nodes: list[UUID] = [root]
        path_edges: list[SwapEdge] = []
        visited: set[UUID] = {root}
        visited_parties: set[UUID] = {graph.nodes[root].party_id}

        def _dfs(curr: UUID) -> None:
            nonlocal root_found
            if root_found >= max_cycles_per_root:
                return
            for edge in graph.edges.get(curr, ()):
                nxt = edge.v
                if nxt == root and len(path_nodes) >= 2:
                    cyc_len = len(path_nodes)
                    # Declared trust tier is strictly restricted to 2-cycles only
                    has_declared = any(
                        graph.nodes[uid].trust_tier == "declared" for uid in path_nodes
                    )
                    if has_declared and cyc_len > 2:
                        continue
                    # Enforce distinct seat_holders and distinct party_ids across the cycle
                    if len(set(path_nodes)) != cyc_len:
                        continue
                    if len({graph.nodes[uid].party_id for uid in path_nodes}) != cyc_len:
                        continue
                    # Cycle-wide women_only invariant: if ANY member requires women_only, ALL must be verified female
                    if any(graph.nodes[uid].women_only for uid in path_nodes) and not all(
                        is_verified_female(graph.nodes[uid]) for uid in path_nodes
                    ):
                        continue
                    # Cycle-wide blocks invariant: no pair of members in the cycle may have a block
                    if any(
                        _has_block_between(
                            graph.nodes[path_nodes[i]],
                            graph.nodes[path_nodes[j]],
                            graph.blocks,
                        )
                        for i in range(cyc_len)
                        for j in range(i + 1, cyc_len)
                    ):
                        continue
                    all_edges = [*path_edges, edge]
                    rot_nodes, rot_edges = _canonical_cycle_rotation(path_nodes, all_edges)
                    if rot_nodes in seen:
                        continue
                    seen.add(rot_nodes)
                    root_found += 1

                    avg_weight = sum(e.weight for e in rot_edges) / cyc_len
                    # Mutual preference / cycle bonus
                    mutual_bonus = 6 if cyc_len == 2 else 3
                    int_score = max(0, min(100, round(avg_weight * 100) + mutual_bonus))
                    kind: Literal["pair", "cycle3", "cycle4"] = (
                        "pair" if cyc_len == 2 else ("cycle3" if cyc_len == 3 else "cycle4")
                    )
                    seg_overlap: Literal["full", "partial"] = (
                        "partial"
                        if any(e.segment_overlap == "partial" for e in rot_edges)
                        else "full"
                    )
                    merged_reasons: list[str] = []
                    merged_codes: list[str] = []
                    if cyc_len == 2:
                        merged_codes.append("mutual_preference")
                        merged_reasons.append("Mutual seat preference match")
                    else:
                        merged_codes.append(f"{cyc_len}_way_cycle")
                        merged_reasons.append(f"{cyc_len}-way verified cycle swap")
                    for e in rot_edges:
                        for rc in e.reason_codes:
                            if rc not in merged_codes:
                                merged_codes.append(rc)
                        for r in e.reasons:
                            if r not in merged_reasons:
                                merged_reasons.append(r)

                    cycles.append(
                        CandidateCycle(
                            nodes=rot_nodes,
                            edges=rot_edges,
                            score=int_score,
                            kind=kind,
                            reasons=tuple(merged_reasons[:4]),
                            reason_codes=tuple(merged_codes[:4]),
                            segment_overlap=seg_overlap,
                        )
                    )
                elif nxt not in visited and len(path_nodes) < max_cycle_len:
                    nxt_node = graph.nodes[nxt]
                    # Reject extending a cycle with a seat_holder from a party already in path_nodes
                    if nxt_node.party_id in visited_parties:
                        continue
                    # Also forbid declared intermediates before extending past 2
                    if len(path_nodes) >= 2 and (
                        graph.nodes[root].trust_tier == "declared"
                        or nxt_node.trust_tier == "declared"
                        or any(graph.nodes[uid].trust_tier == "declared" for uid in path_nodes)
                    ):
                        continue
                    # Cycle-wide women_only check during DFS extension
                    if any(graph.nodes[uid].women_only for uid in path_nodes) and not is_verified_female(
                        nxt_node
                    ):
                        continue
                    if nxt_node.women_only and any(
                        not is_verified_female(graph.nodes[uid]) for uid in path_nodes
                    ):
                        continue
                    # Cycle-wide blocks check during DFS extension
                    if any(
                        _has_block_between(nxt_node, graph.nodes[uid], graph.blocks)
                        for uid in path_nodes
                    ):
                        continue
                    visited.add(nxt)
                    visited_parties.add(nxt_node.party_id)
                    path_nodes.append(nxt)
                    path_edges.append(edge)
                    _dfs(nxt)
                    path_edges.pop()
                    path_nodes.pop()
                    visited_parties.remove(nxt_node.party_id)
                    visited.remove(nxt)

        _dfs(root)

    cycles.sort(key=lambda c: (-c.score, len(c.nodes), tuple(u.bytes for u in c.nodes)))
    return cycles
