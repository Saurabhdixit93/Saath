from __future__ import annotations

import uuid
from uuid import UUID

from hypothesis import given, settings
from hypothesis import strategies as st

from saath_api.matching.cycles import build_swap_graph, enumerate_bounded_cycles
from saath_api.matching.graph import (
    MIDDLE_SEAT_TYPES,
    SeatNode,
    is_verified_female,
)
from saath_api.matching.packing import pack_disjoint_cycles

_SEAT_TYPES = ("LB", "MB", "UB", "SL", "SU")
_GOAL_TYPES = ("lower", "upper", "same_coach", "open_to_help")
_TRUST_TIERS = ("verified_provider", "verified_bcbp", "verified_doc", "declared")
_GENDERS = ("F", "M", "U")
_AGES = ("adult", "senior", "child", "unknown")


@st.composite
def seat_nodes_strategy(draw: st.DrawFn) -> tuple[list[SeatNode], frozenset[tuple[UUID, UUID]]]:
    count = draw(st.integers(min_value=2, max_value=14))
    nodes: list[SeatNode] = []
    user_ids: list[UUID] = [uuid.uuid5(uuid.NAMESPACE_DNS, f"user-{i}") for i in range(count)]

    for i in range(count):
        sh_id = uuid.uuid5(uuid.NAMESPACE_DNS, f"sh-{i}")
        party_id = uuid.uuid5(uuid.NAMESPACE_DNS, f"party-{i}")
        booking_id = uuid.uuid5(uuid.NAMESPACE_DNS, f"bk-{i}")
        coach = draw(st.sampled_from(("B1", "B2", "B3")))
        seat_no = str((i * 5) % 72 + 1)
        seat_type = draw(st.sampled_from(_SEAT_TYPES))
        bay = ((int(seat_no) - 1) // 8) + 1
        gender_band = draw(st.sampled_from(_GENDERS))
        user_gender_self = (
            "female" if gender_band == "F" else ("male" if gender_band == "M" else "undisclosed")
        )
        trust = draw(st.sampled_from(_TRUST_TIERS))
        from_seq = draw(st.integers(min_value=1, max_value=4))
        to_seq = draw(st.integers(min_value=from_seq + 1, max_value=7))
        goal = draw(st.sampled_from(_GOAL_TYPES))

        women_only = draw(st.booleans()) if gender_band == "F" else False
        no_middle = draw(st.booleans())
        same_coach_only = draw(st.booleans())
        verified_only = draw(st.booleans())

        nodes.append(
            SeatNode(
                seat_holder_id=sh_id,
                party_id=party_id,
                booking_id=booking_id,
                owner_user_id=user_ids[i],
                owner_anon_id=None,
                coach=coach,
                seat_no=seat_no,
                seat_type=seat_type,
                bay=bay,
                age_band=draw(st.sampled_from(_AGES)),
                gender_band=gender_band,
                user_gender_self=user_gender_self,
                trust_tier=trust,
                from_seq=from_seq,
                to_seq=to_seq,
                goal_type=goal,
                movers=frozenset({sh_id}),
                women_only=women_only,
                no_middle=no_middle,
                same_coach_only=same_coach_only,
                verified_only=verified_only,
                standing_give_to="anyone" if goal == "open_to_help" else None,
            )
        )

    blocks_list: list[tuple[UUID, UUID]] = []
    if count >= 2 and draw(st.booleans()):
        a = draw(st.integers(min_value=0, max_value=count - 1))
        b = draw(st.integers(min_value=0, max_value=count - 1))
        if a != b:
            blocks_list.append((user_ids[a], user_ids[b]))

    return nodes, frozenset(blocks_list)


@given(data=seat_nodes_strategy())
@settings(max_examples=80, deadline=None)
def test_matching_graph_and_cycle_invariants(
    data: tuple[list[SeatNode], frozenset[tuple[UUID, UUID]]],
) -> None:
    nodes, blocks = data
    graph = build_swap_graph(nodes, blocks=blocks)
    cycles = enumerate_bounded_cycles(graph)
    packed = pack_disjoint_cycles(cycles, graph.nodes)

    # 1. Packed cycles are node-disjoint
    seen_packed: set[UUID] = set()
    for cyc in packed:
        for uid in cyc.nodes:
            assert uid not in seen_packed
            seen_packed.add(uid)

    # 2. Every candidate cycle satisfies all constraints and invariants
    for cyc in cycles:
        n = len(cyc.nodes)
        assert 2 <= n <= 4
        # No duplicate nodes
        assert len(set(cyc.nodes)) == n
        # Score bounds
        assert 0 <= cyc.score <= 100

        # Declared trust tier is strictly 2-cycles only
        if any(graph.nodes[uid].trust_tier == "declared" for uid in cyc.nodes):
            assert n == 2

        for idx, uid in enumerate(cyc.nodes):
            u = graph.nodes[uid]
            v = graph.nodes[cyc.nodes[(idx + 1) % n]]

            # Blocks excluded
            if u.owner_user_id and v.owner_user_id:
                assert (u.owner_user_id, v.owner_user_id) not in blocks
                assert (v.owner_user_id, u.owner_user_id) not in blocks

            # Segment overlap must be non-empty
            if u.from_seq is not None and u.to_seq is not None and v.from_seq is not None and v.to_seq is not None:
                assert not (u.to_seq <= v.from_seq or v.to_seq <= u.from_seq)

            # Constraints
            if u.women_only:
                assert is_verified_female(v)
            if u.no_middle:
                assert (v.seat_type or "") not in MIDDLE_SEAT_TYPES
            if u.same_coach_only:
                assert (u.coach or "") == (v.coach or "")
            if u.verified_only:
                assert v.trust_tier != "declared"
