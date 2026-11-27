from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    SmallInteger,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ENUM as PG_ENUM
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from saath_api.auth.models import Base

TRANSPORT_MODE_ENUM = PG_ENUM(
    "train",
    "flight",
    "bus",
    name="transport_mode",
    create_type=False,
)


class JourneyInstance(Base):
    __tablename__ = "journey_instances"
    __table_args__ = (
        UniqueConstraint(
            "mode",
            "carrier_code",
            "service_no",
            "service_date",
            name="uq_journey_instances_service",
        ),
        CheckConstraint(
            "chart_state IN ('pending', 'first', 'final', 'na')",
            name="ck_journey_instances_chart_state",
        ),
        Index("ix_journey_instances_chart_due", "chart_state", "chart_due_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    mode: Mapped[str] = mapped_column(TRANSPORT_MODE_ENUM, nullable=False)
    carrier_code: Mapped[str] = mapped_column(Text, nullable=False)
    service_no: Mapped[str] = mapped_column(Text, nullable=False)
    service_date: Mapped[date] = mapped_column(Date, nullable=False)
    departure_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    arrival_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    chart_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    chart_state: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'"))
    layout_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    match_version: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Booking(Base):
    __tablename__ = "bookings"
    __table_args__ = (
        CheckConstraint(
            "owner_user_id IS NOT NULL OR owner_anon_id IS NOT NULL",
            name="ck_bookings_owner",
        ),
        CheckConstraint(
            "trust_tier IN ('verified_provider', 'verified_bcbp', 'verified_doc', 'declared')",
            name="ck_bookings_trust_tier",
        ),
        Index("ix_bookings_journey_pnr_hash", "journey_instance_id", "pnr_hash"),
        Index(
            "uq_bookings_non_bcbp_pnr",
            "journey_instance_id",
            "pnr_hash",
            unique=True,
            postgresql_where=text("trust_tier <> 'verified_bcbp'"),
        ),
        Index("ix_bookings_owner_user_id", "owner_user_id"),
        Index("ix_bookings_owner_anon_id", "owner_anon_id"),
        Index("ix_bookings_purge_after", "purge_after"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    journey_instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("journey_instances.id", ondelete="CASCADE"),
        nullable=False,
    )
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    owner_anon_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    pnr_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    travel_class: Mapped[str | None] = mapped_column(Text, nullable=True)
    from_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    from_seq: Mapped[int | None] = mapped_column(Integer, nullable=True)
    to_seq: Mapped[int | None] = mapped_column(Integer, nullable=True)
    trust_tier: Mapped[str] = mapped_column(Text, nullable=False)
    claim_conflict_flagged: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    last_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    purge_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class SeatHolder(Base):
    __tablename__ = "seat_holders"
    __table_args__ = (
        UniqueConstraint("booking_id", "pax_seq", name="uq_seat_holders_booking_pax"),
        CheckConstraint(
            "age_band IN ('child', 'adult', 'senior', 'unknown')",
            name="ck_seat_holders_age_band",
        ),
        CheckConstraint(
            "gender_band IN ('F', 'M', 'U')",
            name="ck_seat_holders_gender_band",
        ),
        Index("ix_seat_holders_coach_seat_no", "coach", "seat_no"),
        Index("ix_seat_holders_linked_user_id", "linked_user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    booking_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bookings.id", ondelete="CASCADE"), nullable=False
    )
    pax_seq: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    booking_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    current_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    coach: Mapped[str | None] = mapped_column(Text, nullable=True)
    seat_no: Mapped[str | None] = mapped_column(Text, nullable=True)
    seat_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    bay: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    age_band: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'unknown'"))
    gender_band: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'U'"))
    linked_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
