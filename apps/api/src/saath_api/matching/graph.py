from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID

MIDDLE_SEAT_TYPES: frozenset[str] = frozenset({"MB", "SM", "MS"})
LOWER_SEAT_TYPES: frozenset[str] = frozenset({"LB", "SL"})
UPPER_SEAT_TYPES: frozenset[str] = frozenset({"UB", "SU"})


@dataclass(frozen=True)
class SeatNode:
    seat_holder_id: UUID
    party_id: UUID
    booking_id: UUID
    owner_user_id: UUID | None
    owner_anon_id: str | None
    coach: str | None
    seat_no: str | None
    seat_type: str | None
    bay: int | None
    age_band: str
    gender_band: str
    user_gender_self: str | None
    trust_tier: str
    from_seq: int | None
    to_seq: int | None
    goal_type: str | None
    movers: frozenset[UUID] = field(default_factory=frozenset)
    preferred_seats: frozenset[str] = field(default_factory=frozenset)
    women_only: bool = False
    no_middle: bool = False
    same_coach_only: bool = False
    verified_only: bool = False
    standing_give_to: str | None = None
    reliability_accepted: int = 0
    reliability_completed: int = 0
    is_locked: bool = False
    current_status: str | None = None
    is_exit_row: bool = False
    mode: str = "train"
    party_coach_bays: frozenset[tuple[str, int]] = field(default_factory=frozenset)
    party_coaches: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class SwapEdge:
    u: UUID
    v: UUID
    weight: float
    goal_fit: float
    segment_overlap: Literal["full", "partial"]
    reason_codes: tuple[str, ...]
    reasons: tuple[str, ...]


@dataclass
class SwapGraph:
    nodes: dict[UUID, SeatNode]
    edges: dict[UUID, list[SwapEdge]]
    blocks: frozenset[tuple[UUID, UUID]] = field(default_factory=frozenset)


def make_pseudonymous_alias(
    coach: str | None,
    seat_type: str | None,
    seat_holder_id: UUID,
) -> str:
    """Deterministic pseudonymous alias that never leaks seat_no, name, age, or gender."""
    coach_part = (coach or "CABIN").strip().upper()
    type_part = (seat_type or "S").strip().upper()
    suffix = seat_holder_id.hex[:3].upper()
    return f"Passenger {coach_part}-{type_part} #{suffix}"


def format_seat_descriptor(node: SeatNode) -> str:
    coach = (node.coach or "CABIN").strip().upper()
    seat_no = (node.seat_no or "?").strip().upper()
    seat_type = (node.seat_type or "S").strip().upper()
    if coach == "CABIN":
        return f"{seat_no} {seat_type}"
    return f"{coach}-{seat_no} {seat_type}"


def is_verified_female(node: SeatNode) -> bool:
    if node.user_gender_self == "male" or node.gender_band == "M":
        return False
    return node.user_gender_self == "female" or node.gender_band == "F"


def is_seated_and_unlocked(node: SeatNode) -> bool:
    if node.is_locked:
        return False
    if not node.coach or not node.seat_no or not node.seat_type:
        return False
    if node.current_status and node.current_status.upper().startswith("WL"):
        return False
    return True


def check_segment_overlap(
    u: SeatNode, v: SeatNode
) -> Literal["full", "partial"] | None:
    if (
        u.from_seq is None
        or u.to_seq is None
        or v.from_seq is None
        or v.to_seq is None
    ):
        return "full"
    if u.to_seq <= v.from_seq or v.to_seq <= u.from_seq:
        return None
    if u.from_seq >= v.from_seq and u.to_seq <= v.to_seq:
        return "full"
    return "partial"


def _matches_preferred_seats(v: SeatNode, preferred: frozenset[str]) -> bool:
    if not preferred or not v.seat_no:
        return False
    v_seat = v.seat_no.strip().upper()
    v_coach = (v.coach or "").strip().upper()
    candidates = {v_seat}
    if v_coach and v_coach != "CABIN":
        candidates.add(f"{v_coach}-{v_seat}")
        candidates.add(f"{v_coach}{v_seat}")
    for raw_pref in preferred:
        token = raw_pref.strip().upper().split()[0]
        if token in candidates:
            return True
    return False


def evaluate_edge_eligibility(
    u: SeatNode,
    v: SeatNode,
    *,
    blocks: frozenset[tuple[UUID, UUID]] = frozenset(),
) -> tuple[bool, float, Literal["full", "partial"]]:
    """Return (allowed, goal_fit, segment_overlap) for directed edge u -> v (u takes v's seat)."""
    if u.seat_holder_id == v.seat_holder_id or u.party_id == v.party_id:
        return False, 0.0, "full"
    if not is_seated_and_unlocked(u) or not is_seated_and_unlocked(v):
        return False, 0.0, "full"
    if not u.goal_type:
        return False, 0.0, "full"
    if u.goal_type != "open_to_help" and u.seat_holder_id not in u.movers:
        return False, 0.0, "full"

    if u.owner_user_id is not None and v.owner_user_id is not None:
        if (u.owner_user_id, v.owner_user_id) in blocks or (
            v.owner_user_id,
            u.owner_user_id,
        ) in blocks:
            return False, 0.0, "full"

    overlap = check_segment_overlap(u, v)
    if overlap is None:
        return False, 0.0, "full"

    if u.verified_only and v.trust_tier == "declared":
        return False, 0.0, overlap
    if u.no_middle and (v.seat_type or "").upper() in MIDDLE_SEAT_TYPES:
        return False, 0.0, overlap
    if u.same_coach_only and (u.coach or "").upper() != (v.coach or "").upper():
        return False, 0.0, overlap
    if u.women_only and not is_verified_female(v):
        return False, 0.0, overlap

    v_type = (v.seat_type or "").upper()
    v_coach = (v.coach or "").upper()
    u_coach = (u.coach or "").upper()

    goal_fit = 0.0
    gtype = u.goal_type
    if gtype == "lower":
        if v_type == "LB":
            goal_fit = 1.0
        elif v_type == "SL":
            goal_fit = 0.8
        else:
            return False, 0.0, overlap
    elif gtype == "upper":
        if v_type == "UB":
            goal_fit = 1.0
        elif v_type == "SU":
            goal_fit = 0.8
        else:
            return False, 0.0, overlap
    elif gtype == "same_coach":
        if v_coach == u_coach or (u.party_coaches and v_coach in u.party_coaches):
            goal_fit = 1.0
        else:
            return False, 0.0, overlap
    elif gtype == "window":
        if v_type == "WS":
            goal_fit = 1.0
        else:
            return False, 0.0, overlap
    elif gtype == "aisle":
        if v_type == "AS":
            goal_fit = 1.0
        else:
            return False, 0.0, overlap
    elif gtype == "legroom":
        if v.is_exit_row:
            goal_fit = 1.0
        elif v_type in ("SL", "LB"):
            goal_fit = 0.8
        else:
            return False, 0.0, overlap
    elif gtype == "specific_seats":
        if _matches_preferred_seats(v, u.preferred_seats):
            goal_fit = 1.0
        else:
            return False, 0.0, overlap
    elif gtype == "open_to_help":
        # Open-to-help passengers accept seats not blocked by their constraints;
        # avoid middle berths if helper currently has a non-middle berth unless explicitly open.
        give_to = u.standing_give_to or "anyone"
        if give_to == "women":
            if not is_verified_female(v):
                return False, 0.0, overlap
            goal_fit = 0.95
        elif give_to == "senior" and v.age_band == "senior":
            goal_fit = 1.0
        elif give_to == "senior":
            goal_fit = 0.55
        else:
            goal_fit = 0.85
    elif gtype == "together":
        if v.bay is not None and (v_coach, v.bay) in u.party_coach_bays:
            goal_fit = 0.95
        elif v_coach in u.party_coaches or v_coach == u_coach:
            goal_fit = 0.75
        else:
            return False, 0.0, overlap
    else:
        return False, 0.0, overlap

    return True, goal_fit, overlap
