from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from saath_api.auth.models import Base


class KarmaLedger(Base):
    __tablename__ = "karma_ledger"
    __table_args__ = (
        CheckConstraint(
            "state IN ('pending', 'credited', 'reversed')",
            name="ck_karma_ledger_state",
        ),
        UniqueConstraint(
            "user_id",
            "proposal_id",
            "state",
            name="uq_karma_ledger_user_proposal_state",
        ),
        Index("ix_karma_ledger_user_created", "user_id", "created_at"),
        Index("ix_karma_ledger_proposal_id", "proposal_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    proposal_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("swap_proposals.id", ondelete="SET NULL"),
        nullable=True,
    )
    delta: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Badge(Base):
    __tablename__ = "badges"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    code: Mapped[str] = mapped_column(Text, primary_key=True)
    earned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class RewardItem(Base):
    __tablename__ = "reward_items"
    __table_args__ = (
        CheckConstraint("cost_points > 0", name="ck_reward_items_cost_points"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    title_en: Mapped[str] = mapped_column(Text, nullable=False)
    title_hi: Mapped[str] = mapped_column(Text, nullable=False)
    description_en: Mapped[str | None] = mapped_column(Text, nullable=True)
    description_hi: Mapped[str | None] = mapped_column(Text, nullable=True)
    cost_points: Mapped[int] = mapped_column(Integer, nullable=False)
    stock: Mapped[int | None] = mapped_column(Integer, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class RewardRedemption(Base):
    __tablename__ = "reward_redemptions"
    __table_args__ = (
        CheckConstraint("points_spent > 0", name="ck_reward_redemptions_points_spent"),
        CheckConstraint(
            "status IN ('pending', 'approved', 'fulfilled', 'rejected', 'cancelled')",
            name="ck_reward_redemptions_status",
        ),
        Index("ix_reward_redemptions_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    reward_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("reward_items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    points_spent: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'"))
    reviewed_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
