from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    SmallInteger,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from saath_api.auth.models import Base


class SwapProposal(Base):
    __tablename__ = "swap_proposals"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('pair', 'cycle3', 'cycle4', 'plan')",
            name="ck_swap_proposals_kind",
        ),
        CheckConstraint(
            "status IN ("
            "'draft', 'pending', 'confirmed', 'declined', 'expired', "
            "'invalidated', 'cancelled', 'awaiting_confirmation', 'completed', 'not_completed'"
            ")",
            name="ck_swap_proposals_status",
        ),
        Index("ix_swap_proposals_journey_status", "journey_instance_id", "status"),
        Index("ix_swap_proposals_status_expires", "status", "expires_at"),
        Index("ix_swap_proposals_initiator", "initiator_user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    journey_instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("journey_instances.id", ondelete="CASCADE"),
        nullable=False,
    )
    initiator_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'pending'")
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    decline_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_card_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    version: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class SwapParticipant(Base):
    __tablename__ = "swap_participants"
    __table_args__ = (
        CheckConstraint(
            "decision IN ('pending', 'accepted', 'declined')",
            name="ck_swap_participants_decision",
        ),
        CheckConstraint(
            "post_confirm IS NULL OR post_confirm IN ('yes', 'no', 'did_not_board')",
            name="ck_swap_participants_post_confirm",
        ),
        Index("ix_swap_participants_user_id", "user_id"),
    )

    proposal_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("swap_proposals.id", ondelete="CASCADE"),
        primary_key=True,
    )
    seat_holder_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("seat_holders.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    alias: Mapped[str] = mapped_column(Text, nullable=False)
    gives_seat: Mapped[str] = mapped_column(Text, nullable=False)
    gets_seat: Mapped[str] = mapped_column(Text, nullable=False)
    gives_coach: Mapped[str | None] = mapped_column(Text, nullable=True)
    gets_coach: Mapped[str | None] = mapped_column(Text, nullable=True)
    gives_seat_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    gets_seat_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    gives_bay: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    gets_bay: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    decision: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'pending'")
    )
    decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    post_confirm: Mapped[str | None] = mapped_column(Text, nullable=True)
    post_confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class SeatLock(Base):
    __tablename__ = "seat_locks"
    __table_args__ = (Index("ix_seat_locks_proposal_id", "proposal_id"),)

    seat_holder_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("seat_holders.id", ondelete="CASCADE"),
        primary_key=True,
    )
    proposal_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("swap_proposals.id", ondelete="CASCADE"),
        nullable=False,
    )
    locked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class SwapCard(Base):
    __tablename__ = "swap_cards"

    proposal_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("swap_proposals.id", ondelete="CASCADE"),
        primary_key=True,
    )
    public_code: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    payload_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    signature: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    revoked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    revoked_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
