// Ticket tables.
// ticketTable(): the compact read-only table used on the dashboard.
// filteredTicketList(): the full ticket list (Tickets page, project List tab) - filters bound to the URL,
// sortable columns, column picker, density, page size, group by, row selection with bulk actions,
// inline status change, saved views and CSV export.
import { api, auth } from "../api.js";
import { icon } from "../icons.js";
import { currentQuery, setQuery } from "../app.js";
import {
  PRIORITIES, STATUSES, TYPES, avatar, busy, clear, confirmDialog, emptyState, errorBox, fmtDate, fmtDateTime, h,
  label, modal, priorityBadge, select, spinner, statusBadge, timeAgo, toast, typeBadge, userChip, userPicker,
} from "../ui.js";

export function ticketTable(tickets, { showProject = true } = {}) {
  if (!tickets.length) return emptyState("No tickets", "Nothing matches these filters.");
  return h("div.table-wrap",
    h("table.table.tickets",
      h("thead", h("tr",
        h("th", "Key"), h("th", "Title"), showProject && h("th.hide-sm", "Project"),
        h("th", "Status"), h("th.hide-sm", "Priority"), h("th.hide-sm", "Assignee"), h("th", "Due"), h("th.hide-md", "Updated"))),
      h("tbody", tickets.map((t) => h("tr", { onclick: (e) => { if (!e.target.closest("a")) location.hash = `/tickets/${t.key}`; } },
        h("td.key", h("a", { href: `#/tickets/${t.key}` }, t.key)),
        h("td", h("div.title-cell", typeBadge(t.type), h("span", t.title))),
        showProject && h("td.hide-sm.muted", t.project.name),
        h("td", h("div.row", statusBadge(t.status),
          t.release && h("a.badge.rel-chip", { href: `#/releases/${t.release.id}`, title: `In release ${t.release.name}` }, [icon("rocket", { size: 12 }), ` ${t.release.name}`]))),
        h("td.hide-sm", priorityBadge(t.priority)),
        h("td.hide-sm", userChip(t.assignee)),
        h(`td.nowrap${t.is_overdue ? ".overdue" : ""}`, t.due_date ? fmtDate(t.due_date) : h("span.muted", "—")),
        h("td.hide-md.muted", timeAgo(t.updated_at)),
      ))),
    ));
}

// ----------------------------------------------------------------------------- advanced list
const shortDate = (v) => (v ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null);

/** Column catalogue. `sort` is the API sort key; `cell(t, ctx)` renders; `csv(t)` exports. */
const COLUMNS = [
  { id: "key", name: "Key", sort: "key", always: true, cell: (t) => h("a.key", { href: `#/tickets/${t.key}` }, t.key), csv: (t) => t.key },
  {
    id: "title", name: "Title", sort: "title", always: true, cls: "col-title",
    cell: (t) => h("div.title-cell", typeBadge(t.type), h("span.ellipsis", { title: t.title }, t.title),
      t.reopen_count > 0 && h("span.tc-flag", { title: `Reopened ${t.reopen_count}×` }, `↺${t.reopen_count}`)),
    csv: (t) => t.title,
  },
  { id: "project", name: "Project", cell: (t) => h("span.muted", t.project.name), csv: (t) => t.project.name },
  { id: "type", name: "Type", cell: (t) => typeBadge(t.type), csv: (t) => t.type },
  { id: "status", name: "Status", sort: "status", cell: (t, ctx) => ctx.statusCell(t), csv: (t) => t.status },
  { id: "priority", name: "Priority", sort: "priority", cell: (t) => priorityBadge(t.priority), csv: (t) => t.priority },
  { id: "assignee", name: "Assignee", sort: "assignee", cell: (t) => userChip(t.assignee), csv: (t) => t.assignee?.name || "" },
  { id: "reporter", name: "Reporter", cell: (t) => userChip(t.reporter), csv: (t) => t.reporter?.name || "" },
  { id: "start", name: "Start", sort: "start_date", cell: (t) => (t.start_date ? shortDate(t.start_date) : h("span.muted", "—")), csv: (t) => t.start_date || "" },
  {
    id: "due", name: "Due", sort: "due_date",
    cell: (t) => (t.due_date ? h(`span.chip-due${t.is_overdue ? ".overdue" : ""}`, { title: fmtDate(t.due_date) }, shortDate(t.due_date)) : h("span.muted", "—")),
    csv: (t) => t.due_date || "",
  },
  {
    id: "time", name: "Time", cell: (t) => {
      if (!t.estimated_hours && !t.spent_hours) return h("span.muted", "—");
      const pct = t.estimated_hours ? Math.min(100, Math.round(((t.spent_hours || 0) / t.estimated_hours) * 100)) : null;
      return h("span.tc-time", { title: `${t.spent_hours || 0}h logged${t.estimated_hours ? ` of ${t.estimated_hours}h` : ""}` },
        pct !== null && h("span.tc-bar", h("i", { class: pct >= 100 ? "over" : "", style: { width: `${pct}%` } })),
        `${Math.round((t.spent_hours || 0) * 10) / 10}${t.estimated_hours ? `/${t.estimated_hours}` : ""}h`);
    },
    csv: (t) => `${t.spent_hours || 0}/${t.estimated_hours ?? ""}`,
  },
  { id: "release", name: "Release", cell: (t) => (t.release ? h("a.badge.rel-chip", { href: `#/releases/${t.release.id}` }, [icon("rocket", { size: 12 }), ` ${t.release.name}`]) : h("span.muted", "—")), csv: (t) => t.release?.name || "" },
  { id: "created", name: "Created", sort: "created_at", cell: (t) => h("span.muted", { title: fmtDateTime(t.created_at) }, timeAgo(t.created_at)), csv: (t) => t.created_at },
  { id: "updated", name: "Updated", sort: "updated_at", cell: (t) => h("span.muted", { title: fmtDateTime(t.updated_at) }, timeAgo(t.updated_at)), csv: (t) => t.updated_at },
];
const DEFAULT_COLUMNS = ["key", "title", "project", "status", "priority", "assignee", "due", "updated"];
const GROUPS = [["", "No grouping"], ["status", "Status"], ["priority", "Priority"], ["assignee", "Assignee"], ["project", "Project"], ["type", "Type"]];
const GROUP_ORDER = { status: STATUSES, priority: ["critical", "high", "medium", "low"], type: TYPES };

function loadPrefs(key) {
  try { return JSON.parse(localStorage.getItem(`tickets.table.${key}`) || "{}"); } catch { return {}; }
}
function savePrefs(key, prefs) {
  try { localStorage.setItem(`tickets.table.${key}`, JSON.stringify(prefs)); } catch { /* per-viewer nicety */ }
}

function downloadCsv(filename, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([`﻿${rows.map((r) => r.map(esc).join(",")).join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Filterable, paginated ticket list bound to the URL query string.
 * opts: endpoint, assignees [[value, text]], extraParams, showProject, prefsKey (separate layout per page).
 */
export function filteredTicketList(opts) {
  const prefsKey = opts.prefsKey || (opts.showProject === false ? "project" : "all");
  const prefs = { columns: null, density: "comfortable", pageSize: 25, group: "", views: [], ...loadPrefs(prefsKey) };
  const allowed = COLUMNS.filter((c) => opts.showProject !== false || c.id !== "project");
  let columns = (prefs.columns || DEFAULT_COLUMNS).filter((id) => allowed.some((c) => c.id === id));
  const persist = () => savePrefs(prefsKey, { ...prefs, columns });

  const q0 = currentQuery();
  const state = {
    q: q0.get("q") || "",
    status: q0.getAll("status"),
    priority: q0.get("priority") || "",
    type: q0.get("type") || "",
    assignee: q0.get("assignee") || "",
    overdue: q0.get("overdue") === "1",
    released: q0.get("released") === "1",
    sort: q0.get("sort") || "updated_at",
    order: q0.get("order") || (q0.get("sort") === "due_date" ? "asc" : "desc"),
    offset: Number(q0.get("offset")) || 0,
  };
  let page = { items: [], total: 0 };
  const selected = new Set();
  const collapsedGroups = new Set();

  const tableBox = h("div.tl-table-box");
  const pager = h("div.pager");
  const bulkBar = h("div.bulk-bar", { hidden: true, role: "region", "aria-label": "Bulk actions" });
  const summary = h("span.list-summary.muted.small");

  // ------------------------------------------------------------- filters
  const statusChips = h("div.chips", { role: "group", "aria-label": "Status" },
    STATUSES.map((s) => h("button.chip", {
      type: "button", "aria-pressed": String(state.status.includes(s)), dataset: { status: s },
      onclick: (e) => {
        state.status = state.status.includes(s) ? state.status.filter((x) => x !== s) : [...state.status, s];
        e.currentTarget.setAttribute("aria-pressed", String(state.status.includes(s)));
        state.offset = 0; load();
      },
    }, h(`i.status-dot.status-${s}`), label(s))));

  const onChange = (key) => (e) => {
    state[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    state.offset = 0; load();
  };
  let timer;
  const search = h("input.list-search", {
    type: "search", placeholder: "Search title, description or key (PAY-12)…", value: state.q, "aria-label": "Search",
    oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value.trim(); state.offset = 0; load(); }, 250); },
  });
  const prioritySel = select("priority", [["", "Any priority"], ...PRIORITIES.map((p) => [p, label(p)])], state.priority, { onchange: onChange("priority"), "aria-label": "Priority" });
  const typeSel = select("type", [["", "Any type"], ...TYPES.map((t) => [t, label(t)])], state.type, { onchange: onChange("type"), "aria-label": "Type" });
  const assigneeSel = select("assignee", [["", "Any assignee"], ["me", "Assigned to me"], ["none", "Unassigned"],
    ...(opts.assignees?.length ? [["-", "──────────", { disabled: true }]] : []), ...(opts.assignees || [])],
  state.assignee, { onchange: onChange("assignee"), "aria-label": "Assignee" });
  const overdueBox = h("input", { type: "checkbox", checked: state.overdue, onchange: onChange("overdue") });
  const releasedBox = h("input", { type: "checkbox", checked: state.released, onchange: onChange("released") });
  const clearBtn = h("button.btn.sm.ghost", { onclick: () => applyFilters({}) }, "Clear filters");

  function applyFilters(f) {
    Object.assign(state, { q: "", status: [], priority: "", type: "", assignee: "", overdue: false, released: false, offset: 0 }, f);
    search.value = state.q; prioritySel.value = state.priority; typeSel.value = state.type; assigneeSel.value = state.assignee;
    overdueBox.checked = state.overdue; releasedBox.checked = state.released;
    statusChips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(state.status.includes(c.dataset.status))));
    load();
  }
  const filtering = () => Boolean(state.q || state.status.length || state.priority || state.type || state.assignee || state.overdue || state.released);

  // ------------------------------------------------------------- view controls
  const groupSel = select("group", GROUPS, prefs.group, { "aria-label": "Group by", onchange: (e) => { prefs.group = e.target.value; persist(); draw(); } });
  const sizeSel = select("size", [["25", "25 / page"], ["50", "50 / page"], ["100", "100 / page"]], String(prefs.pageSize),
    { "aria-label": "Rows per page", onchange: (e) => { prefs.pageSize = Number(e.target.value); persist(); state.offset = 0; load(); } });
  const densityBtn = h("button.btn.sm", {
    type: "button", title: "Row density",
    onclick: () => { prefs.density = prefs.density === "compact" ? "comfortable" : "compact"; persist(); setDensityLabel(); draw(); },
  });
  const setDensityLabel = () => densityBtn.replaceChildren(icon("rows", { size: 14 }), prefs.density === "compact" ? "Compact" : "Comfortable");
  setDensityLabel();

  const columnsMenu = h("div.menu.col-menu");
  const columnsWrap = h("div.dropdown",
    h("button.btn.sm", { type: "button", "aria-haspopup": "true", onclick: (e) => { e.stopPropagation(); drawColumnsMenu(); columnsWrap.classList.toggle("open"); } }, icon("columns", { size: 14 }), "Columns"),
    columnsMenu);
  function drawColumnsMenu() {
    clear(columnsMenu,
      h("div.menu-head", h("strong", "Columns")),
      allowed.map((c) => h("label.check.col-option",
        h("input", {
          type: "checkbox", checked: columns.includes(c.id), disabled: c.always,
          onchange: (e) => {
            columns = e.target.checked ? allowed.map((x) => x.id).filter((id) => id === c.id || columns.includes(id)) : columns.filter((id) => id !== c.id);
            persist(); draw();
          },
        }), c.name)),
      h("button", { onclick: () => { columns = [...DEFAULT_COLUMNS].filter((id) => allowed.some((c) => c.id === id)); persist(); drawColumnsMenu(); draw(); } }, "Reset to default"));
  }

  const viewsMenu = h("div.menu.col-menu");
  const viewsWrap = h("div.dropdown",
    h("button.btn.sm", { type: "button", "aria-haspopup": "true", onclick: (e) => { e.stopPropagation(); drawViewsMenu(); viewsWrap.classList.toggle("open"); } }, icon("star", { size: 14 }), "Views"),
    viewsMenu);
  function drawViewsMenu() {
    clear(viewsMenu,
      h("div.menu-head", h("strong", "Saved views"), h("span.muted.small", "Filters, columns and grouping")),
      prefs.views.length ? prefs.views.map((v, i) => h("div.view-row",
        h("button.view-apply", {
          onclick: () => {
            viewsWrap.classList.remove("open");
            columns = (v.columns || columns).filter((id) => allowed.some((c) => c.id === id));
            prefs.group = v.group || ""; groupSel.value = prefs.group; persist();
            state.sort = v.filters.sort || "updated_at"; state.order = v.filters.order || "desc";
            applyFilters(v.filters);
          },
        }, v.name),
        h("button.icon-btn.small", { "aria-label": `Delete view ${v.name}`, onclick: (e) => { e.stopPropagation(); prefs.views.splice(i, 1); persist(); drawViewsMenu(); } }, icon("x", { size: 14 }))))
        : h("p.muted.small.pad", "No saved views yet."),
      h("button", {
        onclick: () => {
          viewsWrap.classList.remove("open");
          const name = h("input", { placeholder: "e.g. My overdue bugs", maxLength: 60, required: true });
          const form = h("form.form", name, h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Save view")));
          const m = modal("Save current view", form);
          form.addEventListener("submit", (e) => {
            e.preventDefault();
            const { offset, ...filters } = state;
            prefs.views.push({ name: name.value.trim() || "View", filters: { ...filters, status: [...state.status] }, columns: [...columns], group: prefs.group });
            persist(); m.close(); toast("View saved");
          });
        },
      }, "+ Save current view"));
  }
  document.addEventListener("click", (e) => {
    if (!columnsWrap.contains(e.target)) columnsWrap.classList.remove("open");
    if (!viewsWrap.contains(e.target)) viewsWrap.classList.remove("open");
  });

  const exportBtn = h("button.btn.sm", { type: "button", title: "Download the filtered tickets as CSV", onclick: (e) => busy(e.currentTarget, exportCsv) }, icon("download", { size: 14 }), "CSV");

  // ------------------------------------------------------------- data
  function params(extra = {}) {
    const p = {
      ...opts.extraParams,
      q: state.q || undefined, status: state.status, priority: state.priority || undefined, type: state.type || undefined,
      overdue: state.overdue || undefined, in_release: state.released ? undefined : false,
      sort: state.sort, order: state.order, limit: prefs.pageSize, offset: state.offset, ...extra,
    };
    if (state.assignee === "me") p.assignee_id = auth.user.id;
    else if (state.assignee === "none") p.unassigned = true;
    else if (state.assignee) p.assignee_id = state.assignee;
    return p;
  }

  async function load() {
    setQuery({
      q: state.q, status: state.status, priority: state.priority, type: state.type, assignee: state.assignee,
      overdue: state.overdue ? "1" : "", released: state.released ? "1" : "",
      sort: state.sort !== "updated_at" ? state.sort : "", order: state.order !== "desc" ? state.order : "", offset: state.offset || "",
    });
    clearBtn.hidden = !filtering();
    if (!page.items.length) clear(tableBox, spinner()); else tableBox.classList.add("is-loading");
    try {
      page = await api.get(opts.endpoint, params());
      [...selected].forEach((id) => { if (!page.items.some((t) => t.id === id)) selected.delete(id); });
      draw();
      const size = prefs.pageSize;
      summary.textContent = page.total ? `${page.total} ticket${page.total === 1 ? "" : "s"}` : "";
      clear(pager,
        h("span.muted.small", page.total ? `${state.offset + 1}–${Math.min(state.offset + size, page.total)} of ${page.total}` : ""),
        h("button.btn.sm", { disabled: state.offset === 0, onclick: () => { state.offset = Math.max(0, state.offset - size); load(); } }, "‹ Previous"),
        h("button.btn.sm", { disabled: state.offset + size >= page.total, onclick: () => { state.offset += size; load(); } }, "Next ›"));
    } catch (err) {
      clear(tableBox, errorBox(err));
      clear(pager);
    } finally { tableBox.classList.remove("is-loading"); }
  }

  async function exportCsv() {
    const cols = COLUMNS.filter((c) => columns.includes(c.id));
    const rows = [cols.map((c) => c.name)];
    let offset = 0;
    let total = Infinity;
    while (offset < total && offset < 5000) {
      const chunk = await api.get(opts.endpoint, params({ limit: 200, offset }));
      total = chunk.total;
      chunk.items.forEach((t) => rows.push(cols.map((c) => c.csv(t))));
      offset += 200;
    }
    downloadCsv(`tickets-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    toast(`Exported ${rows.length - 1} ticket${rows.length === 2 ? "" : "s"}`);
  }

  // ------------------------------------------------------------- inline status change
  function statusCell(t) {
    return h("div.row.status-cell",
      h("button.status-trigger", {
        type: "button", title: "Change status",
        onclick: (e) => { e.stopPropagation(); openStatusMenu(t, e.currentTarget); },
      }, statusBadge(t.status), h("span.caret", "▾")),
      t.release && columns.includes("release") === false && h("a.badge.rel-chip", { href: `#/releases/${t.release.id}`, title: `In release ${t.release.name}` }, icon("rocket", { size: 12 })));
  }
  function openStatusMenu(t, anchor) {
    document.querySelectorAll(".status-pop").forEach((p) => p.remove());
    const pop = h("div.status-pop.menu", { role: "menu" },
      STATUSES.map((s) => h("button", {
        disabled: s === t.status,
        onclick: async () => {
          pop.remove();
          try {
            await api.post(`/tickets/${t.id}/status`, { status: s });
            toast(`${t.key} → ${label(s)}`);
            load();
          } catch (err) { toast(err.message, "error"); }
        },
      }, h(`i.status-dot.status-${s}`), label(s))));
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left, innerWidth - 200)}px`;
    pop.style.top = `${r.bottom + 4}px`;
    setTimeout(() => document.addEventListener("click", () => pop.remove(), { once: true }), 0);
  }

  // ------------------------------------------------------------- bulk actions
  async function bulk(verb, fn) {
    const items = page.items.filter((t) => selected.has(t.id));
    const results = await Promise.allSettled(items.map(fn));
    const failed = results.map((r, i) => [r, items[i]]).filter(([r]) => r.status === "rejected");
    const ok = items.length - failed.length;
    if (ok) toast(`${verb} ${ok} ticket${ok === 1 ? "" : "s"}`);
    if (failed.length) toast(`${failed.length} not changed: ${failed.slice(0, 3).map(([r, t]) => `${t.key} (${r.reason.message})`).join("; ")}`, "error");
    selected.clear();
    load();
  }
  function drawBulk() {
    bulkBar.hidden = selected.size === 0;
    if (!selected.size) return;
    let assignee;
    clear(bulkBar,
      h("strong", `${selected.size} selected`),
      select("bulk-status", [["", "Set status…"], ...STATUSES.map((s) => [s, label(s)])], "", {
        "aria-label": "Set status",
        onchange: (e) => { const s = e.target.value; if (s) bulk("Moved", (t) => (t.status === s ? Promise.resolve() : api.post(`/tickets/${t.id}/status`, { status: s }))); },
      }),
      select("bulk-priority", [["", "Set priority…"], ...PRIORITIES.map((p) => [p, label(p)])], "", {
        "aria-label": "Set priority",
        onchange: (e) => { const p = e.target.value; if (p) bulk("Updated", (t) => (t.priority === p ? Promise.resolve() : api.patch(`/tickets/${t.id}`, { priority: p }))); },
      }),
      h("div.bulk-assign", userPicker((q) => api.get("/users/lookup", { q, limit: 10 }), (u) => {
        assignee = u;
        bulk(u ? `Assigned to ${u.name}:` : "Unassigned", (t) => ((t.assignee?.id ?? null) === (assignee?.id ?? null)
          ? Promise.resolve() : api.post(`/tickets/${t.id}/assign`, { assignee_id: assignee ? assignee.id : null })));
      }, { allowNone: true, placeholder: "Assign to…" })),
      h("button.btn.sm.ghost.danger", {
        onclick: async () => {
          if (!(await confirmDialog("Delete tickets", `Delete ${selected.size} ticket(s) permanently? Only project owners can delete.`))) return;
          bulk("Deleted", (t) => api.del(`/tickets/${t.id}`));
        },
      }, "Delete"),
      h("button.btn.sm.ghost", { onclick: () => { selected.clear(); draw(); } }, "Clear selection"));
  }

  // ------------------------------------------------------------- table
  function groupKeyOf(t) {
    switch (prefs.group) {
      case "status": return [t.status, label(t.status)];
      case "priority": return [t.priority, label(t.priority)];
      case "type": return [t.type, label(t.type)];
      case "project": return [String(t.project.id), t.project.name];
      case "assignee": return t.assignee ? [String(t.assignee.id), t.assignee.name] : ["none", "Unassigned"];
      default: return ["", ""];
    }
  }

  function draw() {
    drawBulk();
    const items = page.items;
    if (!items.length) {
      clear(tableBox, h("div.card", emptyState(filtering() ? "No tickets match" : "No tickets yet",
        filtering() ? "Try removing a filter." : "Tickets you can see will appear here.", filtering() ? h("button.btn", { onclick: () => applyFilters({}) }, "Clear filters") : null)));
      return;
    }
    const cols = COLUMNS.filter((c) => columns.includes(c.id) && allowed.includes(c));
    const ctx = { statusCell };
    const allOnPage = items.every((t) => selected.has(t.id));
    const headCheck = h("input", {
      type: "checkbox", "aria-label": "Select all on this page", checked: allOnPage,
      indeterminate: !allOnPage && items.some((t) => selected.has(t.id)),
      onchange: (e) => { items.forEach((t) => (e.target.checked ? selected.add(t.id) : selected.delete(t.id))); draw(); },
    });
    const sortHead = (c) => {
      if (!c.sort) return h("th", c.name);
      const active = state.sort === c.sort;
      return h(`th.sortable${active ? ".sorted" : ""}`, { "aria-sort": active ? (state.order === "asc" ? "ascending" : "descending") : "none" },
        h("button.th-sort", {
          type: "button",
          onclick: () => {
            if (active) state.order = state.order === "asc" ? "desc" : "asc";
            else { state.sort = c.sort; state.order = ["title", "key", "assignee", "due_date", "start_date"].includes(c.sort) ? "asc" : "desc"; }
            state.offset = 0; load();
          },
        }, c.name, h("span.sort-ind", active ? (state.order === "asc" ? "↑" : "↓") : "↕")));
    };

    const row = (t) => h(`tr${selected.has(t.id) ? ".is-selected" : ""}`, {
      onclick: (e) => { if (!e.target.closest("a, button, input, .picker")) location.hash = `/tickets/${t.key}`; },
    },
    h("td.col-check", h("input", {
      type: "checkbox", "aria-label": `Select ${t.key}`, checked: selected.has(t.id),
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => { if (e.target.checked) selected.add(t.id); else selected.delete(t.id); draw(); },
    })),
    cols.map((c) => h(`td.col-${c.id}${c.cls ? `.${c.cls}` : ""}`, c.cell(t, ctx))));

    let body;
    if (prefs.group) {
      const groups = new Map();
      items.forEach((t) => {
        const [k, name] = groupKeyOf(t);
        if (!groups.has(k)) groups.set(k, { name, items: [] });
        groups.get(k).items.push(t);
      });
      const order = GROUP_ORDER[prefs.group];
      const keys = [...groups.keys()].sort((a, b) => (order ? order.indexOf(a) - order.indexOf(b) : groups.get(a).name.localeCompare(groups.get(b).name)));
      body = keys.flatMap((k) => {
        const g = groups.get(k);
        const open = !collapsedGroups.has(k);
        const head = h("tr.group-row", { onclick: () => { if (open) collapsedGroups.add(k); else collapsedGroups.delete(k); draw(); } },
          h("td", { colSpan: cols.length + 1 },
            h("span.g-caret", open ? "▾" : "▸"),
            prefs.group === "status" ? h(`i.status-dot.status-${k}`) : prefs.group === "assignee" ? avatar(g.items[0].assignee, "sm") : null,
            h("strong", g.name), h("span.muted.small", ` ${g.items.length}`)));
        return [head, ...(open ? g.items.map(row) : [])];
      });
    } else body = items.map(row);

    clear(tableBox, h("div.card.flush.adv-table-card",
      h("div.table-wrap.adv-wrap",
        h(`table.table.tickets.adv-table.${prefs.density}`,
          h("thead", h("tr", h("th.col-check", headCheck), cols.map(sortHead))),
          h("tbody", body))),
      prefs.group && page.total > items.length ? h("p.muted.small.pad.group-note", "Grouped within this page - use a bigger page size to group more tickets at once.") : null));
  }

  load();
  return h("div.ticket-list",
    h("div.card.filters-card",
      h("div.filters", search, prioritySel, typeSel, assigneeSel,
        h("label.check", overdueBox, "Overdue"),
        h("label.check", { title: "Include tickets that were moved into a release" }, releasedBox, "Show released"),
        clearBtn),
      statusChips),
    h("div.list-toolbar", summary, h("div.row.wrap.list-tools", h("label.inline", "Group", groupSel), columnsWrap, viewsWrap, densityBtn, sizeSel, exportBtn)),
    bulkBar,
    tableBox,
    pager);
}
