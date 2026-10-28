"""Daily challenge attempts (puzzle of the day + leaderboard).

Revision ID: 0012
Revises: 0011
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "challenge_attempts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("solved", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("penalty_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("moves", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.UniqueConstraint("user_id", "day", name="uq_challenge_user_day"),
    )
    op.create_index("ix_challenge_attempts_user_id", "challenge_attempts", ["user_id"])
    op.create_index("ix_challenge_attempts_day", "challenge_attempts", ["day"])


def downgrade() -> None:
    op.drop_table("challenge_attempts")
