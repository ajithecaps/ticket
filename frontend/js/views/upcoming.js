// Upcoming tasks: per-project requirements gathered before a ticket exists. Admins edit; members read.
import { api, auth, request } from "../api.js";
import { icon } from "../icons.js";
import { navigate } from "../app.js";
import { fetchOverlaps, overlapCount } from "../overlaps.js";
import {
  PRIORITIES, TYPES, avatar, busy, clear, confirmDialog, emptyState, field, fmtBytes, fmtDate, fromDateInput, h,
  label, markdownEditor, modal, priorityBadge, renderMarkdown, select, spinner, timeAgo, toDateInput, toast,
  userPicker,
} from "../ui.js";

const STATUS = ["draft", "ready", "converted", "dropped"];
const STATUS_LABEL = { draft: "Draft", ready: "Ready", converted: "Converted", dropped: "Dropped" };
const isAdmin = () => auth.user.role === "admin";
const AC_TEMPLATE = "- [ ] \n- [ ] \n- [ ] ";

export const upcomingBadge = (s) => h(`span.badge.up-${s}`, STATUS_LABEL[s] || s);

function criteriaMeter(t) {
  if (!t.criteria_total) return null;
  const pct = Math.round((t.criteria_done / t.criteria_total) * 100);
  return h("span.ac-meter", { title: `${t.criteria_done} of ${t.criteria_total} acceptance criteria checked` },
    h("span.ac-bar", h("i", { style: { width: `${pct}%` } })), `${t.criteria_done}/${t.criteria_total}`);
}

function card(t, { showProject = false } = {}) {
  return h("a.card.up-card", { href: `#/upcoming/${t.id}` },
    h("div.row.between",
      h("div.row", upcomingBadge(t.status), priorityBadge(t.priority)),
      t.target_date ? h("span.small.muted", { title: "Target date" }, icon("target", { size: 12 }), ` ${fmtDate(t.target_date)}`) : h("span.small.muted", "No target date")),
    h("strong.up-title", t.title),
    showProject ? h("span.muted.small", t.project.name) : null,
    h("div.row.wrap.up-meta",
      criteriaMeter(t),
      t.reference_links.length ? h("span.small.muted.ic-count", icon("link", { size: 12 }), ` ${t.reference_links.length}`) : null,
      t.documents.length ? h("span.small.muted.ic-count", icon("file", { size: 12 }), ` ${t.documents.length}`) : null,
      t.ticket ? h("span.small", "→ ", h("span.key", t.ticket.key)) : null));
}

// ----------------------------------------------------------------------------- lists
/** Grid of upcoming tasks with status filter chips. `projectId` limits to one project. */
async function listView(container, { projectId, projects }) {
  const statuses = new Set(["draft", "ready"]);
  const grid = h("div");
  const chips = h("div.chips", STATUS.map((s) => h("button.chip", {
    type: "button", "aria-pressed": String(statuses.has(s)),
    onclick: (e) => {
      if (statuses.has(s)) statuses.delete(s); else statuses.add(s);
      e.currentTarget.setAttribute("aria-pressed", String(statuses.has(s)));
      load();
    },
  }, STATUS_LABEL[s])));

  async function load() {
    clear(grid, spinner());
    const items = await api.get(projectId ? `/projects/${projectId}/upcoming` : "/upcoming", {});
    const shown = items.filter((t) => !statuses.size || statuses.has(t.status));
    if (!shown.length) {
      clear(grid, emptyState("No upcoming tasks", isAdmin()
        ? "Add one to start collecting requirements, references and acceptance criteria."
        : "Nothing planned here yet. Upcoming tasks are added by an admin."));
      return;
    }
    if (projectId) { clear(grid, h("div.up-grid", shown.map((t) => card(t)))); return; }
    const groups = new Map();
    shown.forEach((t) => { if (!groups.has(t.project.id)) groups.set(t.project.id, []); groups.get(t.project.id).push(t); });
    clear(grid, [...groups.values()].map((items2) => h("section.up-group",
      h("h2", h("span.key-pill", items2[0].project.key), items2[0].project.name, h("span.muted.small", ` · ${items2.length}`)),
      h("div.up-grid", items2.map((t) => card(t))))));
  }

  clear(container,
    h("div.row.between.wrap.up-toolbar",
      chips,
      isAdmin() && h("button.btn.primary", { onclick: () => editDialog(null, { projects, projectId }) }, "New upcoming task")),
    grid);
  await load();
}

export async function renderUpcomingPage(main) {
  const projects = await api.get("/projects");
  const body = h("div");
  clear(main,
    h("div.page-head", h("div", h("h1", "Upcoming"),
      h("p.muted", "Planned work per project: requirements, references, documents and acceptance criteria - before it becomes a ticket."))),
    body);
  await listView(body, { projects });
}

/** Used by the project page's "Upcoming" tab. */
export async function renderProjectUpcoming(container, project) {
  await listView(container, { projectId: project.id, projects: [project] });
}

// ----------------------------------------------------------------------------- create / edit (admin)
function referencesEditor(initial) {
  const rows = h("div.ref-rows");
  const addRow = (ref = { title: "", url: "" }) => {
    const row = h("div.ref-row",
      h("input", { placeholder: "Title (optional)", value: ref.title, maxLength: 200, "aria-label": "Reference title", dataset: { k: "title" } }),
      h("input", { type: "url", placeholder: "https://…", value: ref.url, maxLength: 2000, "aria-label": "Reference URL", dataset: { k: "url" } }),
      h("button.icon-btn", { type: "button", "aria-label": "Remove reference", onclick: () => row.remove() }, icon("x", { size: 14 })));
    rows.append(row);
  };
  (initial.length ? initial : []).forEach(addRow);
  return {
    el: h("div.refs", rows, h("button.btn.sm.ghost", { type: "button", onclick: () => addRow() }, "+ Add link")),
    value() {
      return [...rows.querySelectorAll(".ref-row")].map((r) => ({
        title: r.querySelector("[data-k=title]").value.trim(),
        url: r.querySelector("[data-k=url]").value.trim(),
      })).filter((r) => r.url);
    },
  };
}

function editDialog(task, { projects = [], projectId } = {}) {
  const editing = Boolean(task);
  const projectSel = !editing && select("project", projects.map((p) => [String(p.id), `${p.key} · ${p.name}`]), projectId || projects[0]?.id);
  const title = h("input", { name: "title", required: true, maxLength: 255, value: task?.title || "", placeholder: "What is planned?" });
  const statusSel = select("status", (editing && task.status === "converted" ? STATUS : STATUS.filter((s) => s !== "converted")).map((s) => [s, STATUS_LABEL[s]]), task?.status || "draft",
    { disabled: editing && task.status === "converted" });
  const prioritySel = select("priority", PRIORITIES, task?.priority || "medium");
  const target = h("input", { type: "date", value: toDateInput(task?.target_date) });
  const req = markdownEditor({ value: task?.requirements || "", rows: 10, label: "Requirements",
    placeholder: "Background, user stories, scope, constraints… Markdown supported." });
  const ac = markdownEditor({ value: task?.acceptance_criteria ?? AC_TEMPLATE, rows: 6, label: "Acceptance criteria",
    placeholder: "- [ ] Given … when … then …" });
  const refs = referencesEditor(task?.reference_links || []);

  const form = h("form.form",
    !editing && projects.length > 1 && field("Project", projectSel),
    field("Title", title),
    h("div.grid-3.tight", field("Status", statusSel), field("Priority", prioritySel), field("Target date", target)),
    h("div.field", h("span.field-label", "Requirements"), req.el),
    h("div.field", h("span.field-label", "Acceptance criteria"), ac.el, h("span.hint", "Use a checklist (- [ ] …); tick items with - [x] as they are agreed or met.")),
    h("div.field", h("span.field-label", "References"), refs.el),
    !editing && h("p.hint", "You can upload documents after saving."),
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, editing ? "Save" : "Create")));

  const m = modal(editing ? "Edit upcoming task" : "New upcoming task", form, { wide: true });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = {
      title: title.value.trim(), priority: prioritySel.value, target_date: fromDateInput(target.value),
      requirements: req.value, acceptance_criteria: ac.value.trim() === AC_TEMPLATE.trim() ? "" : ac.value,
      reference_links: refs.value(),
    };
    if (!(editing && task.status === "converted")) body.status = statusSel.value;
    busy(form.querySelector("[type=submit]"), async () => {
      const saved = editing
        ? await api.patch(`/upcoming/${task.id}`, body)
        : await api.post(`/projects/${projectSel ? projectSel.value : projectId}/upcoming`, body);
      m.close();
      toast(editing ? "Saved" : "Upcoming task created");
      navigate(`/upcoming/${saved.id}`);
    });
  });
}

// ----------------------------------------------------------------------------- detail
export async function renderUpcomingDetail(main, id) {
  let t = await api.get(`/upcoming/${id}`);

  function draw() {
    const docsInput = h("input", { type: "file", multiple: true, hidden: true, onchange: () => upload(docsInput.files) });
    clear(main,
      h("div.crumbs",
        h("a", { href: "#/upcoming" }, "Upcoming"), " / ",
        h("a", { href: `#/projects/${t.project.id}/upcoming` }, t.project.name)),
      h("div.ticket-head",
        h("div.ticket-head-main",
          h("h1.ticket-title", t.title),
          h("div.row.wrap", upcomingBadge(t.status), priorityBadge(t.priority),
            t.target_date && h("span.badge", icon("target", { size: 12 }), ` Target ${fmtDate(t.target_date)}`),
            criteriaMeter(t))),
        h("div.ticket-head-actions",
          t.can_convert && h("button.btn.primary", { onclick: convertDialog }, "Convert to ticket"),
          t.can_edit && h("button.btn", { onclick: () => editDialog(t) }, "Edit"),
          t.can_edit && h("button.btn.ghost.danger.sm", { onclick: del }, "Delete"))),
      t.ticket && h("div.banner.verified", h("span.banner-icon", icon("tickets", { size: 18 })),
        h("div", "Converted to ticket ", h("a", { href: `#/tickets/${t.ticket.key}` }, h("strong", t.ticket.key)),
          h("span.muted", ` · ${label(t.ticket.status)}`))),
      h("div.ticket-layout",
        h("div.ticket-main",
          h("section.card", h("div.card-head", h("h2", "Requirements")),
            t.requirements.trim() ? renderMarkdown(t.requirements, t.can_edit ? { onTaskToggle: (text) => saveField("requirements", text) } : {}) : h("p.muted", "No requirements written yet.")),
          h("section.card", h("div.card-head", h("h2", "Acceptance criteria"), criteriaMeter(t)),
            t.acceptance_criteria.trim() ? renderMarkdown(t.acceptance_criteria, t.can_edit ? { onTaskToggle: (text) => saveField("acceptance_criteria", text) } : {}) : h("p.muted", "No acceptance criteria yet."))),
        h("aside.ticket-side",
          h("section.card",
            h("div.card-head", h("h2", "References")),
            t.reference_links.length
              ? h("ul.ref-list", t.reference_links.map((r) => h("li",
                h("a", { href: r.url, target: "_blank", rel: "noopener noreferrer" }, r.title || r.url),
                r.title && h("span.muted.small", new URL(r.url).hostname))))
              : h("p.muted.small", "No links yet.")),
          h("section.card",
            h("div.card-head", h("h2", "Documents"),
              t.can_edit && h("button.btn.sm", { onclick: () => docsInput.click() }, "Upload")),
            docsInput,
            t.documents.length
              ? h("div.files.inline", t.documents.map((d) => h("div.file",
                h("button.link", { title: "Download", onclick: () => download(d) }, icon("file", { size: 14 }), ` ${d.filename}`),
                h("span.muted.small", `${fmtBytes(d.size)} · ${timeAgo(d.created_at)}`),
                t.can_edit && h("button.icon-btn.small", { "aria-label": `Delete ${d.filename}`, onclick: () => deleteDoc(d) }, icon("x", { size: 14 })))))
              : h("p.muted.small", t.can_edit ? "Upload specs, designs or any supporting files." : "No documents yet.")),
          h("section.card.props.dates",
            h("div.prop", h("span.prop-label", "Project"), h("a", { href: `#/projects/${t.project.id}` }, t.project.name)),
            h("div.prop", h("span.prop-label", "Added by"), t.creator ? h("span.user-chip", avatar(t.creator, "sm"), t.creator.name) : "—"),
            h("div.prop", h("span.prop-label", "Created"), timeAgo(t.created_at)),
            h("div.prop", h("span.prop-label", "Updated"), timeAgo(t.updated_at))))));
  }

  const reload = async () => { t = await api.get(`/upcoming/${id}`); draw(); };
  // Ticking a checklist item saves straight away; the acceptance-criteria meter follows on the next load.
  const saveField = async (key, text) => { t = await api.patch(`/upcoming/${id}`, { [key]: text }); };

  async function upload(files) {
    if (!files.length) return;
    const fd = new FormData();
    [...files].forEach((f) => fd.append("files", f));
    await busy(null, async () => { await api.upload(`/upcoming/${id}/documents`, fd); toast("Uploaded"); await reload(); });
  }
  async function download(d) {
    try {
      const res = await request("GET", `/upcoming-documents/${d.id}/download`, { raw: true });
      const url = URL.createObjectURL(await res.blob());
      const a = h("a", { href: url, download: d.filename });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) { toast(err.message, "error"); }
  }
  async function deleteDoc(d) {
    if (!(await confirmDialog("Delete document", `Delete ${d.filename}?`))) return;
    await busy(null, async () => { await api.del(`/upcoming-documents/${d.id}`); await reload(); });
  }
  async function del() {
    if (!(await confirmDialog("Delete upcoming task", `Delete "${t.title}" and its documents? A ticket created from it is kept.`))) return;
    await busy(null, async () => { await api.del(`/upcoming/${id}`); toast("Deleted"); navigate(`/projects/${t.project.id}/upcoming`); });
  }

  function convertDialog() {
    let assignee = null;
    const typeSel = select("type", TYPES, "feature");
    const overlapSlot = h("div");
    const due = h("input", { type: "date", value: toDateInput(t.target_date), onchange: () => check() });
    const check = async () => {
      const ov = await fetchOverlaps(assignee, { end: fromDateInput(due.value) });
      overlapSlot.replaceChildren(...[overlapCount(ov)].filter(Boolean));
    };
    const est = h("input", { type: "number", min: 0, max: 10000, step: 0.5, placeholder: "hours" });
    const copyDocs = h("input", { type: "checkbox", checked: true });
    const form = h("form.form",
      h("p.muted", "Creates a ticket in ", h("strong", t.project.name), " with the requirements, acceptance criteria and references in its description."),
      h("div.grid-2.tight", field("Type", typeSel), field("Due date", due)),
      h("div.grid-2.tight",
        field("Assignee", userPicker((q) => api.get("/users/lookup", { q, project_id: t.project.id, limit: 10 }), (u) => { assignee = u; check(); }, { allowNone: true, placeholder: "Unassigned" })),
        field("Estimate (hours)", est)),
      overlapSlot,
      t.documents.length > 0 && h("label.check", copyDocs, `Attach the ${t.documents.length} document${t.documents.length > 1 ? "s" : ""} to the ticket`),
      h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Create ticket")));
    const m = modal("Convert to ticket", form, { wide: true });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(form.querySelector("[type=submit]"), async () => {
        const ticket = await api.post(`/upcoming/${id}/convert`, {
          type: typeSel.value, assignee_id: assignee ? assignee.id : null, due_date: fromDateInput(due.value),
          estimated_hours: est.value === "" ? null : Number(est.value), copy_documents: copyDocs.checked,
        });
        m.close();
        toast(`${ticket.key} created`);
        navigate(`/tickets/${ticket.key}`);
      });
    });
  }

  draw();
}
