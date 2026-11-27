from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from saath_api.auth.models import Base


class MatchCandidate(Base):
    __tablename__ = "match_candidates"
    __table_args__ = (
        CheckConstraint("score >= 0 AND score <= 100", name="ck_match_candidates_score"),
        CheckConstraint(
            "kind IN ('pair', 'cycle3', 'cycle4', 'plan')",
            name="ck_match_candidates_kind",
        ),
        Index(
            "ix_match_candidates_party_ver_score",
            "for_party_id",
            text("match_version DESC"),
            text("score DESC"),
        ),
        Index("ix_match_candidates_journey_ver", "journey_instance_id", "match_version"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    journey_instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("journey_instances.id", ondelete="CASCADE"),
        nullable=False,
    )
    match_version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    for_party_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("parties.id", ondelete="CASCADE"),
        nullable=False,
    )
    card_id: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    cycle_seat_holders: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False
    )
    plan_cycles: Mapped[list[Any] | dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    score: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    reasons: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Block(Base):
    __tablename__ = "blocks"

    blocker: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    blocked: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
