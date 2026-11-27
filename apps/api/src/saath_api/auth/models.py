from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
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
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "gender_self IN ('female', 'male', 'other', 'undisclosed')",
            name="ck_users_gender_self",
        ),
        CheckConstraint(
            "status IN ('active', 'restricted', 'banned', 'deleted')",
            name="ck_users_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    phone_enc: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    phone_bidx: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, unique=True)
    display_alias: Mapped[str | None] = mapped_column(Text, nullable=True)
    gender_self: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'undisclosed'")
    )
    locale: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'en'"))
    women_only_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    reliability_accepted: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    reliability_completed: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'"))
    leaderboard_opt_in: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    notification_prefs: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text(
            '\'{"push": true, "whatsapp": true, "sms": true, "quiet_hours_enabled": true}\'::jsonb'
        ),
    )
    erasure_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    erased_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    @property
    def notification_channels(self) -> dict[str, Any]:
        base: dict[str, Any] = {
            "push": True,
            "whatsapp": True,
            "sms": True,
            "quiet_hours_enabled": True,
        }
        if isinstance(self.notification_prefs, dict):
            base.update(self.notification_prefs)
        return base


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = (Index("ix_devices_user_id", "user_id"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    push_endpoint: Mapped[str | None] = mapped_column(Text, nullable=True)
    push_p256dh: Mapped[str | None] = mapped_column(Text, nullable=True)
    push_auth: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    __table_args__ = (
        Index("ix_refresh_tokens_family_id", "family_id"),
        Index("ix_refresh_tokens_user_device", "user_id", "device_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    device_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False
    )
    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    replaced_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("refresh_tokens.id", ondelete="SET NULL"),
        nullable=True,
    )
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Consent(Base):
    __tablename__ = "consents"
    __table_args__ = (
        CheckConstraint(
            "purpose IN ('verification', 'matching', 'notifications', 'analytics', 'whatsapp')",
            name="ck_consents_purpose",
        ),
        Index("ix_consents_user_purpose_at", "user_id", "purpose", "at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    notice_version: Mapped[str] = mapped_column(Text, nullable=False)
    granted: Mapped[bool] = mapped_column(Boolean, nullable=False)
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AuditLog(Base):
    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_log_at", "at"),
        Index("ix_audit_log_resource", "resource"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    resource: Mapped[str] = mapped_column(Text, nullable=False)
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
