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
    LargeBinary,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from saath_api.auth.models import Base


class Party(Base):
    __tablename__ = "parties"
    __table_args__ = (
        CheckConstraint(
            "leader_user_id IS NOT NULL OR leader_anon_id IS NOT NULL",
            name="ck_parties_leader",
        ),
        Index("ix_parties_journey_instance_id", "journey_instance_id"),
        Index("ix_parties_leader_user_id", "leader_user_id"),
        Index("ix_parties_leader_anon_id", "leader_anon_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    journey_instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("journey_instances.id", ondelete="CASCADE"),
        nullable=False,
    )
    leader_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    leader_anon_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    invite_token_hash: Mapped[bytes | None] = mapped_column(LargeBinary, unique=True, nullable=True)
    invite_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class PartyMember(Base):
    __tablename__ = "party_members"
    __table_args__ = (UniqueConstraint("seat_holder_id", name="uq_party_members_seat_holder"),)

    party_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("parties.id", ondelete="CASCADE"),
        primary_key=True,
    )
    seat_holder_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("seat_holders.id", ondelete="CASCADE"),
        primary_key=True,
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Goal(Base):
    __tablename__ = "goals"
    __table_args__ = (
        CheckConstraint(
            "goal_type IN ("
            "'together', 'lower', 'upper', 'same_coach', 'window', "
            "'aisle', 'legroom', 'specific_seats', 'open_to_help'"
            ")",
            name="ck_goals_goal_type",
        ),
        Index("ix_goals_party_active", "party_id", "active"),
        Index(
            "uq_goals_one_active_per_party",
            "party_id",
            unique=True,
            postgresql_where=text("active = true"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    party_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("parties.id", ondelete="CASCADE"), nullable=False
    )
    goal_type: Mapped[str] = mapped_column(Text, nullable=False)
    movers: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), nullable=False)
    preferred_seats: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{}'")
    )
    constraints: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    standing_offer: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
