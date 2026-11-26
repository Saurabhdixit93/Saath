"""Messaging, moderation, notification preferences, and outbox backoff columns

Revision ID: 0004_messaging_moderation
Revises: 0003_matching_swaps_cards
Create Date: 2026-11-26 05:30:00.000000

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004_messaging_moderation"
down_revision: str | Sequence[str] | None = "0003_matching_swaps_cards"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "journey_instance_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_instances.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_card_id", sa.Text(), nullable=True),
        sa.Column(
            "unmasked",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_conversations_journey_instance_id",
        "conversations",
        ["journey_instance_id"],
    )

    op.create_table(
        "conversation_members",
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "seat_holder_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("seat_holders.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("alias", sa.Text(), nullable=False),
        sa.Column("alias_ref", sa.Text(), unique=True, nullable=False),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_conversation_members_user_id",
        "conversation_members",
        ["user_id"],
    )

    op.create_table(
        "messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "sender_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("lang", sa.Text(), nullable=True),
        sa.Column(
            "moderation",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'ok'"),
        ),
        sa.Column("moderation_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "moderation IN ('ok', 'redacted', 'hidden')",
            name="ck_messages_moderation",
        ),
        sa.UniqueConstraint(
            "conversation_id",
            "sender_user_id",
            "client_id",
            name="uq_messages_convo_sender_client_id",
        ),
    )
    op.create_index(
        "ix_messages_conversation_created",
        "messages",
        ["conversation_id", "created_at"],
    )

    op.create_table(
        "reports",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "reporter",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "target_user",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "message_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("messages.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'open'"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "status IN ('open', 'reviewed', 'dismissed', 'actioned')",
            name="ck_reports_status",
        ),
    )
    op.create_index("ix_reports_target_reporter", "reports", ["target_user", "reporter"])
    op.create_index("ix_reports_status_created", "reports", ["status", "created_at"])

    op.add_column(
        "users",
        sa.Column(
            "notification_prefs",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text(
                "'{\"push\":true,\"whatsapp\":true,\"sms\":true,\"quiet_hours_enabled\":true}'::jsonb"
            ),
        ),
    )
    op.add_column(
        "notifications_outbox",
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "notifications_outbox",
        sa.Column("last_error", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_notifications_outbox_status_next_attempt",
        "notifications_outbox",
        ["status", "next_attempt_at", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_notifications_outbox_status_next_attempt",
        table_name="notifications_outbox",
    )
    op.drop_column("notifications_outbox", "last_error")
    op.drop_column("notifications_outbox", "next_attempt_at")
    op.drop_column("users", "notification_prefs")

    op.drop_index("ix_reports_status_created", table_name="reports")
    op.drop_index("ix_reports_target_reporter", table_name="reports")
    op.drop_table("reports")

    op.drop_index("ix_messages_conversation_created", table_name="messages")
    op.drop_table("messages")

    op.drop_index("ix_conversation_members_user_id", table_name="conversation_members")
    op.drop_table("conversation_members")

    op.drop_index("ix_conversations_journey_instance_id", table_name="conversations")
    op.drop_table("conversations")
