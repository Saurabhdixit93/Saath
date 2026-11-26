from __future__ import annotations

from contextlib import suppress
from datetime import UTC, datetime, timedelta
from uuid import UUID

import structlog
from fastapi import status
from redis.asyncio import Redis
from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor
from saath_api.auth.models import AuditLog, User
from saath_api.core.config import Settings, YamlConfigBundle
from saath_api.core.crypto import hmac_sha256_hex
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7
from saath_api.core.redis import SlidingWindowRateLimiter
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.matching.graph import make_pseudonymous_alias
from saath_api.matching.models import Block, MatchCandidate
from saath_api.matching.service import schedule_or_run_match_recompute
from saath_api.messaging.models import Conversation, ConversationMember, Message, Report
from saath_api.messaging.moderation import evaluate_message_moderation
from saath_api.messaging.redaction import redact_contact_details
from saath_api.messaging.schemas import (
    BlockUserResponse,
    ConversationDTO,
    ConversationListResponse,
    ConversationParticipantDTO,
    CreateReportRequest,
    CreateReportResponse,
    MessageDTO,
    MessagesResponse,
    SendMessageRequest,
    TranslateMessageRequest,
    TranslateMessageResponse,
)
from saath_api.notifications.models import NotificationsOutbox
from saath_api.parties.models import Party, PartyMember
from saath_api.providers.llm import LLMProvider
from saath_api.realtime.pubsub import (
    publish_conversation_event,
    publish_subscribe_control,
    publish_user_event,
)
from saath_api.swaps.models import SwapParticipant, SwapProposal
from saath_api.swaps.service import invalidate_pending_swaps_for_user_pair

logger = structlog.get_logger(__name__)

_SHORT_SEAT_TYPE: dict[str, str] = {
    "LB": "L",
    "MB": "M",
    "UB": "U",
    "SL": "SL",
    "SM": "SM",
    "SU": "SU",
    "WS": "W",
    "MS": "M",
    "AS": "A",
}

_CONFIRMED_SWAP_STATUSES: tuple[str, ...] = (
    "confirmed",
    "awaiting_confirmation",
    "completed",
    "not_completed",
)


def _format_chat_alias(
    coach: str | None,
    seat_type: str | None,
    seat_holder_id: UUID | None = None,
    *,
    disambiguate: bool = False,
) -> str:
    coach_part = (coach or "CABIN").strip().upper()
    raw_type = (seat_type or "S").strip().upper()
    short_type = _SHORT_SEAT_TYPE.get(raw_type, raw_type[:2] if raw_type else "S")
    base = f"Passenger {coach_part}-{short_type}"
    if disambiguate and seat_holder_id is not None:
        return f"{base} #{seat_holder_id.hex[:3].upper()}"
    return base


def _make_alias_ref(secret: str, conversation_id: UUID, user_id: UUID) -> str:
    digest = hmac_sha256_hex(secret, f"{conversation_id}:{user_id}")
    return f"ar_{digest[:20]}"


def _format_revealed_seat(sh: SeatHolder | None) -> str | None:
    if sh is None or not sh.seat_no:
        return None
    if sh.coach and sh.coach.upper() != "CABIN":
        return f"{sh.coach.upper()}-{sh.seat_no} {sh.seat_type or ''}".strip()
    return f"{sh.seat_no} {sh.seat_type or ''}".strip()


async def _has_mutual_block(
    db: AsyncSession, *, user_id: UUID, other_user_ids: list[UUID]
) -> bool:
    if not other_user_ids:
        return False
    row = (
        await db.execute(
            select(Block.blocker).where(
                or_(
                    (Block.blocker == user_id) & Block.blocked.in_(other_user_ids),
                    (Block.blocked == user_id) & Block.blocker.in_(other_user_ids),
                )
            )
        )
    ).first()
    return row is not None


async def _build_conversation_dto(
    db: AsyncSession,
    *,
    convo: Conversation,
    actor_user_id: UUID,
) -> ConversationDTO:
    ji = (
        await db.execute(
            select(JourneyInstance).where(JourneyInstance.id == convo.journey_instance_id)
        )
    ).scalar_one()

    members = list(
        (
            await db.execute(
                select(ConversationMember)
                .where(ConversationMember.conversation_id == convo.id)
                .order_by(ConversationMember.joined_at, ConversationMember.user_id)
            )
        )
        .scalars()
        .all()
    )

    sh_by_id: dict[UUID, SeatHolder] = {}
    if convo.unmasked:
        sh_ids = [m.seat_holder_id for m in members if m.seat_holder_id is not None]
        if sh_ids:
            sh_rows = (
                await db.execute(select(SeatHolder).where(SeatHolder.id.in_(sh_ids)))
            ).scalars().all()
            sh_by_id = {sh.id: sh for sh in sh_rows}

    participants: list[ConversationParticipantDTO] = []
    partner_alias = "Passenger"
    partner_alias_ref = ""
    other_uids: list[UUID] = []

    for m in members:
        is_me = m.user_id == actor_user_id
        if not is_me:
            other_uids.append(m.user_id)
            if partner_alias_ref == "":
                partner_alias = m.alias
                partner_alias_ref = m.alias_ref
        seat_revealed = (
            _format_revealed_seat(sh_by_id.get(m.seat_holder_id))
            if (convo.unmasked and m.seat_holder_id is not None)
            else None
        )
        participants.append(
            ConversationParticipantDTO(
                alias=m.alias,
                alias_ref=m.alias_ref,
                is_me=is_me,
                seat_revealed=seat_revealed,
            )
        )

    blocked = await _has_mutual_block(
        db, user_id=actor_user_id, other_user_ids=other_uids
    )

    alias_by_uid = {m.user_id: m.alias for m in members}
    last_msg_row = (
        await db.execute(
            select(Message)
            .where(
                Message.conversation_id == convo.id,
                or_(
                    Message.moderation != "hidden",
                    Message.sender_user_id == actor_user_id,
                ),
            )
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    last_message: MessageDTO | None = None
    if last_msg_row is not None:
        is_sender = last_msg_row.sender_user_id == actor_user_id
        last_message = MessageDTO(
            id=last_msg_row.id,
            conversation_id=last_msg_row.conversation_id,
            sender_alias=alias_by_uid.get(last_msg_row.sender_user_id, "Passenger")
            if last_msg_row.sender_user_id
            else "Passenger",
            is_me=is_sender,
            client_id=last_msg_row.client_id,
            body="[Hidden by safety filter]"
            if last_msg_row.moderation == "hidden"
            else last_msg_row.body,
            lang=last_msg_row.lang,
            moderation=last_msg_row.moderation,  # type: ignore[arg-type]
            redacted_hint=None,
            created_at=last_msg_row.created_at,
        )

    return ConversationDTO(
        id=convo.id,
        journey_instance_id=convo.journey_instance_id,
        service=f"{ji.carrier_code} {ji.service_no}".strip(),
        date=ji.service_date.isoformat(),
        partner_alias=partner_alias,
        partner_alias_ref=partner_alias_ref,
        unmasked=convo.unmasked,
        blocked=blocked,
        participants=participants,
        last_message=last_message,
        created_at=convo.created_at,
        updated_at=convo.updated_at,
    )


async def _require_conversation_membership(
    db: AsyncSession,
    *,
    conversation_id: UUID,
    actor_user_id: UUID,
) -> tuple[Conversation, list[ConversationMember], ConversationMember]:
    convo = (
        await db.execute(
            select(Conversation).where(Conversation.id == conversation_id)
        )
    ).scalar_one_or_none()
    if convo is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="conversation_not_found",
            title="Conversation Not Found",
            detail="Conversation was not found.",
        )

    members = list(
        (
            await db.execute(
                select(ConversationMember).where(
                    ConversationMember.conversation_id == conversation_id
                )
            )
        )
        .scalars()
        .all()
    )
    me = next((m for m in members if m.user_id == actor_user_id), None)
    if me is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="You are not a member of this conversation.",
        )
    return convo, members, me


async def list_conversations(
    *,
    db: AsyncSession,
    actor: Actor,
) -> ConversationListResponse:
    assert actor.user_id is not None
    convo_rows = list(
        (
            await db.execute(
                select(Conversation)
                .join(
                    ConversationMember,
                    ConversationMember.conversation_id == Conversation.id,
                )
                .where(ConversationMember.user_id == actor.user_id)
                .order_by(Conversation.updated_at.desc(), Conversation.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    items = [
        await _build_conversation_dto(db, convo=c, actor_user_id=actor.user_id)
        for c in convo_rows
    ]
    return ConversationListResponse(items=items)


async def create_or_get_conversation(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    redis: Redis | None,
    actor: Actor,
    card_id: str,
) -> ConversationDTO:
    assert actor.user_id is not None

    cand = (
        await db.execute(
            select(MatchCandidate).where(MatchCandidate.card_id == card_id)
        )
    ).scalar_one_or_none()
    if cand is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="match_card_not_found",
            title="Match Not Found",
            detail="This match card is no longer available.",
        )

    # Verify caller belongs to cand.for_party_id
    party_sh_rows = (
        await db.execute(
            select(SeatHolder, Booking)
            .join(Booking, Booking.id == SeatHolder.booking_id)
            .join(PartyMember, PartyMember.seat_holder_id == SeatHolder.id)
            .where(PartyMember.party_id == cand.for_party_id)
        )
    ).all()
    party_uids = {
        (sh.linked_user_id or booking.owner_user_id) for sh, booking in party_sh_rows
    }
    if actor.user_id not in party_uids:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="You cannot start a chat for another party's match.",
        )

    cycle_sh_ids = list(cand.cycle_seat_holders)
    cycle_rows = (
        await db.execute(
            select(SeatHolder, Booking)
            .join(Booking, Booking.id == SeatHolder.booking_id)
            .where(SeatHolder.id.in_(cycle_sh_ids))
        )
    ).all()

    user_sh_map: dict[UUID, SeatHolder] = {}
    for sh, booking in cycle_rows:
        uid = sh.linked_user_id or booking.owner_user_id
        if uid is None:
            raise ProblemDetailError(
                status_code=status.HTTP_409_CONFLICT,
                code="partner_unverified",
                title="Co-Traveller Not Signed In",
                detail="This co-traveller hasn't verified their phone for chat yet. Send a swap request instead.",
            )
        if uid not in user_sh_map:
            user_sh_map[uid] = sh

    if actor.user_id not in user_sh_map:
        actor_sh = next(
            (sh for sh, b in party_sh_rows if (sh.linked_user_id or b.owner_user_id) == actor.user_id),
            None,
        )
        if actor_sh is not None:
            user_sh_map[actor.user_id] = actor_sh

    participant_uids = set(user_sh_map.keys())
    other_uids = [uid for uid in participant_uids if uid != actor.user_id]
    if not other_uids:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="no_partner_to_chat",
            title="No Chat Partner",
            detail="Cannot create a conversation without another verified traveller.",
        )

    if await _has_mutual_block(db, user_id=actor.user_id, other_user_ids=other_uids):
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_blocked",
            title="User Blocked",
            detail="You cannot message a blocked traveller.",
        )

    # Idempotent reuse: look for an existing conversation on this journey with the exact same members
    existing_convos = list(
        (
            await db.execute(
                select(Conversation)
                .join(
                    ConversationMember,
                    ConversationMember.conversation_id == Conversation.id,
                )
                .where(
                    Conversation.journey_instance_id == cand.journey_instance_id,
                    ConversationMember.user_id == actor.user_id,
                )
            )
        )
        .scalars()
        .all()
    )
    for existing in existing_convos:
        existing_member_uids = set(
            (
                await db.execute(
                    select(ConversationMember.user_id).where(
                        ConversationMember.conversation_id == existing.id
                    )
                )
            )
            .scalars()
            .all()
        )
        if existing_member_uids == participant_uids:
            return await _build_conversation_dto(
                db, convo=existing, actor_user_id=actor.user_id
            )

    # Enforce new-account daily new-partner conversation limit
    user_row = (
        await db.execute(select(User).where(User.id == actor.user_id))
    ).scalar_one()
    now = datetime.now(UTC)
    new_acct_days = yaml_configs.rate_limits.messages_new_partner.new_account_age_days
    per_day_limit = yaml_configs.rate_limits.messages_new_partner.per_day
    if user_row.created_at > now - timedelta(days=new_acct_days) and redis is not None:
        limiter = SlidingWindowRateLimiter(redis)
        allowed, retry_after = await limiter.allow(
            f"rl:msg:new_convo:{actor.user_id}",
            limit=per_day_limit,
            window_seconds=86400,
        )
        if not allowed:
            raise ProblemDetailError(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                code="new_account_chat_limit",
                title="Daily Conversation Limit Reached",
                detail=(
                    f"New accounts can start up to {per_day_limit} new conversations per day."
                ),
                headers={"Retry-After": str(retry_after)},
            )

    # Check if a confirmed swap already covers these exact users on this journey
    is_unmasked = False
    confirmed_props = list(
        (
            await db.execute(
                select(SwapProposal.id).where(
                    SwapProposal.journey_instance_id == cand.journey_instance_id,
                    SwapProposal.status.in_(_CONFIRMED_SWAP_STATUSES),
                )
            )
        )
        .scalars()
        .all()
    )
    for prop_id in confirmed_props:
        prop_uids = set(
            uid
            for uid in (
                await db.execute(
                    select(SwapParticipant.user_id).where(
                        SwapParticipant.proposal_id == prop_id
                    )
                )
            )
            .scalars()
            .all()
            if uid is not None
        )
        if participant_uids.issubset(prop_uids) and len(participant_uids) >= 2:
            is_unmasked = True
            break

    convo_id = uuid7()
    convo = Conversation(
        id=convo_id,
        journey_instance_id=cand.journey_instance_id,
        source_card_id=card_id,
        unmasked=is_unmasked,
        created_at=now,
        updated_at=now,
    )
    db.add(convo)
    await db.flush()

    base_aliases: dict[UUID, str] = {}
    alias_counts: dict[str, int] = {}
    for uid, sh in user_sh_map.items():
        base = _format_chat_alias(sh.coach, sh.seat_type, sh.id, disambiguate=False)
        base_aliases[uid] = base
        alias_counts[base] = alias_counts.get(base, 0) + 1

    for uid, sh in user_sh_map.items():
        base = base_aliases[uid]
        alias = (
            _format_chat_alias(sh.coach, sh.seat_type, sh.id, disambiguate=True)
            if alias_counts.get(base, 0) > 1
            else base
        )
        db.add(
            ConversationMember(
                conversation_id=convo_id,
                user_id=uid,
                seat_holder_id=sh.id,
                alias=alias,
                alias_ref=_make_alias_ref(settings.invite_token_secret, convo_id, uid),
                joined_at=now,
            )
        )

    await db.commit()
    await db.refresh(convo)

    for uid in participant_uids:
        await publish_subscribe_control(redis, uid, convo_id)

    return await _build_conversation_dto(db, convo=convo, actor_user_id=actor.user_id)


async def list_messages(
    *,
    db: AsyncSession,
    actor: Actor,
    conversation_id: UUID,
    before: str | None = None,
    limit: int = 50,
) -> MessagesResponse:
    assert actor.user_id is not None
    convo, members, _ = await _require_conversation_membership(
        db, conversation_id=conversation_id, actor_user_id=actor.user_id
    )
    alias_by_uid = {m.user_id: m.alias for m in members}

    clamped_limit = max(1, min(limit, 100))
    stmt = select(Message).where(
        Message.conversation_id == conversation_id,
        or_(
            Message.moderation != "hidden",
            Message.sender_user_id == actor.user_id,
        ),
    )

    if before:
        cutoff_dt: datetime | None = None
        try:
            before_uuid = UUID(before)
            ref_msg = (
                await db.execute(
                    select(Message.created_at).where(
                        Message.id == before_uuid,
                        Message.conversation_id == conversation_id,
                    )
                )
            ).scalar_one_or_none()
            if ref_msg is not None:
                cutoff_dt = ref_msg
        except ValueError:
            try:
                cutoff_dt = datetime.fromisoformat(before.replace("Z", "+00:00"))
            except ValueError:
                cutoff_dt = None
        if cutoff_dt is not None:
            stmt = stmt.where(Message.created_at < cutoff_dt)

    rows = list(
        (
            await db.execute(
                stmt.order_by(Message.created_at.desc(), Message.id.desc()).limit(
                    clamped_limit + 1
                )
            )
        )
        .scalars()
        .all()
    )

    has_more = len(rows) > clamped_limit
    page_rows = list(reversed(rows[:clamped_limit]))
    next_before = str(page_rows[0].id) if has_more and page_rows else None

    items = [
        MessageDTO(
            id=msg.id,
            conversation_id=msg.conversation_id,
            sender_alias=alias_by_uid.get(msg.sender_user_id, "Passenger")
            if msg.sender_user_id
            else "Passenger",
            is_me=msg.sender_user_id == actor.user_id,
            client_id=msg.client_id,
            body="[Hidden by safety filter]"
            if msg.moderation == "hidden"
            else msg.body,
            lang=msg.lang,
            moderation=msg.moderation,  # type: ignore[arg-type]
            redacted_hint=None,
            created_at=msg.created_at,
        )
        for msg in page_rows
    ]

    convo_dto = await _build_conversation_dto(
        db, convo=convo, actor_user_id=actor.user_id
    )
    return MessagesResponse(
        conversation=convo_dto,
        items=items,
        next_before=next_before,
    )


async def send_message(
    *,
    db: AsyncSession,
    redis: Redis | None,
    llm_provider: LLMProvider,
    actor: Actor,
    conversation_id: UUID,
    req: SendMessageRequest,
) -> MessageDTO:
    assert actor.user_id is not None

    user_row = (
        await db.execute(select(User).where(User.id == actor.user_id))
    ).scalar_one()
    if user_row.status in ("restricted", "banned", "deleted"):
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="account_restricted",
            title="Messaging Restricted",
            detail="Your messaging privileges are temporarily restricted due to safety reports.",
        )

    convo, members, me = await _require_conversation_membership(
        db, conversation_id=conversation_id, actor_user_id=actor.user_id
    )
    other_uids = [m.user_id for m in members if m.user_id != actor.user_id]
    if await _has_mutual_block(db, user_id=actor.user_id, other_user_ids=other_uids):
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_blocked",
            title="User Blocked",
            detail="You cannot message a blocked traveller.",
        )

    existing_msg = (
        await db.execute(
            select(Message).where(
                Message.conversation_id == conversation_id,
                Message.sender_user_id == actor.user_id,
                Message.client_id == req.client_id,
            )
        )
    ).scalar_one_or_none()
    if existing_msg is not None:
        return MessageDTO(
            id=existing_msg.id,
            conversation_id=existing_msg.conversation_id,
            sender_alias=me.alias,
            is_me=True,
            client_id=existing_msg.client_id,
            body="[Hidden by safety filter]"
            if existing_msg.moderation == "hidden"
            else existing_msg.body,
            lang=existing_msg.lang,
            moderation=existing_msg.moderation,  # type: ignore[arg-type]
            redacted_hint=None,
            created_at=existing_msg.created_at,
        )

    locale = req.lang or (user_row.locale if user_row.locale in ("en", "hi") else "en")
    raw_body = req.body.strip()
    if not raw_body:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="empty_message",
            title="Empty Message",
            detail="Message body cannot be empty.",
        )

    if convo.unmasked:
        clean_body = raw_body
        was_redacted = False
        redacted_hint = None
    else:
        redaction = redact_contact_details(raw_body, locale=locale)
        clean_body = redaction.text
        was_redacted = redaction.redacted
        redacted_hint = redaction.hint

    mod_outcome = await evaluate_message_moderation(
        clean_text=clean_body,
        was_redacted=was_redacted,
        locale=locale,
        llm_provider=llm_provider,
    )

    now = datetime.now(UTC)
    msg_id = uuid7()
    msg_row = Message(
        id=msg_id,
        conversation_id=conversation_id,
        sender_user_id=actor.user_id,
        client_id=req.client_id,
        body=clean_body,
        lang=locale,
        moderation=mod_outcome.moderation,
        moderation_reason=mod_outcome.reason,
        created_at=now,
    )
    db.add(msg_row)
    convo.updated_at = now

    if mod_outcome.moderation != "hidden":
        for recipient_uid in other_uids:
            db.add(
                NotificationsOutbox(
                    user_id=recipient_uid,
                    event="MessageNew",
                    payload={
                        "conversation_id": str(conversation_id),
                        "message_id": str(msg_id),
                        "sender_alias": me.alias,
                        "preview": clean_body[:80],
                    },
                    idempotency_key=f"message_new:{msg_id}:{recipient_uid}",
                )
            )

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing_retry = (
            await db.execute(
                select(Message).where(
                    Message.conversation_id == conversation_id,
                    Message.sender_user_id == actor.user_id,
                    Message.client_id == req.client_id,
                )
            )
        ).scalar_one_or_none()
        if existing_retry is not None:
            return MessageDTO(
                id=existing_retry.id,
                conversation_id=existing_retry.conversation_id,
                sender_alias=me.alias,
                is_me=True,
                client_id=existing_retry.client_id,
                body="[Hidden by safety filter]"
                if existing_retry.moderation == "hidden"
                else existing_retry.body,
                lang=existing_retry.lang,
                moderation=existing_retry.moderation,  # type: ignore[arg-type]
                redacted_hint=None,
                created_at=existing_retry.created_at,
            )
        raise

    await db.refresh(msg_row)

    if mod_outcome.moderation != "hidden":
        await publish_conversation_event(
            redis,
            conversation_id,
            {
                "type": "message.new",
                "conversation_id": str(conversation_id),
                "message": {
                    "id": str(msg_row.id),
                    "conversation_id": str(conversation_id),
                    "sender_alias": me.alias,
                    "client_id": msg_row.client_id,
                    "body": msg_row.body,
                    "lang": msg_row.lang,
                    "moderation": msg_row.moderation,
                    "created_at": msg_row.created_at.isoformat(),
                },
            },
        )

    return MessageDTO(
        id=msg_row.id,
        conversation_id=msg_row.conversation_id,
        sender_alias=me.alias,
        is_me=True,
        client_id=msg_row.client_id,
        body="[Hidden by safety filter]"
        if msg_row.moderation == "hidden"
        else msg_row.body,
        lang=msg_row.lang,
        moderation=msg_row.moderation,  # type: ignore[arg-type]
        redacted_hint=redacted_hint,
        created_at=msg_row.created_at,
    )


async def translate_message(
    *,
    db: AsyncSession,
    llm_provider: LLMProvider,
    actor: Actor,
    conversation_id: UUID,
    req: TranslateMessageRequest,
) -> TranslateMessageResponse:
    assert actor.user_id is not None
    await _require_conversation_membership(
        db, conversation_id=conversation_id, actor_user_id=actor.user_id
    )
    msg = (
        await db.execute(
            select(Message).where(
                Message.id == req.message_id,
                Message.conversation_id == conversation_id,
                Message.moderation != "hidden",
            )
        )
    ).scalar_one_or_none()
    if msg is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="message_not_found",
            title="Message Not Found",
            detail="Message was not found in this conversation.",
        )

    translated = await llm_provider.translate_text(
        text=msg.body, target_lang=req.to
    )
    return TranslateMessageResponse(
        message_id=msg.id,
        translated_text=translated,
        to=req.to,
    )


async def block_user_by_alias_ref(
    *,
    settings: Settings,
    db: AsyncSession,
    redis: Redis | None,
    actor: Actor,
    alias_ref: str,
    arq_pool: object | None = None,
) -> BlockUserResponse:
    assert actor.user_id is not None

    target_user_id: UUID | None = None
    extra_shared_ji_ids: set[UUID] = set()
    audit_meta: dict[str, str] = {}

    # Step 1: exact opaque alias_ref ("ar_...") lookup
    target_member = (
        await db.execute(
            select(ConversationMember).where(ConversationMember.alias_ref == alias_ref)
        )
    ).scalar_one_or_none()
    if target_member is not None:
        actor_member = (
            await db.execute(
                select(ConversationMember).where(
                    ConversationMember.conversation_id == target_member.conversation_id,
                    ConversationMember.user_id == actor.user_id,
                )
            )
        ).scalar_one_or_none()
        if actor_member is None:
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="forbidden",
                title="Forbidden",
                detail="You cannot block a participant outside your conversations.",
            )

        if target_member.user_id == actor.user_id:
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="cannot_block_self",
                title="Invalid Block Request",
                detail="You cannot block yourself.",
            )

        target_user_id = target_member.user_id
        convo_ji_id = (
            await db.execute(
                select(Conversation.journey_instance_id).where(
                    Conversation.id == target_member.conversation_id
                )
            )
        ).scalar_one_or_none()
        if convo_ji_id is not None:
            extra_shared_ji_ids.add(convo_ji_id)
        audit_meta = {"conversation_id": str(target_member.conversation_id)}
    else:
        # Step 2a: actor-scoped lookup by conversation display alias ("Passenger ...")
        actor_convo_ids_sq = select(ConversationMember.conversation_id).where(
            ConversationMember.user_id == actor.user_id
        )
        convo_matches = list(
            (
                await db.execute(
                    select(ConversationMember, Conversation.journey_instance_id)
                    .join(
                        Conversation,
                        Conversation.id == ConversationMember.conversation_id,
                    )
                    .where(
                        ConversationMember.conversation_id.in_(actor_convo_ids_sq),
                        ConversationMember.alias == alias_ref,
                        ConversationMember.user_id != actor.user_id,
                    )
                )
            ).all()
        )
        if convo_matches:
            distinct_uids = {cm.user_id for cm, _ in convo_matches}
            if len(distinct_uids) > 1:
                raise ProblemDetailError(
                    status_code=status.HTTP_409_CONFLICT,
                    code="ambiguous_alias",
                    title="Ambiguous Alias",
                    detail=(
                        "Multiple participants share this display alias; "
                        "pass alias_ref from the conversation."
                    ),
                )
            target_user_id = next(iter(distinct_uids))
            for _, ji_id in convo_matches:
                extra_shared_ji_ids.add(ji_id)
            audit_meta = {"conversation_id": str(convo_matches[0][0].conversation_id)}
        else:
            # Step 2b: actor-scoped lookup across active MatchCandidates via pseudonymous alias
            actor_party_ids = set(
                (
                    await db.execute(
                        select(Party.id).where(Party.leader_user_id == actor.user_id)
                    )
                )
                .scalars()
                .all()
            ) | set(
                (
                    await db.execute(
                        select(PartyMember.party_id)
                        .join(SeatHolder, SeatHolder.id == PartyMember.seat_holder_id)
                        .join(Booking, Booking.id == SeatHolder.booking_id)
                        .where(
                            or_(
                                SeatHolder.linked_user_id == actor.user_id,
                                Booking.owner_user_id == actor.user_id,
                            )
                        )
                    )
                )
                .scalars()
                .all()
            )
            if actor_party_ids:
                cands = list(
                    (
                        await db.execute(
                            select(MatchCandidate)
                            .join(
                                JourneyInstance,
                                (JourneyInstance.id == MatchCandidate.journey_instance_id)
                                & (
                                    JourneyInstance.match_version
                                    == MatchCandidate.match_version
                                ),
                            )
                            .where(MatchCandidate.for_party_id.in_(actor_party_ids))
                        )
                    )
                    .scalars()
                    .all()
                )
                cand_sh_ids: set[UUID] = set()
                cand_sh_map: dict[UUID, list[UUID]] = {}
                for cand in cands:
                    sh_list: list[UUID] = list(cand.cycle_seat_holders)
                    if cand.kind == "plan" and isinstance(cand.plan_cycles, dict):
                        raw_cycles = cand.plan_cycles.get("cycles") or []
                        if isinstance(raw_cycles, list):
                            for cyc in raw_cycles:
                                if isinstance(cyc, list):
                                    for raw_id in cyc:
                                        with suppress(ValueError):
                                            sh_list.append(UUID(str(raw_id)))
                    cand_sh_map[cand.id] = sh_list
                    cand_sh_ids.update(sh_list)

                if cand_sh_ids:
                    sh_rows = (
                        await db.execute(
                            select(SeatHolder, Booking)
                            .join(Booking, Booking.id == SeatHolder.booking_id)
                            .where(SeatHolder.id.in_(cand_sh_ids))
                        )
                    ).all()
                    sh_owner_by_id: dict[UUID, tuple[SeatHolder, UUID | None]] = {
                        sh.id: (sh, sh.linked_user_id or booking.owner_user_id)
                        for sh, booking in sh_rows
                    }
                    matched_uids: set[UUID] = set()
                    matched_ji_ids: set[UUID] = set()
                    matched_card_id: str | None = None
                    for cand in cands:
                        for sh_id in cand_sh_map.get(cand.id, []):
                            pair = sh_owner_by_id.get(sh_id)
                            if pair is None:
                                continue
                            sh, uid = pair
                            if uid is None or uid == actor.user_id:
                                continue
                            if (
                                make_pseudonymous_alias(sh.coach, sh.seat_type, sh.id)
                                == alias_ref
                            ):
                                matched_uids.add(uid)
                                matched_ji_ids.add(cand.journey_instance_id)
                                if matched_card_id is None:
                                    matched_card_id = cand.card_id

                    if len(matched_uids) > 1:
                        raise ProblemDetailError(
                            status_code=status.HTTP_409_CONFLICT,
                            code="ambiguous_alias",
                            title="Ambiguous Alias",
                            detail=(
                                "Multiple participants share this display alias; "
                                "pass alias_ref from the conversation."
                            ),
                        )
                    if len(matched_uids) == 1:
                        target_user_id = next(iter(matched_uids))
                        extra_shared_ji_ids.update(matched_ji_ids)
                        audit_meta = {"card_id": matched_card_id or ""}

    if target_user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="alias_not_found",
            title="Traveller Not Found",
            detail="Could not find that conversation participant.",
        )

    insert_stmt = (
        pg_insert(Block)
        .values(blocker=actor.user_id, blocked=target_user_id)
        .on_conflict_do_nothing(index_elements=[Block.blocker, Block.blocked])
        .returning(Block.blocker)
    )
    inserted = (await db.execute(insert_stmt)).scalar_one_or_none()
    if inserted is None:
        return BlockUserResponse(blocked=True)

    invalidated_swaps = await invalidate_pending_swaps_for_user_pair(
        db=db,
        user_a=actor.user_id,
        user_b=target_user_id,
        reason="user_blocked",
    )
    for prop, _ in invalidated_swaps:
        extra_shared_ji_ids.add(prop.journey_instance_id)

    actor_ji_ids = set(
        (
            await db.execute(
                select(Booking.journey_instance_id).where(
                    Booking.owner_user_id == actor.user_id
                )
            )
        )
        .scalars()
        .all()
    ) | set(
        (
            await db.execute(
                select(Booking.journey_instance_id)
                .join(SeatHolder, SeatHolder.booking_id == Booking.id)
                .where(SeatHolder.linked_user_id == actor.user_id)
            )
        )
        .scalars()
        .all()
    )
    target_ji_ids = set(
        (
            await db.execute(
                select(Booking.journey_instance_id).where(
                    Booking.owner_user_id == target_user_id
                )
            )
        )
        .scalars()
        .all()
    ) | set(
        (
            await db.execute(
                select(Booking.journey_instance_id)
                .join(SeatHolder, SeatHolder.booking_id == Booking.id)
                .where(SeatHolder.linked_user_id == target_user_id)
            )
        )
        .scalars()
        .all()
    )
    shared_ji_id_set = (actor_ji_ids & target_ji_ids) | extra_shared_ji_ids

    recompute_ji_ids: list[UUID] = []
    if shared_ji_id_set:
        shared_jis = list(
            (
                await db.execute(
                    select(JourneyInstance).where(
                        JourneyInstance.id.in_(shared_ji_id_set)
                    )
                )
            )
            .scalars()
            .all()
        )
        for ji in shared_jis:
            ji.match_version += 1
            recompute_ji_ids.append(ji.id)

    db.add(
        AuditLog(
            actor=f"user:{actor.user_id}",
            action="user.blocked",
            resource=f"user:{target_user_id}",
            meta=audit_meta,
        )
    )
    await db.commit()

    for prop, participant_uids in invalidated_swaps:
        event_payload = {
            "type": "swap.updated",
            "swap_id": str(prop.id),
            "journey_instance_id": str(prop.journey_instance_id),
            "status": prop.status,
            "version": prop.version,
        }
        for uid in participant_uids:
            await publish_user_event(redis, uid, event_payload)

    for ji_id in recompute_ji_ids:
        await schedule_or_run_match_recompute(
            db=db,
            redis=redis,
            journey_instance_id=ji_id,
            arq_pool=arq_pool,
            settings=settings,
        )

    return BlockUserResponse(blocked=True)


async def create_report(
    *,
    db: AsyncSession,
    actor: Actor,
    req: CreateReportRequest,
) -> CreateReportResponse:
    assert actor.user_id is not None
    _, members, _ = await _require_conversation_membership(
        db, conversation_id=req.conversation_id, actor_user_id=actor.user_id
    )

    target_user_id: UUID | None = None
    if req.message_id is not None:
        msg = (
            await db.execute(
                select(Message).where(
                    Message.id == req.message_id,
                    Message.conversation_id == req.conversation_id,
                )
            )
        ).scalar_one_or_none()
        if msg is None:
            raise ProblemDetailError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="message_not_found",
                title="Message Not Found",
                detail="Reported message was not found in this conversation.",
            )
        target_user_id = msg.sender_user_id
    else:
        other = next((m for m in members if m.user_id != actor.user_id), None)
        if other is not None:
            target_user_id = other.user_id

    if target_user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="report_target_missing",
            title="Report Target Missing",
            detail="Could not identify the participant to report.",
        )

    if target_user_id == actor.user_id:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="cannot_report_self",
            title="Invalid Report",
            detail="You cannot report your own message.",
        )

    report = Report(
        id=uuid7(),
        reporter=actor.user_id,
        target_user=target_user_id,
        conversation_id=req.conversation_id,
        message_id=req.message_id,
        reason=req.reason.strip(),
        status="open",
        created_at=datetime.now(UTC),
    )
    db.add(report)
    await db.flush()

    distinct_reporters = int(
        (
            await db.execute(
                select(func.count(func.distinct(Report.reporter))).where(
                    Report.target_user == target_user_id
                )
            )
        ).scalar_one()
        or 0
    )

    auto_restricted = False
    if distinct_reporters >= 3:
        target_user = (
            await db.execute(select(User).where(User.id == target_user_id))
        ).scalar_one_or_none()
        if target_user is not None and target_user.status == "active":
            target_user.status = "restricted"
            auto_restricted = True
            db.add(
                AuditLog(
                    actor="system:moderation",
                    action="user.auto_restricted",
                    resource=f"user:{target_user_id}",
                    meta={
                        "distinct_reporters": distinct_reporters,
                        "report_id": str(report.id),
                    },
                )
            )

    await db.commit()
    return CreateReportResponse(
        report_id=report.id,
        status="open",
        auto_restricted=auto_restricted,
    )
