"""Matching candidates, swap proposals, seat locks, swap cards, and blocks

Revision ID: 0003_matching_swaps_cards
Revises: 0002_journeys_parties_goals_pricing
Create Date: 2026-11-25 16:45:00.000000

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_matching_swaps_cards"
down_revision: str | Sequence[str] | None = "0002_journeys_parties_goals_pricing"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "match_candidates",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "journey_instance_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_instances.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("match_version", sa.BigInteger(), nullable=False),
        sa.Column(
            "for_party_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("parties.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("card_id", sa.Text(), unique=True, nullable=False),
        sa.Column(
            "cycle_seat_holders",
            postgresql.ARRAY(postgresql.UUID(as_uuid=True)),
            nullable=False,
        ),
        sa.Column(
            "plan_cycles",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("score", sa.SmallInteger(), nullable=False),
        sa.Column(
            "reasons",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint("score >= 0 AND score <= 100", name="ck_match_candidates_score"),
        sa.CheckConstraint(
            "kind IN ('pair', 'cycle3', 'cycle4', 'plan')",
            name="ck_match_candidates_kind",
        ),
    )
    op.create_index(
        "ix_match_candidates_party_ver_score",
        "match_candidates",
        ["for_party_id", sa.text("match_version DESC"), sa.text("score DESC")],
    )
    op.create_index(
        "ix_match_candidates_journey_ver",
        "match_candidates",
        ["journey_instance_id", "match_version"],
    )

    op.create_table(
        "swap_proposals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "journey_instance_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_instances.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "initiator_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("decline_reason", sa.Text(), nullable=True),
        sa.Column("source_card_id", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "kind IN ('pair', 'cycle3', 'cycle4', 'plan')",
            name="ck_swap_proposals_kind",
        ),
        sa.CheckConstraint(
            "status IN ("
            "'draft', 'pending', 'confirmed', 'declined', 'expired', "
            "'invalidated', 'cancelled', 'awaiting_confirmation', 'completed', 'not_completed'"
            ")",
            name="ck_swap_proposals_status",
        ),
    )
    op.create_index(
        "ix_swap_proposals_journey_status",
        "swap_proposals",
        ["journey_instance_id", "status"],
    )
    op.create_index(
        "ix_swap_proposals_status_expires",
        "swap_proposals",
        ["status", "expires_at"],
    )
    op.create_index(
        "ix_swap_proposals_initiator",
        "swap_proposals",
        ["initiator_user_id"],
    )

    op.create_table(
        "swap_participants",
        sa.Column(
            "proposal_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("swap_proposals.id", ondelete="CASCADE"),
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
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("alias", sa.Text(), nullable=False),
        sa.Column("gives_seat", sa.Text(), nullable=False),
        sa.Column("gets_seat", sa.Text(), nullable=False),
        sa.Column("gives_coach", sa.Text(), nullable=True),
        sa.Column("gets_coach", sa.Text(), nullable=True),
        sa.Column("gives_seat_type", sa.Text(), nullable=True),
        sa.Column("gets_seat_type", sa.Text(), nullable=True),
        sa.Column("gives_bay", sa.SmallInteger(), nullable=True),
        sa.Column("gets_bay", sa.SmallInteger(), nullable=True),
        sa.Column(
            "decision",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("post_confirm", sa.Text(), nullable=True),
        sa.Column("post_confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "decision IN ('pending', 'accepted', 'declined')",
            name="ck_swap_participants_decision",
        ),
        sa.CheckConstraint(
            "post_confirm IS NULL OR post_confirm IN ('yes', 'no', 'did_not_board')",
            name="ck_swap_participants_post_confirm",
        ),
    )
    op.create_index("ix_swap_participants_user_id", "swap_participants", ["user_id"])

    op.create_table(
        "seat_locks",
        sa.Column(
            "seat_holder_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("seat_holders.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "proposal_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("swap_proposals.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "locked_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_seat_locks_proposal_id", "seat_locks", ["proposal_id"])

    op.create_table(
        "swap_cards",
        sa.Column(
            "proposal_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("swap_proposals.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("public_code", sa.Text(), unique=True, nullable=False),
        sa.Column("payload_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("signature", sa.LargeBinary(), nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("revoked_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.create_table(
        "blocks",
        sa.Column(
            "blocker",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "blocked",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )


def downgrade() -> None:
    op.drop_table("blocks")
    op.drop_table("swap_cards")
    op.drop_index("ix_seat_locks_proposal_id", table_name="seat_locks")
    op.drop_table("seat_locks")
    op.drop_index("ix_swap_participants_user_id", table_name="swap_participants")
    op.drop_table("swap_participants")
    op.drop_index("ix_swap_proposals_initiator", table_name="swap_proposals")
    op.drop_index("ix_swap_proposals_status_expires", table_name="swap_proposals")
    op.drop_index("ix_swap_proposals_journey_status", table_name="swap_proposals")
    op.drop_table("swap_proposals")
    op.drop_index("ix_match_candidates_journey_ver", table_name="match_candidates")
    op.drop_index("ix_match_candidates_party_ver_score", table_name="match_candidates")
    op.drop_table("match_candidates")
