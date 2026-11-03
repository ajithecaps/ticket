"""Seasonal gifts (e.g. the Halloween treat): one per person per event.

Revision ID: 0016
Revises: 0015
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "seasonal_gifts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event", sa.String(40), nullable=False),
        sa.Column("treat", sa.String(30), nullable=False),
        sa.Column("points", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("opened_day", sa.Date(), nullable=True),
        sa.UniqueConstraint("user_id", "event", name="uq_seasonal_gift_user_event"),
    )
    op.create_index("ix_seasonal_gifts_user_id", "seasonal_gifts", ["user_id"])


def downgrade() -> None:
    op.drop_table("seasonal_gifts")
