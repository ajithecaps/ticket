"""Documentation: Markdown pages per project, nested, with revision history.

Project members read and write pages (wiki-style); project owners and admins can delete them.
Every edit keeps the previous title and content as a revision that can be viewed or restored.
"""
from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, or_, select

from ..deps import CurrentUser, DbSession
from ..models import DocPage, DocRevision, Project, ProjectMember
from ..permissions import is_admin, is_project_owner, require_member
from ..schemas import DocBrief, DocCreate, DocOut, DocRevisionDetail, DocRevisionOut, DocUpdate
from ..utils import escape_like

router = APIRouter(tags=["Docs"])


def _get(db, user, page_id: int) -> DocPage:
    page = db.get(DocPage, page_id)
    if page is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Page not found")
    require_member(db, user, page.project_id)
    return page


def _out(db, user, page: DocPage) -> DocOut:
    out = DocOut.model_validate(page)
    crumbs, seen, parent_id = [], {page.id}, page.parent_id
    while parent_id and parent_id not in seen:
        parent = db.get(DocPage, parent_id)
        if parent is None:
            break
        crumbs.insert(0, DocBrief.model_validate(parent))
        seen.add(parent.id)
        parent_id = parent.parent_id
    out.breadcrumbs = crumbs
    out.children = [DocBrief.model_validate(c) for c in db.scalars(
        select(DocPage).where(DocPage.parent_id == page.id).order_by(DocPage.position, DocPage.title)).unique()]
    out.revision_count = db.scalar(select(func.count()).select_from(DocRevision).where(DocRevision.page_id == page.id)) or 0
    out.can_edit = True  # any member (require_member already passed)
    out.can_delete = is_project_owner(db, user, page.project_id)
    return out


def _check_parent(db, page: DocPage | None, project_id: int, parent_id: int | None) -> None:
    if parent_id is None:
        return
    parent = db.get(DocPage, parent_id)
    if parent is None or parent.project_id != project_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The parent page must be in the same project")
    if page is not None:  # no cycles: the new parent may not be the page itself or one of its descendants
        node = parent
        while node is not None:
            if node.id == page.id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "A page cannot be moved under itself")
            node = db.get(DocPage, node.parent_id) if node.parent_id else None


def _snippet(content: str, q: str) -> str:
    i = content.lower().find(q.lower())
    if i < 0:
        return content[:140].replace("\n", " ")
    start = max(0, i - 60)
    return ("…" if start else "") + content[start:i + len(q) + 80].replace("\n", " ") + "…"


@router.get("/docs", response_model=list[DocBrief], summary="Pages I can read (tree data, or search with q)")
def list_docs(
    user: CurrentUser,
    db: DbSession,
    project_id: int | None = None,
    q: str | None = Query(None, min_length=1, max_length=100),
):
    stmt = select(DocPage).join(Project, Project.id == DocPage.project_id).where(Project.is_active.is_(True))
    if not is_admin(user):
        stmt = stmt.where(DocPage.project_id.in_(select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)))
    if project_id is not None:
        stmt = stmt.where(DocPage.project_id == project_id)
    if q:
        like = f"%{escape_like(q.strip())}%"
        stmt = stmt.where(or_(DocPage.title.ilike(like, escape="\\"), DocPage.content.ilike(like, escape="\\")))
    stmt = stmt.order_by(Project.name, DocPage.position, DocPage.title)
    out = []
    for page in db.scalars(stmt).unique():
        item = DocBrief.model_validate(page)
        if q:
            item.snippet = _snippet(page.content, q.strip())
        out.append(item)
    return out


@router.post("/projects/{project_id}/docs", response_model=DocOut, status_code=status.HTTP_201_CREATED)
def create_doc(project_id: int, payload: DocCreate, user: CurrentUser, db: DbSession):
    require_member(db, user, project_id)
    _check_parent(db, None, project_id, payload.parent_id)
    position = (db.scalar(select(func.max(DocPage.position)).where(
        DocPage.project_id == project_id, DocPage.parent_id.is_(payload.parent_id) if payload.parent_id is None
        else DocPage.parent_id == payload.parent_id)) or 0) + 1
    page = DocPage(project_id=project_id, parent_id=payload.parent_id, title=payload.title, content=payload.content,
                   position=position, created_by=user.id, updated_by=user.id)
    db.add(page)
    db.commit()
    db.refresh(page)
    return _out(db, user, page)


@router.get("/docs/{page_id}", response_model=DocOut)
def get_doc(page_id: int, user: CurrentUser, db: DbSession):
    return _out(db, user, _get(db, user, page_id))


@router.patch("/docs/{page_id}", response_model=DocOut)
def update_doc(page_id: int, payload: DocUpdate, user: CurrentUser, db: DbSession):
    page = _get(db, user, page_id)
    data = payload.model_dump(exclude_unset=True)
    if "title" in data:
        if not data["title"] or not data["title"].strip():
            raise HTTPException(422, "title cannot be empty")
        data["title"] = data["title"].strip()
    if "content" in data and data["content"] is None:
        data["content"] = ""
    if "parent_id" in data:
        _check_parent(db, page, page.project_id, data["parent_id"])

    text_changed = any(k in data and data[k] != getattr(page, k) for k in ("title", "content"))
    if text_changed:
        db.add(DocRevision(page_id=page.id, title=page.title, content=page.content, edited_by=page.updated_by))
        page.updated_by = user.id
    for key, value in data.items():
        setattr(page, key, value)
    db.commit()
    db.refresh(page)
    return _out(db, user, page)


@router.delete("/docs/{page_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_doc(page_id: int, user: CurrentUser, db: DbSession):
    """Project owners / admins. Sub-pages move up to the deleted page's parent."""
    page = _get(db, user, page_id)
    if not is_project_owner(db, user, page.project_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only project owners can delete documentation pages")
    for child in db.scalars(select(DocPage).where(DocPage.parent_id == page.id)).unique():
        child.parent_id = page.parent_id
    db.delete(page)
    db.commit()


@router.get("/docs/{page_id}/revisions", response_model=list[DocRevisionOut])
def list_revisions(page_id: int, user: CurrentUser, db: DbSession):
    page = _get(db, user, page_id)
    return page.revisions


@router.get("/docs/{page_id}/revisions/{revision_id}", response_model=DocRevisionDetail)
def get_revision(page_id: int, revision_id: int, user: CurrentUser, db: DbSession):
    _get(db, user, page_id)
    rev = db.get(DocRevision, revision_id)
    if rev is None or rev.page_id != page_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Revision not found")
    return rev


@router.post("/docs/{page_id}/revisions/{revision_id}/restore", response_model=DocOut)
def restore_revision(page_id: int, revision_id: int, user: CurrentUser, db: DbSession):
    rev = get_revision(page_id, revision_id, user, db)
    return update_doc(page_id, DocUpdate(title=rev.title, content=rev.content), user, db)
