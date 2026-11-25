from __future__ import annotations

import uuid

from saath_api.journeys.geometry import seat_to_bay_and_type
from saath_api.matching.graph import SeatNode
from saath_api.matching.service import compute_matches_in_memory


def test_1200_passenger_3a_train_with_200_active_recomputes_under_2s() -> None:
    nodes: list[SeatNode] = []
    coaches = [f"B{i}" for i in range(1, 18)]  # 17 * 72 = 1224 seats (~1,200 pax)

    idx = 0
    for coach in coaches:
        for seat_num in range(1, 73):
            if idx >= 1200:
                break
            idx += 1
            bay, stype, _ = seat_to_bay_and_type("3A", seat_num)
            sh_id = uuid.uuid5(uuid.NAMESPACE_DNS, f"bench-sh-{idx}")
            party_id = uuid.uuid5(uuid.NAMESPACE_DNS, f"bench-party-{idx}")
            booking_id = uuid.uuid5(uuid.NAMESPACE_DNS, f"bench-bk-{idx}")
            user_id = uuid.uuid5(uuid.NAMESPACE_DNS, f"bench-user-{idx}")

            is_active = idx <= 200
            goal_type: str | None = None
            standing_give: str | None = None
            if is_active:
                if idx % 3 == 0:
                    goal_type = "open_to_help"
                    standing_give = "anyone"
                elif stype in ("UB", "MB"):
                    goal_type = "lower"
                else:
                    goal_type = "upper"

            nodes.append(
                SeatNode(
                    seat_holder_id=sh_id,
                    party_id=party_id,
                    booking_id=booking_id,
                    owner_user_id=user_id,
                    owner_anon_id=None,
                    coach=coach,
                    seat_no=str(seat_num),
                    seat_type=stype,
                    bay=bay,
                    age_band="senior" if idx % 10 == 0 else "adult",
                    gender_band="F" if idx % 2 == 0 else "M",
                    user_gender_self="female" if idx % 2 == 0 else "male",
                    trust_tier="verified_provider",
                    from_seq=1,
                    to_seq=6,
                    goal_type=goal_type,
                    movers=frozenset({sh_id}),
                    standing_give_to=standing_give,
                )
            )

    result = compute_matches_in_memory(nodes)
    assert result.elapsed_ms < 2000.0
    assert len(result.all_cycles) > 0
    assert len(result.packed_cycles) > 0
