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
from saath_api.matching.party import plan_party_bay_swaps

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
                standing_give_to=draw(st.sampled_from(("anyone", "senior", "women")))
                if goal == "open_to_help"
                else None,
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
        # No duplicate nodes and no duplicate party_ids
        assert len(set(cyc.nodes)) == n
        assert len({graph.nodes[uid].party_id for uid in cyc.nodes}) == n
        # Score bounds
        assert 0 <= cyc.score <= 100

        # Declared trust tier is strictly 2-cycles only
        if any(graph.nodes[uid].trust_tier == "declared" for uid in cyc.nodes):
            assert n == 2

        # Cycle-wide women_only: if ANY node has women_only, ALL must be verified female
        if any(graph.nodes[uid].women_only for uid in cyc.nodes):
            assert all(is_verified_female(graph.nodes[uid]) for uid in cyc.nodes)

        # Cycle-wide blocks: no pair (i, j) in the cycle may have a block
        for i in range(n):
            for j in range(i + 1, n):
                u_i = graph.nodes[cyc.nodes[i]]
                u_j = graph.nodes[cyc.nodes[j]]
                if u_i.owner_user_id and u_j.owner_user_id:
                    assert (u_i.owner_user_id, u_j.owner_user_id) not in blocks
                    assert (u_j.owner_user_id, u_i.owner_user_id) not in blocks

        for idx, uid in enumerate(cyc.nodes):
            u = graph.nodes[uid]
            v = graph.nodes[cyc.nodes[(idx + 1) % n]]

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


def _make_node(
    idx: int,
    *,
    party_idx: int | None = None,
    seat_type: str = "LB",
    seat_no: str | None = None,
    gender_band: str = "F",
    user_gender_self: str = "female",
    goal_type: str = "open_to_help",
    women_only: bool = False,
    preferred_seats: frozenset[str] = frozenset(),
) -> SeatNode:
    sh_id = uuid.uuid5(uuid.NAMESPACE_DNS, f"reg-sh-{idx}")
    return SeatNode(
        seat_holder_id=sh_id,
        party_id=uuid.uuid5(uuid.NAMESPACE_DNS, f"reg-party-{party_idx if party_idx is not None else idx}"),
        booking_id=uuid.uuid5(uuid.NAMESPACE_DNS, f"reg-bk-{idx}"),
        owner_user_id=uuid.uuid5(uuid.NAMESPACE_DNS, f"reg-user-{idx}"),
        owner_anon_id=None,
        coach="B3",
        seat_no=seat_no or str(idx),
        seat_type=seat_type,
        bay=1,
        age_band="adult",
        gender_band=gender_band,
        user_gender_self=user_gender_self,
        trust_tier="verified_provider",
        from_seq=1,
        to_seq=5,
        goal_type=goal_type,
        movers=frozenset({sh_id}),
        preferred_seats=preferred_seats,
        women_only=women_only,
        standing_give_to="anyone" if goal_type == "open_to_help" else None,
    )


def test_3way_women_only_rejects_male_non_adjacent_node() -> None:
    # A (F, women_only=True) -> B (F, women_only=False) -> C (M) -> A
    # Even though direct edges A->B, B->C, C->A are locally valid, A requires women_only cycle-wide.
    n_a = _make_node(1, seat_type="UB", seat_no="3", gender_band="F", user_gender_self="female", goal_type="lower", women_only=True)
    n_b = _make_node(2, seat_type="LB", seat_no="1", gender_band="F", user_gender_self="female", goal_type="specific_seats", preferred_seats=frozenset({"B3-2"}))
    n_c = _make_node(3, seat_type="MB", seat_no="2", gender_band="M", user_gender_self="male", goal_type="upper")
    graph = build_swap_graph([n_a, n_b, n_c])
    cycles = enumerate_bounded_cycles(graph)
    assert all(
        not (any(graph.nodes[u].women_only for u in c.nodes) and any(not is_verified_female(graph.nodes[u]) for u in c.nodes))
        for c in cycles
    )
    assert len(cycles) == 0


def test_4way_blocks_rejects_non_adjacent_blocked_pair() -> None:
    # 1 -> 2 -> 3 -> 4 -> 1 where user 1 blocked user 3 (non-adjacent)
    n1 = _make_node(1, seat_no="1", goal_type="specific_seats", preferred_seats=frozenset({"B3-2"}))
    n2 = _make_node(2, seat_no="2", goal_type="specific_seats", preferred_seats=frozenset({"B3-3"}))
    n3 = _make_node(3, seat_no="3", goal_type="specific_seats", preferred_seats=frozenset({"B3-4"}))
    n4 = _make_node(4, seat_no="4", goal_type="specific_seats", preferred_seats=frozenset({"B3-1"}))
    assert n1.owner_user_id is not None and n3.owner_user_id is not None
    blocks = frozenset({(n1.owner_user_id, n3.owner_user_id)})
    graph = build_swap_graph([n1, n2, n3, n4], blocks=blocks)
    cycles = enumerate_bounded_cycles(graph)
    assert cycles == []


def test_4way_same_party_id_never_mixed_in_non_plan_cycle() -> None:
    # A1 (party 0) -> B1 (party 1) -> A2 (party 0) -> B2 (party 2) -> A1
    a1 = _make_node(1, party_idx=0, seat_no="1", goal_type="specific_seats", preferred_seats=frozenset({"B3-2"}))
    b1 = _make_node(2, party_idx=1, seat_no="2", goal_type="specific_seats", preferred_seats=frozenset({"B3-3"}))
    a2 = _make_node(3, party_idx=0, seat_no="3", goal_type="specific_seats", preferred_seats=frozenset({"B3-4"}))
    b2 = _make_node(4, party_idx=2, seat_no="4", goal_type="specific_seats", preferred_seats=frozenset({"B3-1"}))
    graph = build_swap_graph([a1, b1, a2, b2])
    cycles = enumerate_bounded_cycles(graph)
    for cyc in cycles:
        assert len({graph.nodes[u].party_id for u in cyc.nodes}) == len(cyc.nodes)
    assert cycles == []


def test_standing_offer_give_to_women_excludes_male_seeker() -> None:
    helper = SeatNode(
        seat_holder_id=uuid.uuid5(uuid.NAMESPACE_DNS, "so-h"),
        party_id=uuid.uuid5(uuid.NAMESPACE_DNS, "so-ph"),
        booking_id=uuid.uuid5(uuid.NAMESPACE_DNS, "so-bh"),
        owner_user_id=uuid.uuid5(uuid.NAMESPACE_DNS, "so-uh"),
        owner_anon_id=None,
        coach="B3",
        seat_no="1",
        seat_type="LB",
        bay=1,
        age_band="adult",
        gender_band="M",
        user_gender_self="male",
        trust_tier="verified_provider",
        from_seq=1,
        to_seq=5,
        goal_type="open_to_help",
        movers=frozenset({uuid.uuid5(uuid.NAMESPACE_DNS, "so-h")}),
        standing_give_to="women",
    )
    male_seeker = _make_node(
        10,
        seat_type="UB",
        seat_no="3",
        gender_band="M",
        user_gender_self="male",
        goal_type="lower",
    )
    female_seeker = _make_node(
        11,
        seat_type="UB",
        seat_no="6",
        gender_band="F",
        user_gender_self="female",
        goal_type="lower",
    )
    graph = build_swap_graph([helper, male_seeker, female_seeker])
    cycles = enumerate_bounded_cycles(graph)
    assert len(cycles) == 1
    assert set(cycles[0].nodes) == {helper.seat_holder_id, female_seeker.seat_holder_id}


def test_party_bay_plan_enforces_women_only_blocks_and_no_split_when_together() -> None:
    p_sh1 = uuid.uuid5(uuid.NAMESPACE_DNS, "pb-m1")
    p_sh2 = uuid.uuid5(uuid.NAMESPACE_DNS, "pb-m2")
    party_id = uuid.uuid5(uuid.NAMESPACE_DNS, "pb-party")
    # Case 1: Both party members already in (B3, bay 1) -> must NOT split apart
    m1_together = SeatNode(
        seat_holder_id=p_sh1,
        party_id=party_id,
        booking_id=uuid.uuid5(uuid.NAMESPACE_DNS, "pb-bk1"),
        owner_user_id=uuid.uuid5(uuid.NAMESPACE_DNS, "pb-u1"),
        owner_anon_id=None,
        coach="B3",
        seat_no="1",
        seat_type="LB",
        bay=1,
        age_band="adult",
        gender_band="F",
        user_gender_self="female",
        trust_tier="verified_provider",
        from_seq=1,
        to_seq=5,
        goal_type="together",
        movers=frozenset({p_sh1, p_sh2}),
        women_only=True,
    )
    m2_together = SeatNode(
        seat_holder_id=p_sh2,
        party_id=party_id,
        booking_id=uuid.uuid5(uuid.NAMESPACE_DNS, "pb-bk2"),
        owner_user_id=uuid.uuid5(uuid.NAMESPACE_DNS, "pb-u2"),
        owner_anon_id=None,
        coach="B3",
        seat_no="2",
        seat_type="MB",
        bay=1,
        age_band="adult",
        gender_band="F",
        user_gender_self="female",
        trust_tier="verified_provider",
        from_seq=1,
        to_seq=5,
        goal_type="together",
        movers=frozenset({p_sh1, p_sh2}),
        women_only=True,
    )
    ext_male = _make_node(20, seat_type="LB", seat_no="4", gender_band="M", user_gender_self="male")
    g1 = build_swap_graph([m1_together, m2_together, ext_male])
    assert plan_party_bay_swaps(g1, {party_id: [m1_together, m2_together]}) == []

    # Case 2: m2 is in bay 2, ext_male is male while party has women_only=True -> rejected
    m2_split = SeatNode(
        seat_holder_id=p_sh2,
        party_id=party_id,
        booking_id=uuid.uuid5(uuid.NAMESPACE_DNS, "pb-bk2"),
        owner_user_id=uuid.uuid5(uuid.NAMESPACE_DNS, "pb-u2"),
        owner_anon_id=None,
        coach="B3",
        seat_no="9",
        seat_type="LB",
        bay=2,
        age_band="adult",
        gender_band="F",
        user_gender_self="female",
        trust_tier="verified_provider",
        from_seq=1,
        to_seq=5,
        goal_type="together",
        movers=frozenset({p_sh1, p_sh2}),
        women_only=True,
    )
    ext_female_blocked = _make_node(21, seat_type="LB", seat_no="4", gender_band="F", user_gender_self="female")
    assert m1_together.owner_user_id is not None and ext_female_blocked.owner_user_id is not None
    g2 = build_swap_graph(
        [m1_together, m2_split, ext_male, ext_female_blocked],
        blocks=frozenset({(m1_together.owner_user_id, ext_female_blocked.owner_user_id)}),
    )
    assert plan_party_bay_swaps(g2, {party_id: [m1_together, m2_split]}) == []


def test_matching_and_swaps_import_cleanly() -> None:
    import saath_api.main  # noqa: F401
    import saath_api.matching.service  # noqa: F401
    import saath_api.swaps.service  # noqa: F401
    import saath_api.worker  # noqa: F401
