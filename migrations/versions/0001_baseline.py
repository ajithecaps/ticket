"""Baseline: the schema as it was before migrations were introduced.

Databases created earlier by `Base.metadata.create_all()` (or seed.py) already have these tables, so
each table is created only when it is missing. `alembic upgrade head` therefore works on an empty
database and on an existing one alike - no manual `alembic stamp` needed.

Enum columns are plain VARCHAR(20) (the models use native_enum=False), so adding an enum value never
needs a migration.

Revision ID: 0001
Revises:
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.DateTime(timezone=True)
ENUM = sa.String(20)


def _create(name: str, *columns, indexes: Sequence[tuple[str, list[str], bool]] = ()) -> None:
    if sa.inspect(op.get_bind()).has_table(name):
        return
    op.create_table(name, *columns)
    for index_name, cols, unique in indexes:
        op.create_index(index_name, name, cols, unique=unique)


def upgrade() -> None:
    _create(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("role", ENUM, nullable=False),
        sa.Column("designation", sa.String(120), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        indexes=[("ix_users_email", ["email"], True)],
    )
    _create(
        "projects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(150), nullable=False, unique=True),
        sa.Column("key", sa.String(10), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("ticket_counter", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", TS, nullable=False),
        indexes=[("ix_projects_key", ["key"], True)],
    )
    _create(
        "project_members",
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", ENUM, nullable=False),
        sa.Column("joined_at", TS, nullable=False),
        indexes=[("ix_project_members_user_id", ["user_id"], False)],
    )
    _create(
        "tickets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", ENUM, nullable=False),
        sa.Column("priority", ENUM, nullable=False),
        sa.Column("type", ENUM, nullable=False),
        sa.Column("reporter_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("assignee_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("due_date", TS, nullable=True),
        sa.Column("estimated_hours", sa.Float(), nullable=True),
        sa.Column("spent_hours", sa.Float(), nullable=False),
        sa.Column("assigned_at", TS, nullable=True),
        sa.Column("started_at", TS, nullable=True),
        sa.Column("completed_at", TS, nullable=True),
        sa.Column("reopen_count", sa.Integer(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.UniqueConstraint("project_id", "number", name="uq_ticket_project_number"),
        indexes=[
            ("ix_tickets_assignee_status", ["assignee_id", "status"], False),
            ("ix_tickets_project_id", ["project_id"], False),
            ("ix_tickets_reporter_id", ["reporter_id"], False),
            ("ix_tickets_status", ["status"], False),
        ],
    )
    _create(
        "activities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("ticket_id", sa.Integer(), sa.ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("actor_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("action", sa.String(50), nullable=False),
        sa.Column("field", sa.String(50), nullable=True),
        sa.Column("old_value", sa.Text(), nullable=True),
        sa.Column("new_value", sa.Text(), nullable=True),
        sa.Column("created_at", TS, nullable=False),
        indexes=[("ix_activities_ticket_id", ["ticket_id"], False)],
    )
    _create(
        "comments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("ticket_id", sa.Integer(), sa.ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("edited_at", TS, nullable=True),
        indexes=[("ix_comments_ticket_id", ["ticket_id"], False)],
    )
    _create(
        "comment_mentions",
        sa.Column("comment_id", sa.Integer(), sa.ForeignKey("comments.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    )
    _create(
        "attachments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("ticket_id", sa.Integer(), sa.ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("comment_id", sa.Integer(), sa.ForeignKey("comments.id", ondelete="CASCADE"), nullable=True),
        sa.Column("uploaded_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("stored_name", sa.String(255), nullable=False),
        sa.Column("content_type", sa.String(120), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        indexes=[
            ("ix_attachments_comment_id", ["comment_id"], False),
            ("ix_attachments_ticket_id", ["ticket_id"], False),
        ],
    )
    _create(
        "worklogs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("ticket_id", sa.Integer(), sa.ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("hours", sa.Float(), nullable=False),
        sa.Column("note", sa.String(500), nullable=False),
        sa.Column("logged_at", TS, nullable=False),
        indexes=[("ix_worklogs_ticket_id", ["ticket_id"], False)],
    )
    _create(
        "notifications",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("actor_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("type", ENUM, nullable=False),
        sa.Column("message", sa.String(500), nullable=False),
        sa.Column("ticket_id", sa.Integer(), sa.ForeignKey("tickets.id", ondelete="CASCADE"), nullable=True),
        sa.Column("is_read", sa.Boolean(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        indexes=[("ix_notifications_user_read", ["user_id", "is_read"], False)],
    )


def downgrade() -> None:
    for name in ("notifications", "worklogs", "attachments", "comment_mentions", "comments",
                 "activities", "tickets", "project_members", "projects", "users"):
        op.drop_table(name)
