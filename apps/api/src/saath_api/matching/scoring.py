from __future__ import annotations

import re
from uuid import UUID

from saath_api.core.config import KarmaConfig
from saath_api.matching.graph import (
    LOWER_SEAT_TYPES,
    SeatNode,
    SwapEdge,
    evaluate_edge_eligibility,
    is_verified_female,
)

_COACH_NUM_RE = re.compile(r"([0-9]+)$")


def _coach_distance(coach_a: str | None, coach_b: str | None) -> int:
    if not coach_a or not coach_b:
        return 3
    ca = coach_a.strip().upper()
    cb = coach_b.strip().upper()
    if ca == cb:
        return 0
    ma = _COACH_NUM_RE.search(ca)
    mb = _COACH_NUM_RE.search(cb)
    if ma and mb and ca[:1] == cb[:1]:
        return abs(int(ma.group(1)) - int(mb.group(1)))
    return 4


def compute_proximity(u: SeatNode, v: SeatNode) -> float:
    cdist = _coach_distance(u.coach, v.coach)
    if cdist == 0:
        if u.bay is not None and v.bay is not None:
            bdist = abs(u.bay - v.bay)
            if bdist == 0:
                return 1.0
            if bdist == 1:
                return 0.85
            if bdist <= 3:
                return 0.7
        return 0.6
    if cdist == 1:
        return 0.4
    if cdist == 2:
        return 0.25
    return 0.1


def bayesian_reliability(accepted: int, completed: int) -> float:
    # Beta(8, 2) prior -> 0.80 default for new users
    denom = 10.0 + max(0, accepted)
    num = 8.0 + max(0, min(completed, accepted))
    return max(0.0, min(1.0, num / denom))


def format_reliability_text(accepted: int, completed: int) -> str:
    if accepted <= 0:
        return "New"
    return f"{min(completed, accepted)}/{accepted}"


def estimate_responsiveness(node: SeatNode) -> tuple[float, str]:
    if node.trust_tier in ("verified_provider", "verified_bcbp"):
        return 0.9, "~5m"
    if node.trust_tier == "verified_doc":
        return 0.75, "~10m"
    return 0.55, "~15m"


def score_directed_edge(
    u: SeatNode,
    v: SeatNode,
    *,
    blocks: frozenset[tuple[UUID, UUID]] = frozenset(),
) -> SwapEdge | None:
    allowed, goal_fit, overlap = evaluate_edge_eligibility(u, v, blocks=blocks)
    if not allowed:
        return None

    proximity = compute_proximity(u, v)

    social_priority = 0.2
    reasons: list[str] = []
    reason_codes: list[str] = []

    if u.age_band == "senior" and (v.seat_type or "").upper() in LOWER_SEAT_TYPES:
        social_priority = 1.0
        reason_codes.append("frees_lower_for_senior")
        reasons.append("Frees a lower berth for a senior passenger")
    elif (
        u.goal_type == "open_to_help" and u.standing_give_to == "senior" and v.age_band == "senior"
    ):
        social_priority = 1.0
        reason_codes.append("helps_senior_traveller")
        reasons.append("Helps a senior traveller with their preferred berth")
    elif u.goal_type == "open_to_help":
        social_priority = 0.75
        reason_codes.append("open_to_help_helper")
        reasons.append("Co-traveller is open to helping")
    elif v.goal_type == "open_to_help":
        social_priority = 0.85
        reason_codes.append("open_to_help_helper")
        reasons.append("Matched with a co-traveller open to helping")

    safety = 0.3
    if u.women_only and is_verified_female(v):
        safety = 1.0
        reason_codes.append("same_gender_safety")
        reasons.append("Verified women-only match")
    elif v.trust_tier in ("verified_provider", "verified_bcbp"):
        safety = 0.7

    reliability = bayesian_reliability(v.reliability_accepted, v.reliability_completed)
    responsiveness, _ = estimate_responsiveness(v)

    penalties = 0.0
    if v.trust_tier == "declared":
        penalties += 0.15
    if overlap == "partial":
        penalties += 0.10
    if u.age_band == "senior" and (u.coach or "").upper() != (v.coach or "").upper():
        penalties += 0.15

    raw = (
        0.40 * goal_fit
        + 0.20 * proximity
        + 0.15 * social_priority
        + 0.10 * safety
        + 0.10 * reliability
        + 0.05 * responsiveness
        - penalties
    )
    weight = max(0.01, min(1.0, raw))

    if (u.coach or "").upper() == (v.coach or "").upper():
        if u.bay is not None and v.bay is not None and abs(u.bay - v.bay) <= 1:
            reason_codes.append("nearby_bay")
            reasons.append("Same coach and nearby bay")
        else:
            reason_codes.append("same_coach")
            reasons.append("Inside the same coach")
    if v.trust_tier in ("verified_provider", "verified_bcbp"):
        reason_codes.append("verified_ticket")
        reasons.append("Verified booking")
    if not reasons:
        reason_codes.append("goal_fit")
        reasons.append("Matches your seat preference")

    return SwapEdge(
        u=u.seat_holder_id,
        v=v.seat_holder_id,
        weight=weight,
        goal_fit=goal_fit,
        segment_overlap=overlap,
        reason_codes=tuple(dict.fromkeys(reason_codes)),
        reasons=tuple(dict.fromkeys(reasons)),
    )


def score_to_label(score: int) -> str:
    if score >= 85:
        return "Perfect swap"
    if score >= 70:
        return "Great match"
    if score >= 55:
        return "Workable"
    if score >= 40:
        return "Partial"
    return "Weak"


def estimate_karma_preview(
    node: SeatNode,
    karma_config: KarmaConfig | None,
    *,
    is_cycle: bool = False,
) -> int:
    stype = (node.seat_type or "UB").upper()
    if karma_config is None:
        base = 100 if stype in ("LB", "WS") else 75 if stype in ("SL", "AS", "CC") else 50
        return base + (10 if is_cycle else 0)

    if node.mode == "flight":
        fmap = karma_config.flight
        if node.is_exit_row:
            base = fmap.get("EXIT", 100)
        elif stype == "WS":
            base = fmap.get("W", 100)
        elif stype == "AS":
            base = fmap.get("A", 75)
        else:
            base = fmap.get("M", 50)
    else:
        base = karma_config.train.get(stype, 50)
    if is_cycle:
        base += karma_config.bonus.get("cycle_participant", 10)
    return int(base)
