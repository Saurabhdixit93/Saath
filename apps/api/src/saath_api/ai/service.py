from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

import structlog
from fastapi import status
from fastapi.responses import StreamingResponse
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from saath_api.admin.models import FeatureFlag
from saath_api.ai.models import AiUsageLog
from saath_api.ai.schemas import (
    ConciergeProposalDTO,
    ConciergeRequest,
    DraftRequestBody,
    DraftRequestResponse,
)
from saath_api.auth.dependencies import Actor
from saath_api.auth.models import User
from saath_api.core.config import YamlConfigBundle
from saath_api.core.errors import ProblemDetailError
from saath_api.core.redis import SlidingWindowRateLimiter
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.journeys.schemas import GoalConstraintsDTO, StandingOfferDTO
from saath_api.journeys.service import _load_actor_journey_context
from saath_api.matching.graph import format_seat_descriptor, make_pseudonymous_alias
from saath_api.matching.models import MatchCandidate
from saath_api.matching.service import _load_journey_nodes
from saath_api.messaging.redaction import (
    redact_contact_details,
    scrub_separated_ten_digit_pnrs,
)
from saath_api.parties.models import Goal, Party, PartyMember
from saath_api.providers.llm import (
    DraftContext,
    GoalTypeLiteral,
    LLMProvider,
    LLMUsage,
    _clamp_draft_text,
)

logger = structlog.get_logger(__name__)

_VALID_GOAL_TYPES: frozenset[str] = frozenset(
    {
        "together",
        "lower",
        "upper",
        "same_coach",
        "window",
        "aisle",
        "legroom",
        "specific_seats",
        "open_to_help",
    }
)
_FORBIDDEN_PII_KEYS: frozenset[str] = frozenset(
    {
        "name",
        "full_name",
        "first_name",
        "last_name",
        "passenger_name",
        "pax_name",
        "age",
        "dob",
        "date_of_birth",
        "gender",
        "gender_self",
        "gender_band",
        "phone",
        "phone_enc",
        "phone_bidx",
        "phone_number",
        "mobile",
        "email",
        "pnr",
        "raw_pnr",
        "pnr_hash",
        "seat_no",
        "berth_no",
    }
)


def _age_group_from_band(age_band: str | None) -> str:
    if age_band == "senior":
        return "senior"
    if age_band == "child":
        return "child"
    if age_band == "adult":
        return "adult"
    return "unknown"


def scrub_pii_text(text: str, *, locale: str = "en") -> str:
    if not text:
        return text
    redacted = redact_contact_details(text, locale=locale).text
    return scrub_separated_ten_digit_pnrs(redacted)


def _scrub_output_value(value: Any, *, locale: str = "en") -> Any:
    if isinstance(value, str):
        return scrub_pii_text(value, locale=locale)
    if isinstance(value, list):
        return [_scrub_output_value(item, locale=locale) for item in value]
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for k, v in value.items():
            if str(k).lower() in _FORBIDDEN_PII_KEYS:
                continue
            cleaned[str(k)] = _scrub_output_value(v, locale=locale)
        return cleaned
    return value


async def _require_ai_concierge_enabled(db: AsyncSession) -> None:
    flag = (
        await db.execute(select(FeatureFlag).where(FeatureFlag.key == "ai_concierge_enabled"))
    ).scalar_one_or_none()
    enabled = False
    if flag is not None:
        if isinstance(flag.value, bool):
            enabled = flag.value
        elif isinstance(flag.value, dict):
            enabled = bool(flag.value.get("enabled", False))
    if not enabled:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="ai_concierge_disabled",
            title="AI Concierge Disabled",
            detail="AI Concierge is currently disabled.",
        )


async def _enforce_ai_rate_limit(
    *,
    redis: Redis,
    yaml_configs: YamlConfigBundle,
    user_id: UUID,
) -> None:
    limiter = SlidingWindowRateLimiter(redis)
    daily_limit = yaml_configs.rate_limits.ai.per_user_per_day
    allowed, retry_after = await limiter.allow(
        f"rl:ai:user:{user_id}",
        limit=daily_limit,
        window_seconds=86400,
    )
    if not allowed:
        raise ProblemDetailError(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="rate_limited",
            title="Daily AI Limit Reached",
            detail="You have reached the daily limit for AI concierge and draft requests.",
            headers={"Retry-After": str(retry_after)},
        )


@dataclass
class _ConciergeSnapshot:
    party_id: UUID
    mode: Literal["train", "flight", "bus"]
    service: str
    travel_class: str | None
    members: list[dict[str, Any]]
    member_ids: set[UUID]
    member_female_map: dict[UUID, bool]
    member_male_map: dict[UUID, bool]
    user_is_female: bool
    party_women_only_eligible: bool
    coach_summaries: dict[str, dict[str, Any]]
    match_cards: dict[str, dict[str, Any]]


class _SnapshotToolExecutor:
    """Zero-PII, read-only + non-mutating proposal tool executor."""

    def __init__(self, snapshot: _ConciergeSnapshot, *, locale: str) -> None:
        self._snapshot = snapshot
        self._locale = locale

    async def get_party(self) -> dict[str, Any]:
        return {
            "party_id": str(self._snapshot.party_id),
            "mode": self._snapshot.mode,
            "service": self._snapshot.service,
            "travel_class": self._snapshot.travel_class,
            "party_women_only_eligible": self._snapshot.party_women_only_eligible,
            "members": self._snapshot.members,
            "match_cards": [
                {
                    "card_id": cid,
                    "kind": card.get("kind"),
                    "score": card.get("score"),
                }
                for cid, card in list(self._snapshot.match_cards.items())[:5]
            ],
        }

    async def get_coach_summary(self, *, coach: str) -> dict[str, Any]:
        norm = coach.strip().upper()
        summary = self._snapshot.coach_summaries.get(norm)
        if summary is None:
            return {
                "coach": norm or "CABIN",
                "verified_seats": 0,
                "by_seat_type": {},
                "active_goal_seekers": 0,
            }
        return summary

    async def propose_goal(self, *, payload: dict[str, Any]) -> dict[str, Any]:
        raw_goal = str(payload.get("goal_type") or "lower")
        goal_type: GoalTypeLiteral = (
            raw_goal if raw_goal in _VALID_GOAL_TYPES else "lower"  # type: ignore[assignment]
        )

        valid_movers: list[UUID] = []
        for raw_id in payload.get("movers") or []:
            try:
                uid = UUID(str(raw_id))
            except ValueError:
                continue
            if uid in self._snapshot.member_ids and uid not in valid_movers:
                valid_movers.append(uid)

        if not valid_movers:
            valid_movers = [
                UUID(str(m["seat_holder_id"]))
                for m in self._snapshot.members
                if m.get("seat_holder_id")
            ]

        raw_seats = [
            str(s).strip().upper() for s in (payload.get("preferred_seats") or []) if str(s).strip()
        ][:4]
        if goal_type == "specific_seats" and not raw_seats:
            goal_type = "together" if len(valid_movers) > 1 else "lower"
        if goal_type != "specific_seats":
            raw_seats = []

        raw_constraints = payload.get("constraints")
        c_dict = raw_constraints if isinstance(raw_constraints, dict) else {}
        women_only = bool(c_dict.get("women_only", False))
        if women_only:
            has_male_mover = any(
                self._snapshot.member_male_map.get(uid, False) for uid in valid_movers
            )
            movers_all_female = all(
                self._snapshot.member_female_map.get(uid, False) for uid in valid_movers
            )
            if has_male_mover or (not self._snapshot.user_is_female and not movers_all_female):
                women_only = False

        constraints = GoalConstraintsDTO(
            women_only=women_only,
            no_middle=bool(c_dict.get("no_middle", False)),
            same_coach_only=bool(c_dict.get("same_coach_only", False))
            if goal_type != "same_coach"
            else False,
            verified_only=bool(c_dict.get("verified_only", False)),
        )

        standing_offer: StandingOfferDTO | None = None
        raw_offer = payload.get("standing_offer")
        if goal_type == "open_to_help" and isinstance(raw_offer, dict):
            give_to = str(raw_offer.get("give_to") or "senior")
            if give_to not in ("senior", "women", "anyone"):
                give_to = "senior"
            note = raw_offer.get("note")
            clean_note = scrub_pii_text(str(note), locale=self._locale)[:120] if note else None
            standing_offer = StandingOfferDTO(
                give_to=give_to,
                note=clean_note,
            )

        raw_summary = payload.get("summary")
        summary = (
            scrub_pii_text(str(raw_summary), locale=self._locale)[:240]
            if isinstance(raw_summary, str) and raw_summary.strip()
            else None
        )

        dto = ConciergeProposalDTO(
            goal_type=goal_type,
            movers=valid_movers,
            preferred_seats=raw_seats,
            constraints=constraints,
            standing_offer=standing_offer,
            summary=summary,
        )
        return dto.model_dump(mode="json")

    async def explain_plan(self, *, plan_id: str) -> dict[str, Any]:
        card = self._snapshot.match_cards.get(plan_id)
        if card is None:
            return {"found": False, "plan_id": plan_id}
        return card


async def _build_concierge_snapshot(
    *,
    db: AsyncSession,
    ji: JourneyInstance,
    party: Party,
    user_row: User,
) -> _ConciergeSnapshot:
    party_shs = list(
        (
            await db.execute(
                select(SeatHolder)
                .join(PartyMember, PartyMember.seat_holder_id == SeatHolder.id)
                .where(PartyMember.party_id == party.id)
                .order_by(SeatHolder.pax_seq.asc())
            )
        )
        .scalars()
        .all()
    )

    user_is_female = user_row.gender_self == "female"
    member_ids: set[UUID] = set()
    member_female_map: dict[UUID, bool] = {}
    member_male_map: dict[UUID, bool] = {}
    has_male_member = False
    members_view: list[dict[str, Any]] = []

    for sh in party_shs:
        member_ids.add(sh.id)
        is_f = sh.gender_band == "F"
        is_m = sh.gender_band == "M"
        if is_m:
            has_male_member = True
        member_female_map[sh.id] = is_f
        member_male_map[sh.id] = is_m
        members_view.append(
            {
                "seat_holder_id": str(sh.id),
                "coach": sh.coach,
                "seat_type": sh.seat_type,
                "bay": sh.bay,
                "age_group": _age_group_from_band(sh.age_band),
                "women_only_eligible": is_f or (user_is_female and sh.gender_band != "M"),
                "current_status": sh.current_status,
            }
        )

    movers_all_female = bool(party_shs) and all(sh.gender_band == "F" for sh in party_shs)
    party_women_only_eligible = not has_male_member and (user_is_female or movers_all_female)

    # Aggregate coach summaries (strictly zero stranger PII)
    all_ji_shs = list(
        (
            await db.execute(
                select(SeatHolder)
                .join(Booking, Booking.id == SeatHolder.booking_id)
                .where(Booking.journey_instance_id == ji.id)
            )
        )
        .scalars()
        .all()
    )
    active_party_sh_ids = set(
        (
            await db.execute(
                select(PartyMember.seat_holder_id)
                .join(Party, Party.id == PartyMember.party_id)
                .join(Goal, Goal.party_id == Party.id)
                .where(
                    Party.journey_instance_id == ji.id,
                    Goal.active.is_(True),
                )
            )
        )
        .scalars()
        .all()
    )
    coach_summaries: dict[str, dict[str, Any]] = {}
    for sh in all_ji_shs:
        coach_key = (sh.coach or "CABIN").strip().upper()
        bucket = coach_summaries.setdefault(
            coach_key,
            {
                "coach": coach_key,
                "verified_seats": 0,
                "by_seat_type": {},
                "active_goal_seekers": 0,
            },
        )
        bucket["verified_seats"] += 1
        st_key = (sh.seat_type or "S").strip().upper()
        by_st: dict[str, int] = bucket["by_seat_type"]
        by_st[st_key] = by_st.get(st_key, 0) + 1
        if sh.id in active_party_sh_ids:
            bucket["active_goal_seekers"] += 1

    # Pseudonymous match card summaries for explain_plan
    cands = list(
        (
            await db.execute(
                select(MatchCandidate)
                .where(
                    MatchCandidate.for_party_id == party.id,
                    MatchCandidate.match_version == ji.match_version,
                )
                .order_by(MatchCandidate.score.desc())
                .limit(10)
            )
        )
        .scalars()
        .all()
    )
    match_cards: dict[str, dict[str, Any]] = {}
    for mc in cands:
        match_cards[mc.card_id] = {
            "found": True,
            "card_id": mc.card_id,
            "kind": mc.kind,
            "score": int(mc.score),
            "reasons": [str(r) for r in (mc.reasons or [])],
        }

    booking_row = (
        await db.execute(
            select(Booking.travel_class).where(Booking.journey_instance_id == ji.id).limit(1)
        )
    ).scalar_one_or_none()

    return _ConciergeSnapshot(
        party_id=party.id,
        mode=ji.mode,  # type: ignore[arg-type]
        service=f"{ji.carrier_code} {ji.service_no}".strip(),
        travel_class=booking_row,
        members=members_view,
        member_ids=member_ids,
        member_female_map=member_female_map,
        member_male_map=member_male_map,
        user_is_female=user_is_female,
        party_women_only_eligible=party_women_only_eligible,
        coach_summaries=coach_summaries,
        match_cards=match_cards,
    )


async def create_concierge_stream_response(
    *,
    db: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    redis: Redis,
    yaml_configs: YamlConfigBundle,
    llm_provider: LLMProvider,
    actor: Actor,
    req: ConciergeRequest,
) -> StreamingResponse:
    assert actor.user_id is not None

    await _require_ai_concierge_enabled(db)
    ji, _booking, party = await _load_actor_journey_context(
        db=db,
        actor=actor,
        journey_id=req.journey_id,
    )
    user_row = (await db.execute(select(User).where(User.id == actor.user_id))).scalar_one()

    await _enforce_ai_rate_limit(
        redis=redis,
        yaml_configs=yaml_configs,
        user_id=actor.user_id,
    )

    locale = "hi" if user_row.locale == "hi" else "en"
    clean_input = scrub_pii_text(req.text.strip(), locale=locale)
    snapshot = await _build_concierge_snapshot(
        db=db,
        ji=ji,
        party=party,
        user_row=user_row,
    )
    executor = _SnapshotToolExecutor(snapshot, locale=locale)
    actor_user_id = actor.user_id

    async def _event_generator() -> AsyncIterator[str]:
        recorded_usage: LLMUsage | None = None
        try:
            async for item in llm_provider.stream_concierge(
                user_text=clean_input,
                locale=locale,
                tool_executor=executor,
            ):
                if item.usage is not None:
                    recorded_usage = item.usage
                safe_data = _scrub_output_value(item.data, locale=locale)
                yield (
                    f"event: {item.event}\ndata: {json.dumps(safe_data, ensure_ascii=False)}\n\n"
                )
        finally:
            if recorded_usage is None:
                recorded_usage = LLMUsage(model="concierge-unknown")
            try:
                async with session_factory() as log_db:
                    log_db.add(
                        AiUsageLog(
                            user_id=actor_user_id,
                            actor=f"user:{actor_user_id}",
                            endpoint="/v1/ai/concierge",
                            model=recorded_usage.model,
                            input_tokens=recorded_usage.input_tokens,
                            output_tokens=recorded_usage.output_tokens,
                            cache_read_tokens=recorded_usage.cache_read_tokens,
                            latency_ms=recorded_usage.latency_ms,
                        )
                    )
                    await log_db.commit()
            except Exception:
                logger.warning("ai_usage_log_write_failed", endpoint="/v1/ai/concierge")

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def draft_swap_request(
    *,
    db: AsyncSession,
    redis: Redis,
    yaml_configs: YamlConfigBundle,
    llm_provider: LLMProvider,
    actor: Actor,
    req: DraftRequestBody,
) -> DraftRequestResponse:
    assert actor.user_id is not None

    await _require_ai_concierge_enabled(db)

    cand = (
        await db.execute(select(MatchCandidate).where(MatchCandidate.card_id == req.card_id))
    ).scalar_one_or_none()
    if cand is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="match_card_not_found",
            title="Match Not Found",
            detail="This match candidate was not found.",
        )

    owns_party = (
        await db.execute(
            select(Booking.id)
            .join(SeatHolder, SeatHolder.booking_id == Booking.id)
            .join(PartyMember, PartyMember.seat_holder_id == SeatHolder.id)
            .where(
                PartyMember.party_id == cand.for_party_id,
                Booking.owner_user_id == actor.user_id,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if owns_party is None and actor.kind != "admin":
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="You cannot draft a message for another party's match card.",
        )

    await _enforce_ai_rate_limit(
        redis=redis,
        yaml_configs=yaml_configs,
        user_id=actor.user_id,
    )

    user_row = (await db.execute(select(User).where(User.id == actor.user_id))).scalar_one()
    lang: Literal["en", "hi"] = req.lang or ("hi" if user_row.locale == "hi" else "en")

    ji = (
        await db.execute(
            select(JourneyInstance).where(JourneyInstance.id == cand.journey_instance_id)
        )
    ).scalar_one()
    nodes, _, _ = await _load_journey_nodes(db, ji.id, mode=ji.mode, layout_ref=ji.layout_ref)
    node_map = {n.seat_holder_id: n for n in nodes}
    resolved_nodes = [node_map[uid] for uid in cand.cycle_seat_holders if uid in node_map]
    my_node = next((n for n in resolved_nodes if n.party_id == cand.for_party_id), None)
    other_node = next((n for n in resolved_nodes if n.party_id != cand.for_party_id), None)

    you_give = format_seat_descriptor(my_node) if my_node is not None else "your seat"
    you_get_coach = other_node.coach if other_node and other_node.coach else "CABIN"
    you_get_seat_type = other_node.seat_type if other_node and other_node.seat_type else "S"
    you_get_bay = other_node.bay if other_node else None
    partner_alias = (
        make_pseudonymous_alias(other_node.coach, other_node.seat_type, other_node.seat_holder_id)
        if other_node is not None
        else "Fellow Traveller"
    )

    ctx = DraftContext(
        mode=ji.mode,  # type: ignore[arg-type]
        service=f"{ji.carrier_code} {ji.service_no}".strip(),
        you_give=you_give,
        you_get_coach=you_get_coach,
        you_get_seat_type=you_get_seat_type,
        you_get_bay=you_get_bay,
        partner_alias=partner_alias,
        reasons=tuple(str(r) for r in (cand.reasons or [])[:2]),
    )

    result = await llm_provider.draft_outreach_request(
        context=ctx,
        tone=req.tone,
        lang=lang,
    )
    clean_text = _clamp_draft_text(scrub_pii_text(result.text, locale=lang), 300)
    if not clean_text:
        clean_text = "Hello! Would you be open to swapping seats on this journey?"

    db.add(
        AiUsageLog(
            user_id=actor.user_id,
            actor=f"user:{actor.user_id}",
            endpoint="/v1/ai/draft-request",
            model=result.usage.model,
            input_tokens=result.usage.input_tokens,
            output_tokens=result.usage.output_tokens,
            cache_read_tokens=result.usage.cache_read_tokens,
            latency_ms=result.usage.latency_ms,
        )
    )
    await db.commit()
    return DraftRequestResponse(text=clean_text)
