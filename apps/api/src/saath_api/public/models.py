from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from saath_api.auth.models import Base


class SeatInvite(Base):
    __tablename__ = "seat_invites"
    __table_args__ = (
        CheckConstraint(
            "inviter_user_id IS NOT NULL OR inviter_anon_id IS NOT NULL",
            name="ck_seat_invites_inviter",
        ),
        CheckConstraint(
            "conversions_count >= 0",
            name="ck_seat_invites_conversions",
        ),
        Index("ix_seat_invites_journey_instance_id", "journey_instance_id"),
        Index("ix_seat_invites_inviter_user_id", "inviter_user_id"),
        Index("ix_seat_invites_expires_at", "expires_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    journey_instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("journey_instances.id", ondelete="CASCADE"),
        nullable=False,
    )
    inviter_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    inviter_anon_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, unique=True)
    target_coach: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_seat_no: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    conversions_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
