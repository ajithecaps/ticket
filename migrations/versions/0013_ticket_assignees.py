"""Several people can be assigned to one ticket (the lead stays in tickets.assignee_id).

Revision ID: 0013
Revises: 0012
"""
from collections.abc import Sequence
from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ticket_assignees",
        sa.Column("ticket_id", sa.Integer(), sa.ForeignKey("tickets.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_ticket_assignees_user_id", "ticket_assignees", ["user_id"])
    # Every existing assignee becomes the lead of their ticket.
    now = datetime.now(timezone.utc)
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, assignee_id, assigned_at FROM tickets WHERE assignee_id IS NOT NULL")).all()
    if rows:
        conn.execute(
            sa.text("INSERT INTO ticket_assignees (ticket_id, user_id, position, assigned_at) VALUES (:t, :u, 0, :a)"),
            [{"t": r[0], "u": r[1], "a": r[2] or now} for r in rows],
        )


def downgrade() -> None:
    op.drop_table("ticket_assignees")
