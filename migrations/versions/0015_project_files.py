"""Project files: folders and documents kept per project (outside any one ticket).

Revision ID: 0015
Revises: 0014
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_folders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("parent_id", sa.Integer(), sa.ForeignKey("project_folders.id", ondelete="CASCADE"), nullable=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_project_folders_project_id", "project_folders", ["project_id"])
    op.create_index("ix_project_folders_parent_id", "project_folders", ["parent_id"])
    op.create_table(
        "project_files",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("folder_id", sa.Integer(), sa.ForeignKey("project_folders.id", ondelete="CASCADE"), nullable=True),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("stored_name", sa.String(255), nullable=False),
        sa.Column("content_type", sa.String(120), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("uploaded_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_project_files_project_id", "project_files", ["project_id"])
    op.create_index("ix_project_files_folder_id", "project_files", ["folder_id"])


def downgrade() -> None:
    op.drop_table("project_files")
    op.drop_table("project_folders")
