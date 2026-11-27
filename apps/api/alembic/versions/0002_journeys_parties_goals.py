"""Journeys, parties, goals, outbox, and R3 pricing tables

Revision ID: 0002_journeys_parties_goals
Revises: 0001_identity_and_audit
Create Date: 2026-11-25 15:25:00.000000

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_journeys_parties_goals"
down_revision: str | Sequence[str] | None = "0001_identity_and_audit"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    transport_mode = postgresql.ENUM(
        "train",
        "flight",
        "bus",
        name="transport_mode",
        create_type=False,
    )

    op.create_table(
        "journey_instances",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("mode", transport_mode, nullable=False),
        sa.Column("carrier_code", sa.Text(), nullable=False),
        sa.Column("service_no", sa.Text(), nullable=False),
        sa.Column("service_date", sa.Date(), nullable=False),
        sa.Column("departure_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("arrival_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("chart_due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "chart_state",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column("layout_ref", sa.Text(), nullable=True),
        sa.Column(
            "match_version",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint(
            "mode",
            "carrier_code",
            "service_no",
            "service_date",
            name="uq_journey_instances_service",
        ),
        sa.CheckConstraint(
            "chart_state IN ('pending', 'first', 'final', 'na')",
            name="ck_journey_instances_chart_state",
        ),
    )
    op.create_index(
        "ix_journey_instances_chart_due",
        "journey_instances",
        ["chart_state", "chart_due_at"],
    )

    op.create_table(
        "bookings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "journey_instance_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_instances.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "owner_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("owner_anon_id", sa.Text(), nullable=True),
        sa.Column("pnr_hash", sa.LargeBinary(), nullable=False),
        sa.Column("travel_class", sa.Text(), nullable=True),
        sa.Column("from_code", sa.Text(), nullable=True),
        sa.Column("to_code", sa.Text(), nullable=True),
        sa.Column("from_seq", sa.Integer(), nullable=True),
        sa.Column("to_seq", sa.Integer(), nullable=True),
        sa.Column("trust_tier", sa.Text(), nullable=False),
        sa.Column(
            "claim_conflict_flagged",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("last_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("purge_after", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "owner_user_id IS NOT NULL OR owner_anon_id IS NOT NULL",
            name="ck_bookings_owner",
        ),
        sa.CheckConstraint(
            "trust_tier IN ('verified_provider', 'verified_bcbp', 'verified_doc', 'declared')",
            name="ck_bookings_trust_tier",
        ),
    )
    op.create_index(
        "ix_bookings_journey_pnr_hash",
        "bookings",
        ["journey_instance_id", "pnr_hash"],
    )
    op.create_index(
        "uq_bookings_non_bcbp_pnr",
        "bookings",
        ["journey_instance_id", "pnr_hash"],
        unique=True,
        postgresql_where=sa.text("trust_tier <> 'verified_bcbp'"),
    )
    op.create_index("ix_bookings_owner_user_id", "bookings", ["owner_user_id"])
    op.create_index("ix_bookings_owner_anon_id", "bookings", ["owner_anon_id"])
    op.create_index("ix_bookings_purge_after", "bookings", ["purge_after"])

    op.create_table(
        "seat_holders",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "booking_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("bookings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("pax_seq", sa.SmallInteger(), nullable=False),
        sa.Column("booking_status", sa.Text(), nullable=True),
        sa.Column("current_status", sa.Text(), nullable=True),
        sa.Column("coach", sa.Text(), nullable=True),
        sa.Column("seat_no", sa.Text(), nullable=True),
        sa.Column("seat_type", sa.Text(), nullable=True),
        sa.Column("bay", sa.SmallInteger(), nullable=True),
        sa.Column(
            "age_band",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'unknown'"),
        ),
        sa.Column(
            "gender_band",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'U'"),
        ),
        sa.Column(
            "linked_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.UniqueConstraint("booking_id", "pax_seq", name="uq_seat_holders_booking_pax"),
        sa.CheckConstraint(
            "age_band IN ('child', 'adult', 'senior', 'unknown')",
            name="ck_seat_holders_age_band",
        ),
        sa.CheckConstraint(
            "gender_band IN ('F', 'M', 'U')",
            name="ck_seat_holders_gender_band",
        ),
    )
    op.create_index("ix_seat_holders_coach_seat_no", "seat_holders", ["coach", "seat_no"])
    op.create_index("ix_seat_holders_linked_user_id", "seat_holders", ["linked_user_id"])

    op.create_table(
        "parties",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "journey_instance_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_instances.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "leader_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("leader_anon_id", sa.Text(), nullable=True),
        sa.Column("invite_token_hash", sa.LargeBinary(), unique=True, nullable=True),
        sa.Column("invite_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "leader_user_id IS NOT NULL OR leader_anon_id IS NOT NULL",
            name="ck_parties_leader",
        ),
    )
    op.create_index("ix_parties_journey_instance_id", "parties", ["journey_instance_id"])
    op.create_index("ix_parties_leader_user_id", "parties", ["leader_user_id"])
    op.create_index("ix_parties_leader_anon_id", "parties", ["leader_anon_id"])

    op.create_table(
        "party_members",
        sa.Column(
            "party_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("parties.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "seat_holder_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("seat_holders.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("seat_holder_id", name="uq_party_members_seat_holder"),
    )

    op.create_table(
        "goals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "party_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("parties.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("goal_type", sa.Text(), nullable=False),
        sa.Column(
            "movers",
            postgresql.ARRAY(postgresql.UUID(as_uuid=True)),
            nullable=False,
        ),
        sa.Column(
            "preferred_seats",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column(
            "constraints",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "standing_offer",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "goal_type IN ("
            "'together', 'lower', 'upper', 'same_coach', 'window', "
            "'aisle', 'legroom', 'specific_seats', 'open_to_help'"
            ")",
            name="ck_goals_goal_type",
        ),
    )
    op.create_index("ix_goals_party_active", "goals", ["party_id", "active"])
    op.create_index(
        "uq_goals_one_active_per_party",
        "goals",
        ["party_id"],
        unique=True,
        postgresql_where=sa.text("active = true"),
    )

    op.create_table(
        "notifications_outbox",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("event", sa.Text(), nullable=False),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "channel",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'internal'"),
        ),
        sa.Column("idempotency_key", sa.Text(), unique=True, nullable=False),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'queued'"),
        ),
        sa.Column(
            "attempts",
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
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_notifications_outbox_status_created",
        "notifications_outbox",
        ["status", "created_at"],
    )

    op.create_table(
        "payment_orders",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("plan_code", sa.Text(), nullable=False),
        sa.Column(
            "journey_instance_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_instances.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "party_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("parties.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("amount_paise", sa.Integer(), nullable=False),
        sa.Column(
            "currency",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'INR'"),
        ),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("provider_order_id", sa.Text(), unique=True, nullable=True),
        sa.Column("provider_payment_id", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'created'"),
        ),
        sa.Column("idempotency_key", sa.Text(), unique=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("amount_paise >= 0", name="ck_payment_orders_amount_paise"),
        sa.CheckConstraint(
            "provider IN ('razorpay', 'sandbox')",
            name="ck_payment_orders_provider",
        ),
        sa.CheckConstraint(
            "status IN ('created', 'pending', 'paid', 'failed', 'refunded')",
            name="ck_payment_orders_status",
        ),
    )
    op.create_index("ix_payment_orders_user_id", "payment_orders", ["user_id"])
    op.create_index("ix_payment_orders_status", "payment_orders", ["status"])

    op.create_table(
        "payment_webhook_events",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("event_id", sa.Text(), unique=True, nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("signature_valid", sa.Boolean(), nullable=False),
        sa.Column(
            "processed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.create_table(
        "entitlements",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("plan_code", sa.Text(), nullable=False),
        sa.Column(
            "order_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("payment_orders.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "scope_journey_instance_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_instances.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "scope_party_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("parties.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "features",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'active'"),
        ),
        sa.Column(
            "valid_from",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "status IN ('active', 'expired', 'revoked')",
            name="ck_entitlements_status",
        ),
    )
    op.create_index("ix_entitlements_user_status", "entitlements", ["user_id", "status"])
    op.create_index(
        "ix_entitlements_scope_journey", "entitlements", ["scope_journey_instance_id"]
    )
    op.create_index("ix_entitlements_scope_party", "entitlements", ["scope_party_id"])

    op.create_table(
        "b2b_api_keys",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("partner_name", sa.Text(), nullable=False),
        sa.Column("key_prefix", sa.Text(), nullable=False),
        sa.Column("key_hash", sa.LargeBinary(), unique=True, nullable=False),
        sa.Column(
            "scopes",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column(
            "rate_limit_rpm",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("120"),
        ),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'active'"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('active', 'revoked')",
            name="ck_b2b_api_keys_status",
        ),
    )
    op.create_index("ix_b2b_api_keys_user_id", "b2b_api_keys", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_b2b_api_keys_user_id", table_name="b2b_api_keys")
    op.drop_table("b2b_api_keys")

    op.drop_index("ix_entitlements_scope_party", table_name="entitlements")
    op.drop_index("ix_entitlements_scope_journey", table_name="entitlements")
    op.drop_index("ix_entitlements_user_status", table_name="entitlements")
    op.drop_table("entitlements")

    op.drop_table("payment_webhook_events")

    op.drop_index("ix_payment_orders_status", table_name="payment_orders")
    op.drop_index("ix_payment_orders_user_id", table_name="payment_orders")
    op.drop_table("payment_orders")

    op.drop_index("ix_notifications_outbox_status_created", table_name="notifications_outbox")
    op.drop_table("notifications_outbox")

    op.drop_index("uq_goals_one_active_per_party", table_name="goals")
    op.drop_index("ix_goals_party_active", table_name="goals")
    op.drop_table("goals")

    op.drop_table("party_members")

    op.drop_index("ix_parties_leader_anon_id", table_name="parties")
    op.drop_index("ix_parties_leader_user_id", table_name="parties")
    op.drop_index("ix_parties_journey_instance_id", table_name="parties")
    op.drop_table("parties")

    op.drop_index("ix_seat_holders_linked_user_id", table_name="seat_holders")
    op.drop_index("ix_seat_holders_coach_seat_no", table_name="seat_holders")
    op.drop_table("seat_holders")

    op.drop_index("ix_bookings_purge_after", table_name="bookings")
    op.drop_index("ix_bookings_owner_anon_id", table_name="bookings")
    op.drop_index("ix_bookings_owner_user_id", table_name="bookings")
    op.drop_index("uq_bookings_non_bcbp_pnr", table_name="bookings")
    op.drop_index("ix_bookings_journey_pnr_hash", table_name="bookings")
    op.drop_table("bookings")

    op.drop_index("ix_journey_instances_chart_due", table_name="journey_instances")
    op.drop_table("journey_instances")
