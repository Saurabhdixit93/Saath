"""M5 schema: seat_invites, karma_ledger, badges, feature_flags, rewards, ai_usage_logs,
users columns

Revision ID: 0005_m5_schema
Revises: 0004_messaging_moderation
Create Date: 2026-11-26 14:00:00.000000

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005_m5_schema"
down_revision: str | Sequence[str] | None = "0004_messaging_moderation"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. Users M5 columns (leaderboard opt-in & DPDP erasure timestamps)
    op.add_column(
        "users",
        sa.Column(
            "leaderboard_opt_in",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "users",
        sa.Column("erasure_requested_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("erased_at", sa.DateTime(timezone=True), nullable=True),
    )

    # 2. Invite-the-Seat deep links
    op.create_table(
        "seat_invites",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "journey_instance_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_instances.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "inviter_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("inviter_anon_id", sa.Text(), nullable=True),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False, unique=True),
        sa.Column("target_coach", sa.Text(), nullable=True),
        sa.Column("target_seat_no", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "conversions_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "inviter_user_id IS NOT NULL OR inviter_anon_id IS NOT NULL",
            name="ck_seat_invites_inviter",
        ),
        sa.CheckConstraint(
            "conversions_count >= 0",
            name="ck_seat_invites_conversions",
        ),
    )
    op.create_index(
        "ix_seat_invites_journey_instance_id",
        "seat_invites",
        ["journey_instance_id"],
    )
    op.create_index(
        "ix_seat_invites_inviter_user_id",
        "seat_invites",
        ["inviter_user_id"],
    )
    op.create_index(
        "ix_seat_invites_expires_at",
        "seat_invites",
        ["expires_at"],
    )

    # 3. Karma ledger (append-only, user_id nullable for DPDP erasure anonymisation)
    op.create_table(
        "karma_ledger",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "proposal_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("swap_proposals.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("delta", sa.Integer(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'credited', 'reversed')",
            name="ck_karma_ledger_state",
        ),
        sa.UniqueConstraint(
            "user_id",
            "proposal_id",
            "state",
            name="uq_karma_ledger_user_proposal_state",
        ),
    )
    op.create_index(
        "ix_karma_ledger_user_created",
        "karma_ledger",
        ["user_id", "created_at"],
    )
    op.create_index(
        "ix_karma_ledger_proposal_id",
        "karma_ledger",
        ["proposal_id"],
    )

    # 4. Badges
    op.create_table(
        "badges",
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("code", sa.Text(), primary_key=True, nullable=False),
        sa.Column(
            "earned_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # 5. Feature flags
    op.create_table(
        "feature_flags",
        sa.Column("key", sa.Text(), primary_key=True, nullable=False),
        sa.Column(
            "value",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'false'::jsonb"),
        ),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("updated_by", sa.Text(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.execute(
        """
        INSERT INTO feature_flags (key, value, description, updated_by)
        VALUES
          ('rewards_catalogue_enabled', 'false'::jsonb,
           'Enable karma rewards catalogue redemption', 'migration:0005'),
          ('ai_concierge_enabled', 'true'::jsonb,
           'Enable Claude AI swap concierge and draft endpoints', 'migration:0005'),
          ('maintenance_banner', 'false'::jsonb,
           'Display maintenance banner across passenger web app', 'migration:0005'),
          ('sms_parser_llm_fallback', 'false'::jsonb,
           'Allow LLM fallback for ambiguous IRCTC SMS parsing', 'migration:0005')
        ON CONFLICT (key) DO NOTHING
        """
    )

    # 6. Rewards catalogue & redemptions
    op.create_table(
        "reward_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("code", sa.Text(), nullable=False, unique=True),
        sa.Column("title_en", sa.Text(), nullable=False),
        sa.Column("title_hi", sa.Text(), nullable=False),
        sa.Column("description_en", sa.Text(), nullable=True),
        sa.Column("description_hi", sa.Text(), nullable=True),
        sa.Column("cost_points", sa.Integer(), nullable=False),
        sa.Column("stock", sa.Integer(), nullable=True),
        sa.Column(
            "active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint("cost_points > 0", name="ck_reward_items_cost_points"),
    )

    op.create_table(
        "reward_redemptions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "reward_item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("reward_items.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("points_spent", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column("reviewed_by", sa.Text(), nullable=True),
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
        sa.CheckConstraint("points_spent > 0", name="ck_reward_redemptions_points_spent"),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'fulfilled', 'rejected', 'cancelled')",
            name="ck_reward_redemptions_status",
        ),
    )
    op.create_index(
        "ix_reward_redemptions_user_created",
        "reward_redemptions",
        ["user_id", "created_at"],
    )

    # 7. AI usage telemetry logs
    op.create_table(
        "ai_usage_logs",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("actor", sa.Text(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column(
            "input_tokens",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "output_tokens",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "cache_read_tokens",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_ai_usage_logs_user_created",
        "ai_usage_logs",
        ["user_id", "created_at"],
    )
    op.create_index(
        "ix_ai_usage_logs_endpoint_created",
        "ai_usage_logs",
        ["endpoint", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_ai_usage_logs_endpoint_created", table_name="ai_usage_logs")
    op.drop_index("ix_ai_usage_logs_user_created", table_name="ai_usage_logs")
    op.drop_table("ai_usage_logs")

    op.drop_index("ix_reward_redemptions_user_created", table_name="reward_redemptions")
    op.drop_table("reward_redemptions")
    op.drop_table("reward_items")

    op.drop_table("feature_flags")
    op.drop_table("badges")

    op.drop_index("ix_karma_ledger_proposal_id", table_name="karma_ledger")
    op.drop_index("ix_karma_ledger_user_created", table_name="karma_ledger")
    op.drop_table("karma_ledger")

    op.drop_index("ix_seat_invites_expires_at", table_name="seat_invites")
    op.drop_index("ix_seat_invites_inviter_user_id", table_name="seat_invites")
    op.drop_index("ix_seat_invites_journey_instance_id", table_name="seat_invites")
    op.drop_table("seat_invites")

    op.drop_column("users", "erased_at")
    op.drop_column("users", "erasure_requested_at")
    op.drop_column("users", "leaderboard_opt_in")
