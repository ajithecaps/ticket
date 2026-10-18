// Documentation: Markdown pages per project, nested, with a page tree, table of contents and history.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { currentQuery, navigate } from "../app.js";
import { markdownEditor, renderMarkdown } from "../markdown.js";
import { avatar, busy, clear, confirmDialog, copyText, emptyState, fmtDateTime, h, select, spinner, timeAgo, toast } from "../ui.js";

const OPEN_KEY = "tickets.docs.collapsed";
function loadCollapsed() { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]")); } catch { return new Set(); } }
function saveCollapsed(set) { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* per-viewer only */ } }

// ----------------------------------------------------------------------------- page tree
/** Sidebar: projects → nested pages. `activeId` is highlighted; `projectId` limits to one project. */
async function docTree({ activeId = null, projectId = null } = {}) {
  const [pages, projects] = await Promise.all([api.get("/docs", { project_id: projectId || undefined }), api.get("/projects")]);
  const collapsed = loadCollapsed();
  const byParent = new Map();
  pages.forEach((p) => {
    const key = `${p.project.id}:${p.parent_id || 0}`;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(p);
  });
  // a page whose parent is gone (or in another listing) shows at the top level
  const ids = new Set(pages.map((p) => p.id));
  pages.forEach((p) => {
    if (p.parent_id && !ids.has(p.parent_id)) {
      const key = `${p.project.id}:0`;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(p);
    }
  });
  const activeChain = new Set();
  if (activeId) {
    let cur = pages.find((p) => p.id === activeId);
    while (cur) { activeChain.add(cur.id); cur = pages.find((p) => p.id === cur.parent_id); }
  }

  const branch = (projectIdKey, parentId, depth) => {
    const items = byParent.get(`${projectIdKey}:${parentId}`) || [];
    if (!items.length) return null;
    return h("ul.doc-tree-list", items.map((p) => {
      const kids = byParent.get(`${projectIdKey}:${p.id}`);
      const open = !collapsed.has(`p${p.id}`) || activeChain.has(p.id);
      const toggle = kids && h("button.doc-twisty", {
        type: "button", "aria-label": open ? "Collapse" : "Expand", "aria-expanded": String(open),
        onclick: (e) => { e.preventDefault(); if (open) collapsed.add(`p${p.id}`); else collapsed.delete(`p${p.id}`); saveCollapsed(collapsed); rerender(); },
      }, open ? "▾" : "▸");
      return h("li",
        h(`a.doc-tree-item${p.id === activeId ? ".active" : ""}`, { href: `#/docs/${p.id}`, style: { paddingLeft: `${8 + depth * 14}px` }, title: p.title },
          toggle || h("span.doc-twisty-gap"), h("span.ellipsis", p.title)),
        open && kids ? branch(projectIdKey, p.id, depth + 1) : null);
    }));
  };

  const shownProjects = projects.filter((p) => !projectId || p.id === projectId);
  const wrap = h("nav.doc-tree", { "aria-label": "Documentation pages" });
  function rerender() {
    clear(wrap, shownProjects.map((proj) => {
      const open = !collapsed.has(`proj${proj.id}`);
      const count = pages.filter((p) => p.project.id === proj.id).length;
      return h("section.doc-tree-project",
        h("div.doc-tree-head",
          h("button.doc-twisty", {
            type: "button", "aria-expanded": String(open),
            onclick: () => { if (open) collapsed.add(`proj${proj.id}`); else collapsed.delete(`proj${proj.id}`); saveCollapsed(collapsed); rerender(); },
          }, open ? "▾" : "▸"),
          h("span.key-pill", proj.key), h("span.ellipsis.grow", proj.name), h("span.muted.small", String(count)),
          h("a.icon-btn.small", { href: `#/docs/new?project=${proj.id}`, title: `New page in ${proj.name}`, "aria-label": "New page" }, icon("plus", { size: 14 }))),
        open ? (branch(proj.id, 0, 0) || h("p.muted.small.doc-tree-empty", "No pages yet")) : null);
    }));
  }
  rerender();
  return { el: wrap, pages, projects };
}

function layout(main, tree, content) {
  clear(main, h("div.docs-layout", h("aside.docs-side", tree), h("div.docs-main", content)));
}

// ----------------------------------------------------------------------------- home + search
export async function renderDocsHome(main, { projectId = null } = {}) {
  const q0 = currentQuery().get("q") || "";
  const tree = await docTree({ projectId });
  const results = h("div");
  let timer;
  const search = h("input.doc-search", {
    type: "search", placeholder: "Search documentation…", value: q0, "aria-label": "Search documentation",
    oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => runSearch(e.target.value.trim()), 200); },
  });

  async function runSearch(q) {
    if (!q) { showRecent(); return; }
    clear(results, spinner());
    const hits = await api.get("/docs", { q, project_id: projectId || undefined });
    clear(results, hits.length
      ? h("ul.doc-results", hits.map((p) => h("li", h("a", { href: `#/docs/${p.id}` }, h("strong", p.title)),
        h("span.muted.small", ` · ${p.project.name}`), p.snippet && h("p.muted.small", p.snippet))))
      : emptyState("No pages match", `Nothing found for “${q}”.`));
  }
  function showRecent() {
    const recent = [...tree.pages].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12);
    clear(results, recent.length
      ? [h("h2", "Recently updated"), h("ul.doc-results", recent.map((p) => h("li",
        h("a", { href: `#/docs/${p.id}` }, h("strong", p.title)),
        h("span.muted.small", ` · ${p.project.name} · ${p.editor ? p.editor.name + ", " : ""}${timeAgo(p.updated_at)}`))))]
      : emptyState("No documentation yet", "Create the first page with + next to a project in the tree.",
        tree.projects[0] && h("a.btn.primary", { href: `#/docs/new?project=${projectId || tree.projects[0].id}` }, "New page")));
  }

  layout(main, tree.el, [
    !projectId && h("div.page-head", h("div", h("h1", "Documentation"), h("p.muted", "Specs, runbooks and how-tos for every project - written in Markdown."))),
    h("div.doc-search-row", search),
    h("section.card", results),
  ]);
  if (q0) runSearch(q0); else showRecent();
}

// ----------------------------------------------------------------------------- page view
export async function renderDocPage(main, id) {
  const page = await api.get(`/docs/${id}`);
  const tree = await docTree({ activeId: page.id });

  const content = renderMarkdown(page.content, page.can_edit ? {
    onTaskToggle: async (text) => { await api.patch(`/docs/${page.id}`, { content: text }); page.content = text; },
  } : {});
  // table of contents from the rendered headings
  const heads = [...content.querySelectorAll("h1, h2, h3")].filter((x) => !x.closest(".footnotes"));
  const toc = heads.length > 2 && h("nav.doc-toc", { "aria-label": "On this page" },
    h("div.doc-toc-title", "On this page"),
    heads.map((hd) => h(`a.toc-${hd.tagName.toLowerCase()}`, {
      href: `#${hd.id}`, onclick: (e) => { e.preventDefault(); hd.scrollIntoView({ behavior: "smooth", block: "start" }); },
    }, hd.firstChild?.textContent || hd.textContent.replace(/#$/, ""))));

  const remove = async () => {
    if (!(await confirmDialog("Delete page", `Delete “${page.title}”? Its sub-pages move up one level.`))) return;
    await busy(null, async () => { await api.del(`/docs/${page.id}`); toast("Page deleted"); navigate("/docs"); });
  };

  layout(main, tree.el, h("div.doc-page",
    h("div.crumbs", h("a", { href: "#/docs" }, "Docs"), " / ", h("a", { href: `#/projects/${page.project.id}/docs` }, page.project.name),
      page.breadcrumbs.map((b) => [" / ", h("a", { href: `#/docs/${b.id}` }, b.title)])),
    h("div.doc-head",
      h("h1.doc-title", page.title),
      h("div.row.wrap.doc-actions",
        page.can_edit && h("a.btn.primary.sm", { href: `#/docs/${page.id}/edit` }, "Edit"),
        page.can_edit && h("a.btn.sm", { href: `#/docs/new?project=${page.project.id}&parent=${page.id}` }, "+ Sub-page"),
        h("a.btn.sm.ghost", { href: `#/docs/${page.id}/history` }, `History${page.revision_count ? ` (${page.revision_count})` : ""}`),
        h("button.btn.sm.ghost", { onclick: () => copyText(location.href, "Link copied") }, "Copy link"),
        page.can_delete && h("button.btn.sm.ghost.danger", { onclick: remove }, "Delete"))),
    h("div.doc-meta.muted.small",
      page.editor && avatar(page.editor, "sm"),
      `Last edited ${page.editor ? `by ${page.editor.name} ` : ""}${timeAgo(page.updated_at)}`,
      page.creator && page.creator.id !== page.editor?.id ? ` · created by ${page.creator.name}` : ""),
    h("div.doc-body",
      h("article.card.doc-article", page.content.trim() ? content : emptyState("This page is empty", page.can_edit ? "Click Edit to write it." : null)),
      toc || null),
    page.children.length > 0 && h("section.card.doc-children",
      h("h2", "Pages in this section"),
      h("div.doc-child-grid", page.children.map((c) => h("a.doc-child", { href: `#/docs/${c.id}` },
        h("strong", c.title), h("span.muted.small", `Updated ${timeAgo(c.updated_at)}`)))))));
}

// ----------------------------------------------------------------------------- editor
export async function renderDocEditor(main, id) {
  const q = currentQuery();
  const editing = Boolean(id);
  const page = editing ? await api.get(`/docs/${id}`) : null;
  const projectId = editing ? page.project.id : Number(q.get("project"));
  if (!projectId) { navigate("/docs"); return; }
  const tree = await docTree({ activeId: page?.id, projectId: null });
  const siblings = tree.pages.filter((p) => p.project.id === projectId && p.id !== page?.id);
  const project = tree.projects.find((p) => p.id === projectId);

  const title = h("input.doc-title-input", { value: page?.title || "", placeholder: "Page title", maxLength: 200, required: true, "aria-label": "Title" });
  const parentSel = select("parent", [["", "— Top level —"], ...siblings.map((p) => [String(p.id), p.title])],
    editing ? (page.parent_id || "") : (q.get("parent") || ""), { "aria-label": "Parent page" });
  const editor = markdownEditor({ value: page?.content || "", rows: 24, label: "Content",
    placeholder: "Write in Markdown. Type / for tables, diagrams, callouts, math…" });
  const original = { title: page?.title || "", content: page?.content || "" };
  const dirty = () => title.value.trim() !== original.title || editor.value !== original.content;

  const save = (btn) => busy(btn, async () => {
    if (!title.value.trim()) { toast("Give the page a title", "error"); title.focus(); return; }
    const body = { title: title.value.trim(), content: editor.value, parent_id: parentSel.value ? Number(parentSel.value) : null };
    const saved = editing ? await api.patch(`/docs/${page.id}`, body) : await api.post(`/projects/${projectId}/docs`, body);
    original.title = body.title; original.content = body.content;
    toast(editing ? "Saved" : "Page created");
    navigate(`/docs/${saved.id}`);
  });
  const saveBtn = h("button.btn.primary", { onclick: (e) => save(e.currentTarget) }, editing ? "Save" : "Create page");
  const cancel = async () => {
    if (dirty() && !(await confirmDialog("Discard changes?", "Your edits to this page will be lost.", "Discard"))) return;
    navigate(editing ? `/docs/${page.id}` : "/docs");
  };
  editor.textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(saveBtn); }
  });
  const onUnload = (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", onUnload);

  layout(main, tree.el, h("div.doc-page.doc-editing",
    h("div.crumbs", h("a", { href: "#/docs" }, "Docs"), " / ", project ? project.name : "", editing ? [" / ", h("a", { href: `#/docs/${page.id}` }, page.title)] : null),
    h("div.doc-edit-head", title, h("div.row", h("button.btn", { onclick: cancel }, "Cancel"), saveBtn)),
    h("div.row.wrap.doc-edit-meta", h("label.inline", "Parent", parentSel), h("span.muted.small", "Ctrl/⌘ + S saves · every save keeps the previous version in History")),
    editor.el));
  editor.setMode("split");
  (editing ? editor : { focus: () => title.focus() }).focus();
  return () => window.removeEventListener("beforeunload", onUnload);
}

// ----------------------------------------------------------------------------- history
export async function renderDocHistory(main, id) {
  const [page, revisions] = await Promise.all([api.get(`/docs/${id}`), api.get(`/docs/${id}/revisions`)]);
  const tree = await docTree({ activeId: page.id });
  const viewer = h("div.card.doc-rev-view");

  async function show(rev, btn) {
    document.querySelectorAll(".doc-rev").forEach((x) => x.classList.toggle("active", x === btn));
    if (!rev) {
      clear(viewer, h("div.card-head", h("h2", "Current version"), h("span.muted.small", `${page.editor ? page.editor.name + " · " : ""}${fmtDateTime(page.updated_at)}`)),
        h("h1.doc-title", page.title), renderMarkdown(page.content));
      return;
    }
    clear(viewer, spinner());
    const full = await api.get(`/docs/${id}/revisions/${rev.id}`);
    clear(viewer,
      h("div.card-head", h("h2", `Version from ${fmtDateTime(full.created_at)}`),
        page.can_edit && h("button.btn.sm.primary", {
          onclick: (e) => busy(e.currentTarget, async () => {
            await api.post(`/docs/${id}/revisions/${rev.id}/restore`);
            toast("Version restored");
            navigate(`/docs/${id}`);
          }),
        }, "Restore this version")),
      h("p.muted.small", full.author ? `Written by ${full.author.name}` : ""),
      h("h1.doc-title", full.title), renderMarkdown(full.content));
  }

  const current = h("button.doc-rev.active", { type: "button", onclick: (e) => show(null, e.currentTarget) },
    h("strong", "Current"), h("span.muted.small", `${page.editor ? page.editor.name + " · " : ""}${timeAgo(page.updated_at)}`));
  layout(main, tree.el, h("div.doc-page",
    h("div.crumbs", h("a", { href: "#/docs" }, "Docs"), " / ", h("a", { href: `#/docs/${page.id}` }, page.title), " / History"),
    h("h1.doc-title", "History"),
    h("div.doc-history",
      h("div.card.flush.doc-rev-list", current,
        revisions.length ? revisions.map((r) => h("button.doc-rev", { type: "button", onclick: (e) => show(r, e.currentTarget) },
          h("strong", fmtDateTime(r.created_at)), h("span.muted.small", `${r.author ? r.author.name : "Unknown"} · ${r.title}`)))
          : h("p.muted.small.pad", "No earlier versions yet.")),
      viewer)));
  show(null, current);
}
