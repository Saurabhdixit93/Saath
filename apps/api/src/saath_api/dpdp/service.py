from __future__ import annotations

import io
import json
import zipfile
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import structlog
from fastapi import status
from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.models import AuditLog, Consent, RefreshToken, User
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7
from saath_api.dpdp.schemas import (
    DPDP_NOTICE_VERSION,
    DPDP_PURPOSES,
    ConsentItemInput,
    ConsentRecordDTO,
    ConsentsListResponse,
    DeleteAccountResponse,
    SaveConsentsResponse,
)
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.karma.models import Badge, KarmaLedger
from saath_api.messaging.models import ConversationMember, Message
from saath_api.parties.models import Party, PartyMember
from saath_api.swaps.models import SeatLock, SwapParticipant, SwapProposal

logger = structlog.get_logger(__name__)

DEFAULT_PURPOSE_GRANTED: dict[str, bool] = {
    "verification": True,
    "matching": True,
    "notifications": True,
    "analytics": False,
    "whatsapp": True,
}


async def get_user_consents(
    *,
    db: AsyncSession,
    user_id: UUID,
) -> ConsentsListResponse:
    stmt = select(Consent).where(Consent.user_id == user_id).order_by(Consent.at.asc())
    result = await db.execute(stmt)
    rows = result.scalars().all()

    # Map of latest consent per purpose
    latest_by_purpose: dict[str, Consent] = {}
    for row in rows:
        latest_by_purpose[row.purpose] = row

    consents: list[ConsentRecordDTO] = []
    for purpose in DPDP_PURPOSES:
        if purpose in latest_by_purpose:
            record = latest_by_purpose[purpose]
            consents.append(
                ConsentRecordDTO(
                    purpose=record.purpose,
                    notice_version=record.notice_version,
                    granted=record.granted,
                    at=record.at,
                )
            )
        else:
            consents.append(
                ConsentRecordDTO(
                    purpose=purpose,
                    notice_version=DPDP_NOTICE_VERSION,
                    granted=DEFAULT_PURPOSE_GRANTED.get(purpose, False),
                    at=None,
                )
            )

    return ConsentsListResponse(
        notice_version=DPDP_NOTICE_VERSION,
        purposes=list(DPDP_PURPOSES),
        consents=consents,
    )


async def save_user_consents(
    *,
    db: AsyncSession,
    user_id: UUID,
    items: list[ConsentItemInput],
) -> SaveConsentsResponse:
    valid_purposes = set(DPDP_PURPOSES)
    for item in items:
        if item.purpose not in valid_purposes:
            raise ProblemDetailError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="invalid_dpdp_purpose",
                title="Invalid DPDP Purpose",
                detail=f"Purpose '{item.purpose}' is not recognized under DPDP rules.",
            )

    now = datetime.now(UTC)
    for item in items:
        row = Consent(
            id=uuid7(),
            user_id=user_id,
            purpose=item.purpose,
            notice_version=item.notice_version or DPDP_NOTICE_VERSION,
            granted=item.granted,
            at=now,
        )
        db.add(row)

    db.add(
        AuditLog(
            actor=f"user:{user_id}",
            action="dpdp.consents_updated",
            resource=f"user:{user_id}",
            meta={"purposes": [i.purpose for i in items]},
            at=now,
        )
    )
    await db.commit()

    # Re-read all latest consents for this user
    all_consents_res = await get_user_consents(db=db, user_id=user_id)
    return SaveConsentsResponse(consents=all_consents_res.consents)


async def export_user_data_zip(
    *,
    db: AsyncSession,
    user_id: UUID,
) -> bytes:
    # 1. Profile
    user_stmt = select(User).where(User.id == user_id)
    user_res = await db.execute(user_stmt)
    user = user_res.scalar_one_or_none()
    if user is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="user_not_found",
            title="User Not Found",
            detail="User account was not found.",
        )

    profile_data: dict[str, Any] = {
        "id": str(user.id),
        "display_alias": user.display_alias,
        "gender_self": user.gender_self,
        "locale": user.locale,
        "women_only_default": user.women_only_default,
        "reliability_accepted": user.reliability_accepted,
        "reliability_completed": user.reliability_completed,
        "status": user.status,
        "leaderboard_opt_in": user.leaderboard_opt_in,
        "notification_channels": user.notification_channels,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }

    # 2. Consents
    consents_stmt = select(Consent).where(Consent.user_id == user_id).order_by(Consent.at.asc())
    consents_res = await db.execute(consents_stmt)
    consents_data = [
        {
            "purpose": c.purpose,
            "notice_version": c.notice_version,
            "granted": c.granted,
            "at": c.at.isoformat() if c.at else None,
        }
        for c in consents_res.scalars().all()
    ]

    # 3. Journeys & Bookings (strip PNR, pnr_hash, phone)
    bookings_stmt = (
        select(Booking, JourneyInstance)
        .join(JourneyInstance, Booking.journey_instance_id == JourneyInstance.id)
        .where(Booking.owner_user_id == user_id)
        .order_by(Booking.created_at.desc())
    )
    bookings_res = await db.execute(bookings_stmt)
    bookings_rows = bookings_res.all()

    journeys_data: list[dict[str, Any]] = []
    for booking, instance in bookings_rows:
        holders_stmt = select(SeatHolder).where(SeatHolder.booking_id == booking.id)
        holders_res = await db.execute(holders_stmt)
        holders = holders_res.scalars().all()

        seats = [
            {
                "coach": h.coach,
                "seat_no": h.seat_no,
                "seat_type": h.seat_type,
                "bay": h.bay,
                "age_band": "child" if h.age_band == "child" else "adult",
                "gender_band": h.gender_band,
            }
            for h in holders
        ]

        journeys_data.append(
            {
                "booking_id": str(booking.id),
                "journey_instance_id": str(instance.id),
                "mode": str(instance.mode),
                "carrier_code": instance.carrier_code,
                "service_no": instance.service_no,
                "service_date": instance.service_date.isoformat(),
                "departure_at": instance.departure_at.isoformat()
                if instance.departure_at
                else None,
                "arrival_at": instance.arrival_at.isoformat() if instance.arrival_at else None,
                "from_code": booking.from_code,
                "to_code": booking.to_code,
                "travel_class": booking.travel_class,
                "trust_tier": booking.trust_tier,
                "seats": seats,
                "created_at": booking.created_at.isoformat(),
            }
        )

    # 4. Parties (no partner phone or PNR). Membership is via the user's linked seat holders.
    my_party_ids = (
        select(PartyMember.party_id)
        .join(SeatHolder, PartyMember.seat_holder_id == SeatHolder.id)
        .where(SeatHolder.linked_user_id == user_id)
    )
    parties_stmt = (
        select(Party)
        .where(or_(Party.leader_user_id == user_id, Party.id.in_(my_party_ids)))
        .order_by(Party.created_at.asc())
    )
    parties_res = await db.execute(parties_stmt)
    parties_rows = parties_res.scalars().all()

    parties_data: list[dict[str, Any]] = []
    for party in parties_rows:
        members_stmt = (
            select(PartyMember, SeatHolder)
            .join(SeatHolder, PartyMember.seat_holder_id == SeatHolder.id)
            .where(PartyMember.party_id == party.id)
            .order_by(SeatHolder.pax_seq.asc())
        )
        members_res = await db.execute(members_stmt)
        members_rows = members_res.all()

        parties_data.append(
            {
                "party_id": str(party.id),
                "journey_instance_id": str(party.journey_instance_id),
                "my_role": "leader" if party.leader_user_id == user_id else "member",
                "created_at": party.created_at.isoformat(),
                "members_count": len(members_rows),
                "members": [
                    {
                        "joined_at": m.joined_at.isoformat(),
                        "is_me": h.linked_user_id == user_id,
                    }
                    for m, h in members_rows
                ],
            }
        )

    # 5. Swaps (no partner phone or PNR)
    swaps_stmt = (
        select(SwapParticipant, SwapProposal)
        .join(SwapProposal, SwapParticipant.proposal_id == SwapProposal.id)
        .where(SwapParticipant.user_id == user_id)
        .order_by(SwapProposal.created_at.desc())
    )
    swaps_res = await db.execute(swaps_stmt)
    swaps_rows = swaps_res.all()

    swaps_data: list[dict[str, Any]] = []
    for participant, proposal in swaps_rows:
        all_parts_stmt = select(SwapParticipant).where(SwapParticipant.proposal_id == proposal.id)
        all_parts_res = await db.execute(all_parts_stmt)
        all_parts = all_parts_res.scalars().all()

        swaps_data.append(
            {
                "swap_id": str(proposal.id),
                "kind": proposal.kind,
                "status": proposal.status,
                "created_at": proposal.created_at.isoformat(),
                "confirmed_at": proposal.confirmed_at.isoformat()
                if proposal.confirmed_at
                else None,
                "my_decision": participant.decision,
                "gives_seat": participant.gives_seat,
                "gets_seat": participant.gets_seat,
                "gives_coach": participant.gives_coach,
                "gets_coach": participant.gets_coach,
                "participants": [
                    {
                        "alias": p.alias,
                        "gives_seat": p.gives_seat,
                        "gets_seat": p.gets_seat,
                        "gives_coach": p.gives_coach,
                        "gets_coach": p.gets_coach,
                        "decision": p.decision,
                        "is_me": p.user_id == user_id,
                    }
                    for p in all_parts
                ],
            }
        )

    # 6. Messages
    convo_ids_stmt = select(ConversationMember.conversation_id).where(
        ConversationMember.user_id == user_id
    )
    convo_ids_res = await db.execute(convo_ids_stmt)
    convo_ids = convo_ids_res.scalars().all()

    messages_data: list[dict[str, Any]] = []
    if convo_ids:
        msgs_stmt = (
            select(Message)
            .where(Message.conversation_id.in_(convo_ids))
            .order_by(Message.created_at.asc())
        )
        msgs_res = await db.execute(msgs_stmt)
        for msg in msgs_res.scalars().all():
            messages_data.append(
                {
                    "id": str(msg.id),
                    "conversation_id": str(msg.conversation_id),
                    "is_mine": msg.sender_user_id == user_id,
                    "body": msg.body,
                    "moderation": msg.moderation,
                    "created_at": msg.created_at.isoformat(),
                }
            )

    # 7. Karma
    karma_stmt = (
        select(KarmaLedger)
        .where(KarmaLedger.user_id == user_id)
        .order_by(KarmaLedger.created_at.asc())
    )
    karma_res = await db.execute(karma_stmt)
    karma_rows = karma_res.scalars().all()
    karma_data = [
        {
            "id": k.id,
            "delta": k.delta,
            "state": k.state,
            "reason": k.reason,
            "created_at": k.created_at.isoformat(),
        }
        for k in karma_rows
    ]

    # 8. Badges
    badges_stmt = (
        select(Badge)
        .where(Badge.user_id == user_id)
        .order_by(Badge.earned_at.asc(), Badge.code.asc())
    )
    badges_res = await db.execute(badges_stmt)
    badges_rows = badges_res.scalars().all()
    badges_data = [
        {
            "code": b.code,
            "earned_at": b.earned_at.isoformat() if b.earned_at else None,
        }
        for b in badges_rows
    ]

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("profile.json", json.dumps(profile_data, indent=2))
        zf.writestr("consents.json", json.dumps(consents_data, indent=2))
        zf.writestr("journeys.json", json.dumps(journeys_data, indent=2))
        zf.writestr("parties.json", json.dumps(parties_data, indent=2))
        zf.writestr("swaps.json", json.dumps(swaps_data, indent=2))
        zf.writestr("messages.json", json.dumps(messages_data, indent=2))
        zf.writestr("karma.json", json.dumps(karma_data, indent=2))
        zf.writestr("badges.json", json.dumps(badges_data, indent=2))

    db.add(
        AuditLog(
            actor=f"user:{user_id}",
            action="dpdp.data_exported",
            resource=f"user:{user_id}",
            meta={"files_count": 8},
            at=datetime.now(UTC),
        )
    )
    await db.commit()

    return zip_buffer.getvalue()


async def delete_user_account(
    *,
    db: AsyncSession,
    user_id: UUID,
) -> DeleteAccountResponse:
    user_stmt = select(User).where(User.id == user_id)
    user_res = await db.execute(user_stmt)
    user = user_res.scalar_one_or_none()
    if user is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="user_not_found",
            title="User Not Found",
            detail="User account was not found.",
        )

    now = datetime.now(UTC)

    # 1. Update user to deleted / erasure_scheduled
    user.status = "deleted"
    user.deleted_at = now
    user.erasure_requested_at = now
    user.display_alias = None
    user.leaderboard_opt_in = False

    # 2. Revoke all refresh tokens
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )

    # 3. Release locks and cancel pending swaps where this user is participant
    pending_props_stmt = (
        select(SwapProposal)
        .join(SwapParticipant, SwapParticipant.proposal_id == SwapProposal.id)
        .where(
            SwapParticipant.user_id == user_id,
            SwapProposal.status.in_(["draft", "pending", "proposed"]),
        )
    )
    pending_props_res = await db.execute(pending_props_stmt)
    pending_proposals = pending_props_res.scalars().all()

    for proposal in pending_proposals:
        proposal.status = "cancelled"
        await db.execute(delete(SeatLock).where(SeatLock.proposal_id == proposal.id))

    # 4. Write audit log (Strictly zero raw PII)
    db.add(
        AuditLog(
            actor=f"user:{user_id}",
            action="dpdp.erasure_requested",
            resource=f"user:{user_id}",
            meta={"scheduled_within_hours": 24},
            at=now,
        )
    )

    await db.commit()
    logger.info("dpdp_erasure_requested", user_id=str(user_id))

    return DeleteAccountResponse(
        status="erasure_scheduled",
        scheduled_within_hours=24,
    )
