// Releases: finished tickets grouped per project and shipped to production together.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { currentQuery, navigate, setQuery } from "../app.js";
import {
  avatar, busy, clear, confirmDialog, emptyState, field, fmtDate, fmtDateTime, fromDateInput, h, label,
  markdownEditor, modal, priorityBadge, renderMarkdown, select, spinner, statusBadge, toDateInput, toast,
  typeBadge, assigneesChip,
} from "../ui.js";

const TYPE_ORDER = ["feature", "improvement", "bug", "task"];
const TYPE_HEADING = { feature: "New features", improvement: "Improvements", bug: "Bug fixes", task: "Other changes" };

export const releaseBadge = (r) => (r.status === "released"
  ? h("span.badge.rel-released", icon("rocket", { size: 12 }), "Released")
  : h("span.badge.rel-planned", "Planned"));

function typeSummary(byType) {
  return TYPE_ORDER.filter((k) => byType[k]).map((k) => `${byType[k]} ${label(k).toLowerCase()}${byType[k] > 1 ? "s" : ""}`).join(" · ");
}

function releaseCard(r, q) {
  return h("a.card.rel-card", { href: `#/releases/${r.id}${q ? `?q=${encodeURIComponent(q)}` : ""}` },
    h("div.row.between", h("strong.rel-name", r.name), releaseBadge(r)),
    h("span.muted.small", r.status === "released"
      ? `Released ${fmtDate(r.released_at)}${r.releaser ? ` by ${r.releaser.name}` : ""}`
      : r.planned_date ? `Planned for ${fmtDate(r.planned_date)}` : "No date set"),
    h("div.row.wrap.rel-meta",
      h("span.small", h("strong", String(r.ticket_count)), ` ticket${r.ticket_count === 1 ? "" : "s"}`),
      r.ticket_count ? h("span.muted.small", typeSummary(r.by_type)) : null,
      r.unverified_count ? h("span.small.warn-text", `${r.unverified_count} awaiting verification`) : null),
    r.matched_tickets?.length ? h("div.rel-match", icon("search", { size: 12 }), "Contains ",
      r.matched_tickets.map((k) => h("span.key", k))) : null);
}

// ----------------------------------------------------------------------------- lists
async function listView(container, { project, projects }) {
  const body = h("div");
  const q0 = currentQuery();
  const state = { q: q0.get("q") || "", status: q0.get("status") || "", project: project ? "" : q0.get("project") || "" };
  let seq = 0;
  async function load() {
    const mine = ++seq;
    clear(body, spinner());
    setQuery(state);
    const items = await api.get("/releases", {
      project_id: project?.id || state.project || undefined, status: state.status || undefined, q: state.q.trim() || undefined,
    });
    if (mine !== seq) return; // a newer search is on its way
    const filtered = state.q || state.status || state.project;
    if (!items.length) {
      clear(body, filtered
        ? emptyState("No matching releases", state.q ? `Nothing named “${state.q}” and no ticket matching it in a release.` : "Try another filter.", null, "search")
        : emptyState("No releases yet", "Create a release, move finished tickets into it, and mark it released when it goes to production."));
      return;
    }
    const card = (r) => releaseCard(r, r.matched_tickets?.length ? state.q.trim() : "");
    const section = (title, list) => list.length && h("section.rel-section", h("h2", title), h("div.rel-grid", list.map(card)));
    if (project) {
      clear(body, section("Planned", items.filter((r) => r.status === "planned")), section("Released", items.filter((r) => r.status === "released")));
      return;
    }
    const groups = new Map();
    items.forEach((r) => { if (!groups.has(r.project.id)) groups.set(r.project.id, []); groups.get(r.project.id).push(r); });
    clear(body, [...groups.values()].map((list) => h("section.rel-section",
      h("h2", h("span.key-pill", list[0].project.key), list[0].project.name),
      h("div.rel-grid", list.map(card)))));
  }
  let timer;
  const search = h("input.rel-search", {
    type: "search", value: state.q, placeholder: "Search releases or a ticket (PAY-12, login bug…)", "aria-label": "Search releases",
    oninput: () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value; load(); }, 250); },
  });
  const statusChips = h("div.chips.seg", [["", "All"], ["planned", "Planned"], ["released", "Released"]].map(([v, text]) => h("button.chip", {
    type: "button", "aria-pressed": String(state.status === v),
    onclick: (e) => {
      state.status = v;
      statusChips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget)));
      load();
    },
  }, text)));
  const projectSel = !project && (projects || []).length > 1 && h("select", {
    "aria-label": "Project", onchange: (e) => { state.project = e.target.value; load(); },
  }, h("option", { value: "" }, "All projects"), projects.map((p) => h("option", { value: p.id, selected: String(p.id) === state.project }, `${p.key} · ${p.name}`)));
  const filters = h("div.row.wrap.rel-filters", h("label.search-box", icon("search", { size: 15 }), search), statusChips, projectSel);
  const ownable = (projects || []).filter((p) => p.my_role === "owner" || p.my_role === "admin");
  clear(container,
    filters,
    ownable.length > 0 && h("div.row.between.wrap.up-toolbar",
      h("span.muted.small", "Tickets moved into a release leave the board. Released versions are locked."),
      h("button.btn.primary", { onclick: () => releaseDialog(null, { projects: ownable, projectId: project?.id }) }, "New release")),
    body);
  await load();
}

export async function renderReleasesPage(main) {
  const projects = await api.get("/projects");
  const body = h("div");
  clear(main,
    h("div.page-head", h("div", h("h1", "Releases"), h("p.muted", "What shipped to production, and what is lined up next."))),
    body);
  await listView(body, { projects });
}

export async function renderProjectReleases(container, project) {
  await listView(container, { project, projects: [project] });
}

// ----------------------------------------------------------------------------- create / edit
function releaseDialog(release, { projects = [], projectId } = {}) {
  const editing = Boolean(release);
  const projectSel = !editing && select("project", projects.map((p) => [String(p.id), `${p.key} · ${p.name}`]), projectId || projects[0]?.id);
  const name = h("input", { required: true, maxLength: 100, value: release?.name || "", placeholder: "v1.4.0", disabled: release?.status === "released" });
  const date = h("input", { type: "date", value: toDateInput(release?.planned_date) });
  const notes = markdownEditor({ value: release?.notes || "", rows: 6, label: "Release notes",
    placeholder: "Highlights, migration steps, known issues… (the ticket list is added automatically)" });
  const form = h("form.form",
    !editing && projects.length > 1 && field("Project", projectSel),
    h("div.grid-2.tight", field("Version / name", name), release?.status !== "released" ? field("Planned date", date) : null),
    h("div.field", h("span.field-label", "Release notes"), notes.el),
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, editing ? "Save" : "Create release")));
  const m = modal(editing ? `Edit ${release.name}` : "New release", form, { wide: true });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = { notes: notes.value };
    if (release?.status !== "released") { body.name = name.value.trim(); body.planned_date = fromDateInput(date.value); }
    busy(form.querySelector("[type=submit]"), async () => {
      const saved = editing
        ? await api.patch(`/releases/${release.id}`, body)
        : await api.post(`/projects/${projectSel ? projectSel.value : projectId}/releases`, body);
      m.close();
      toast(editing ? "Saved" : `Release ${saved.name} created`);
      navigate(`/releases/${saved.id}`);
    });
  });
}

/**
 * Pick finished tickets (done / verified, not in a release yet) and move them into a release.
 * `preselect` ticks those ids; `releaseId` skips the release picker.
 */
export async function addToReleaseDialog(projectId, { releaseId = null, preselect = null, onDone } = {}) {
  const [page, releases] = await Promise.all([
    api.get(`/projects/${projectId}/tickets`, { status: ["done", "verified"], in_release: false, sort: "updated_at", limit: 200 }),
    releaseId ? null : api.get(`/projects/${projectId}/releases`),
  ]);
  const planned = releases ? releases.filter((r) => r.status === "planned") : [];
  if (!page.items.length) { toast("No finished tickets to add - only Done or Verified tickets can be released.", "error"); return; }

  const checks = page.items.map((t) => h("input", { type: "checkbox", value: t.id, checked: !preselect || preselect.includes(t.id) }));
  const newName = h("input", { placeholder: "v1.4.0", maxLength: 100 });
  const relSel = !releaseId && select("release", [...planned.map((r) => [String(r.id), r.name]), ["__new", "+ New release…"]], planned[0]?.id || "__new", {
    onchange: () => { newWrap.hidden = relSel.value !== "__new"; },
  });
  const newWrap = h("div", { hidden: Boolean(planned.length) }, field("New release name", newName));
  const all = h("input", { type: "checkbox", checked: checks.every((c) => c.checked), onchange: () => checks.forEach((c) => { c.checked = all.checked; }) });

  const form = h("form.form",
    !releaseId && h("div.grid-2.tight", field("Release", relSel), newWrap),
    h("div.pick-list",
      h("label.check.pick-all", all, h("strong", `All finished tickets (${page.items.length})`)),
      page.items.map((t, i) => h("label.check.pick-row", checks[i],
        h("span.key", t.key), typeBadge(t.type), h("span.grow.ellipsis", t.title), statusBadge(t.status)))),
    h("p.hint", "Tickets still in Done are verified automatically when the release goes to production."),
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Move to release")));
  const m = modal("Move tickets to a release", form, { wide: true });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const ids = checks.filter((c) => c.checked).map((c) => Number(c.value));
    if (!ids.length) { toast("Pick at least one ticket", "error"); return; }
    busy(form.querySelector("[type=submit]"), async () => {
      let target = releaseId;
      if (!target) {
        if (relSel.value === "__new") {
          if (!newName.value.trim()) { toast("Give the new release a name", "error"); return; }
          target = (await api.post(`/projects/${projectId}/releases`, { name: newName.value.trim() })).id;
        } else target = Number(relSel.value);
      }
      const rel = await api.post(`/releases/${target}/tickets`, { ticket_ids: ids });
      m.close();
      toast(`${ids.length} ticket${ids.length > 1 ? "s" : ""} moved to ${rel.name}`);
      if (onDone) onDone(rel); else navigate(`/releases/${rel.id}`);
    });
  });
}

// ----------------------------------------------------------------------------- detail
export async function renderReleaseDetail(main, id) {
  let r = await api.get(`/releases/${id}`);
  const reload = async () => { r = await api.get(`/releases/${id}`); draw(); };

  function ticketRows(list) {
    return h("div.table-wrap", h("table.table.tickets",
      h("tbody", list.map((t) => h("tr", { onclick: (e) => { if (!e.target.closest("a,button")) location.hash = `/tickets/${t.key}`; } },
        h("td.key", h("a", { href: `#/tickets/${t.key}` }, t.key)),
        h("td", h("div.title-cell", h("span", t.title))),
        h("td.hide-sm", priorityBadge(t.priority)),
        h("td", statusBadge(t.status)),
        h("td.hide-sm", t.assignees.length ? assigneesChip(t.assignees) : h("span.muted", "—")),
        r.can_manage && h("td.right", h("button.btn.sm.ghost", { onclick: () => removeTicket(t) }, "Remove")))))));
  }

  const f = { q: currentQuery().get("q") || "", type: "", status: "", person: "" };
  const matches = (t) => {
    const q = f.q.trim().toLowerCase();
    return (!q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
      && (!f.type || t.type === f.type) && (!f.status || t.status === f.status)
      && (!f.person || (f.person === "none" ? !t.assignees.length : t.assignees.some((u) => String(u.id) === f.person)));
  };
  const ticketsBox = h("div");

  function ticketFilters() {
    if (r.tickets.length < 2) return null;
    const people = new Map();
    r.tickets.forEach((t) => t.assignees.forEach((u) => people.set(u.id, u)));
    const types = TYPE_ORDER.filter((k) => r.by_type[k]);
    const search = h("input", {
      type: "search", value: f.q, placeholder: "Filter by key or title", "aria-label": "Filter tickets",
      oninput: () => { f.q = search.value; paintTickets(); },
    });
    const sel = (key, options, aria) => h("select", { "aria-label": aria, onchange: (e) => { f[key] = e.target.value; paintTickets(); } },
      options.map(([v, text]) => h("option", { value: v, selected: f[key] === v }, text)));
    return h("div.row.wrap.rel-ticket-filters",
      h("label.search-box", icon("search", { size: 15 }), search),
      types.length > 1 && sel("type", [["", "All types"], ...types.map((k) => [k, TYPE_HEADING[k]])], "Type"),
      sel("status", [["", "Done & verified"], ["done", "Done (awaiting verification)"], ["verified", "Verified"]], "Status"),
      people.size > 0 && sel("person", [["", "Anyone"], ...[...people.values()].sort((a, b) => a.name.localeCompare(b.name)).map((u) => [String(u.id), u.name]), ["none", "Unassigned"]], "Assignee"));
  }

  function paintTickets() {
    const shown = r.tickets.filter(matches);
    const grouped = TYPE_ORDER.map((k) => [k, shown.filter((t) => t.type === k)]).filter(([, l]) => l.length);
    const count = document.querySelector(".rel-shown");
    if (count) count.textContent = shown.length === r.tickets.length ? "" : `Showing ${shown.length} of ${r.tickets.length}`;
    clear(ticketsBox, r.tickets.length
      ? shown.length
        ? grouped.map(([k, list]) => h("div.rel-type", h("h3", TYPE_HEADING[k]), ticketRows(list)))
        : h("div.pad", emptyState("No tickets match", "Clear the filters to see everything in this release.", null, "search"))
      : h("div.pad", emptyState("No tickets in this release", r.can_manage ? "Use Add tickets to move Done or Verified tickets here." : null)));
  }

  function draw() {
    clear(main,
      h("div.crumbs", h("a", { href: "#/releases" }, "Releases"), " / ", h("a", { href: `#/projects/${r.project.id}/releases` }, r.project.name)),
      h("div.ticket-head",
        h("div.ticket-head-main",
          h("h1.ticket-title", r.name),
          h("div.row.wrap", releaseBadge(r),
            h("span.muted.small", r.status === "released"
              ? `Released ${fmtDateTime(r.released_at)}${r.releaser ? ` by ${r.releaser.name}` : ""}`
              : r.planned_date ? `Planned for ${fmtDate(r.planned_date)}` : "No planned date"))),
        h("div.ticket-head-actions",
          r.can_manage && h("button.btn", { onclick: () => addToReleaseDialog(r.project.id, { releaseId: r.id, onDone: reload }) }, "Add tickets"),
          r.can_manage && h("button.btn.success", { onclick: publish, disabled: !r.ticket_count }, icon("rocket", { size: 15 }), "Release to production"),
          r.can_edit && h("button.btn", { onclick: () => releaseDialog(r) }, r.status === "released" ? "Edit notes" : "Edit"),
          r.can_manage && h("button.btn.ghost.danger.sm", { onclick: del }, "Delete"))),
      r.status === "planned" && r.unverified_count > 0 && h("div.banner.pending", h("span.banner-icon", "⏳"),
        h("div", h("strong", `${r.unverified_count} ticket${r.unverified_count > 1 ? "s are" : " is"} still waiting for verification`),
          h("div.muted", "Releasing to production verifies them automatically. Verify or remove them first if they still need a check."))),
      h("section.card", h("div.card-head", h("h2", "Release notes")),
        r.notes.trim() ? renderMarkdown(r.notes) : h("p.muted", r.can_manage ? "No notes yet - use Edit to add highlights or deployment steps." : "No notes.")),
      h("section.card.flush",
        h("div.card-head", h("h2", `Tickets (${r.ticket_count})`),
          h("div.row.wrap", h("span.muted.small.rel-shown"), r.ticket_count ? h("span.muted.small", typeSummary(r.by_type)) : null)),
        ticketFilters(),
        ticketsBox));
    paintTickets();
  }

  async function removeTicket(t) {
    await busy(null, async () => { await api.del(`/releases/${r.id}/tickets/${t.id}`); toast(`${t.key} is back on the board`); await reload(); });
  }
  async function publish() {
    const extra = r.unverified_count ? ` ${r.unverified_count} ticket(s) still in Done will be marked Verified.` : "";
    if (!(await confirmDialog(`Release ${r.name}`, `Mark ${r.name} as released to production with ${r.ticket_count} ticket(s)?${extra} The project's members will be notified and the release is locked afterwards.`, "Release"))) return;
    await busy(null, async () => { await api.post(`/releases/${r.id}/release`); toast(`${r.name} released to production`); await reload(); });
  }
  async function del() {
    if (!(await confirmDialog("Delete release", `Delete ${r.name}? Its ${r.ticket_count} ticket(s) go back to the board.`))) return;
    await busy(null, async () => { await api.del(`/releases/${r.id}`); toast("Release deleted"); navigate(`/projects/${r.project.id}/releases`); });
  }

  draw();
}
