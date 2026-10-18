"""Chat audio/video calls and their participants.

Revision ID: 0009
Revises: 0008
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "chat_calls",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("channel_id", sa.Integer(), sa.ForeignKey("chat_channels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("message_id", sa.Integer(), sa.ForeignKey("chat_messages.id", ondelete="SET NULL"), nullable=True, unique=True),
        sa.Column("started_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("video", sa.Boolean(), nullable=False),
        sa.Column("started_at", TS, nullable=False),
        sa.Column("answered_at", TS, nullable=True),
        sa.Column("ended_at", TS, nullable=True),
    )
    op.create_index("ix_chat_calls_channel_id", "chat_calls", ["channel_id"])
    op.create_table(
        "chat_call_participants",
        sa.Column("call_id", sa.Integer(), sa.ForeignKey("chat_calls.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("joined_at", TS, nullable=False),
        sa.Column("left_at", TS, nullable=True),
    )


def downgrade() -> None:
    op.drop_table("chat_call_participants")
    op.drop_table("chat_calls")
