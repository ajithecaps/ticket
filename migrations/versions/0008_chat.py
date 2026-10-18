"""Team chat: channels, members, messages (threads), reactions, files, real-time event outbox, presence.

Revision ID: 0008
Revises: 0007
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "chat_channels",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("name", sa.String(80), nullable=True),
        sa.Column("topic", sa.String(300), nullable=False),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, unique=True),
        sa.Column("is_private", sa.Boolean(), nullable=False),
        sa.Column("archived", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("last_message_at", TS, nullable=True),
    )
    op.create_index("ix_chat_channels_kind", "chat_channels", ["kind"])
    op.create_table(
        "chat_members",
        sa.Column("channel_id", sa.Integer(), sa.ForeignKey("chat_channels.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("last_read_id", sa.Integer(), nullable=False),
        sa.Column("muted", sa.Boolean(), nullable=False),
        sa.Column("joined_at", TS, nullable=False),
    )
    op.create_index("ix_chat_members_user_id", "chat_members", ["user_id"])
    op.create_table(
        "chat_messages",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("channel_id", sa.Integer(), sa.ForeignKey("chat_channels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("parent_id", sa.Integer(), sa.ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("reply_count", sa.Integer(), nullable=False),
        sa.Column("last_reply_at", TS, nullable=True),
        sa.Column("pinned", sa.Boolean(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False),
        sa.Column("edited_at", TS, nullable=True),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_index("ix_chat_messages_channel_parent", "chat_messages", ["channel_id", "parent_id", "id"])
    op.create_table(
        "chat_reactions",
        sa.Column("message_id", sa.Integer(), sa.ForeignKey("chat_messages.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("emoji", sa.String(32), primary_key=True),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_table(
        "chat_files",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("message_id", sa.Integer(), sa.ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("stored_name", sa.String(255), nullable=False),
        sa.Column("content_type", sa.String(120), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
    )
    op.create_index("ix_chat_files_message_id", "chat_files", ["message_id"])
    op.create_table(
        "chat_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("channel_id", sa.Integer(), nullable=True),
        sa.Column("user_ids", sa.Text(), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_index("ix_chat_events_created_at", "chat_events", ["created_at"])
    op.create_table(
        "chat_presence",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("last_seen", TS, nullable=False),
    )


def downgrade() -> None:
    for name in ("chat_presence", "chat_events", "chat_files", "chat_reactions", "chat_messages", "chat_members", "chat_channels"):
        op.drop_table(name)
