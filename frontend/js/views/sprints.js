// Sprints tab of a project: the active sprint (progress, days left, burndown), planned sprints and the
// backlog. Owners move tickets by selecting or dragging rows between sections.
import { api } from "../api.js";
import { lineChart } from "../charts.js";
import { icon } from "../icons.js";
import {
  CLOSED, avatar, busy, clear, confirmDialog, emptyState, field, fmtDate, fromDateInput, fromStartInput, h,
  modal, priorityBadge, select, spinner, statusBadge, toDateInput, toast, typeBadge, avatarStack,
} from "../ui.js";

const OPEN = ["todo", "in_progress", "blocked", "in_review"];
const shortDate = (v) => (v ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "—");

/** "14 Oct – 27 Oct" */
export const sprintRange = (s) => (s.start_date && s.end_date ? `${shortDate(s.start_date)} – ${shortDate(s.end_date)}` : "No dates yet");

/** Days-left pill: green with time to spare, amber near the end, red when over. */
export function daysLeftPill(s) {
  if (s.status !== "active" || s.days_left === null || s.days_left === undefined) return null;
  const d = s.days_left;
  const tone = d < 0 ? "over" : d <= 2 ? "soon" : "ok";
  const text = d < 0 ? `${-d} day${d === -1 ? "" : "s"} over` : d === 0 ? "Last day" : `${d} day${d === 1 ? "" : "s"} left`;
  return h(`span.sprint-days.${tone}`, icon("clock", { size: 12 }), text);
}

/** Compact chip used on tickets: "Sprint 5 · 3 days left". */
export function sprintChip(s, { href } = {}) {
  if (!s) return null;
  const left = s.status === "active" && s.end_date
    ? Math.floor((new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s.end_date) ? s.end_date : `${s.end_date}Z`) - new Date().setHours(0, 0, 0, 0)) / 86400000)
    : null;
  const tail = s.status === "active" ? (left < 0 ? " · overdue" : left === 0 ? " · last day" : ` · ${left}d left`) : s.status === "completed" ? " · done" : " · planned";
  return h(href ? "a.sprint-chip" : "span.sprint-chip", { href, title: `${s.name} · ${sprintRange(s)}`, class: `st-${s.status}` },
    icon("timeline", { size: 12 }), `${s.name}${tail}`);
}

function sprintDialog(project, sprint, onSaved) {
  const editing = Boolean(sprint);
  const today = new Date();
  const two = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 13);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const name = h("input", { maxLength: 100, value: sprint?.name || "", placeholder: "Leave empty for “Sprint N”" });
  const start = h("input", { type: "date", value: sprint ? toDateInput(sprint.start_date) : iso(today) });
  const end = h("input", { type: "date", value: sprint ? toDateInput(sprint.end_date) : iso(two) });
  const goal = h("textarea", { rows: 3, maxLength: 5000, placeholder: "What should this sprint achieve?" }, sprint?.goal || "");
  const length = h("span.muted.small");
  const updateLength = () => {
    if (!start.value || !end.value) { length.textContent = ""; return; }
    const days = Math.round((new Date(end.value) - new Date(start.value)) / 86400000) + 1;
    length.textContent = days > 0 ? `${days} days · ${Math.ceil(days / 7)} week${days > 7 ? "s" : ""}` : "End is before start";
  };
  [start, end].forEach((i) => i.addEventListener("input", updateLength));
  updateLength();
  const presets = h("div.chips", [7, 14, 21].map((d) => h("button.chip", {
    type: "button",
    onclick: () => {
      const s = start.value ? new Date(`${start.value}T00:00`) : today;
      end.value = iso(new Date(s.getFullYear(), s.getMonth(), s.getDate() + d - 1));
      updateLength();
    },
  }, `${d / 7} week${d > 7 ? "s" : ""}`)));
  const form = h("form.form",
    field("Name", name),
    h("div.grid-2.tight", field("Start", start), field("End", end)),
    h("div.row.wrap.between", presets, length),
    field("Goal", goal),
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, editing ? "Save" : "Create sprint")));
  const m = modal(editing ? `Edit ${sprint.name}` : `New sprint · ${project.key}`, form);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = { goal: goal.value, start_date: fromStartInput(start.value), end_date: fromDateInput(end.value) };
    if (name.value.trim() || editing) body.name = name.value.trim() || sprint.name;
    busy(form.querySelector("[type=submit]"), async () => {
      if (editing) await api.patch(`/sprints/${sprint.id}`, body);
      else await api.post(`/projects/${project.id}/sprints`, body);
      m.close();
      toast(editing ? "Sprint saved" : "Sprint created");
      onSaved();
    });
  });
}

function completeDialog(sprint, planned, onDone) {
  const open = sprint.open_count;
  const target = select("target", [["", "Backlog"], ...planned.map((s) => [String(s.id), s.name])], planned[0] ? String(planned[0].id) : "");
  const form = h("form.form",
    h("div.sprint-summary",
      h("div", h("strong", String(sprint.done_count)), h("span.muted.small", "done")),
      h("div", h("strong", String(open)), h("span.muted.small", "unfinished")),
      h("div", h("strong", `${sprint.ticket_count ? Math.round((sprint.done_count / sprint.ticket_count) * 100) : 0}%`), h("span.muted.small", "completion"))),
    open ? field(`Move the ${open} unfinished ticket${open === 1 ? "" : "s"} to`, target) : h("p.muted", "Every ticket is finished. 🎉"),
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, icon("check", { size: 15 }), "Complete sprint")));
  const m = modal(`Complete ${sprint.name}`, form);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(form.querySelector("[type=submit]"), async () => {
      await api.post(`/sprints/${sprint.id}/complete`, { move_open_to: target.value ? Number(target.value) : null });
      m.close();
      toast(`${sprint.name} completed`);
      onDone();
    });
  });
}

export async function renderProjectSprints(container, project, { owner }) {
  const selected = new Set();
  let sprints = [];
  let ticketsBy = new Map();
  let backlog = [];
  let showCompleted = false;

  async function load() {
    if (!sprints.length) clear(container, spinner());
    sprints = await api.get(`/projects/${project.id}/sprints`);
    const live = sprints.filter((s) => s.status !== "completed");
    const [lists, back] = await Promise.all([
      Promise.all(live.map((s) => api.get(`/projects/${project.id}/tickets`, { sprint_id: s.id, sort: "priority", limit: 200 }))),
      api.get(`/projects/${project.id}/tickets`, { backlog: true, status: OPEN, in_release: false, sort: "priority", limit: 200 }),
    ]);
    ticketsBy = new Map(live.map((s, i) => [s.id, lists[i].items]));
    backlog = back.items;
    [...selected].forEach((id) => { if (![...ticketsBy.values()].flat().concat(backlog).some((t) => t.id === id)) selected.delete(id); });
    await draw();
  }

  async function move(ids, sprintId) {
    if (!ids.length) return;
    await busy(null, async () => {
      const r = await api.post(`/projects/${project.id}/sprint-moves`, { ticket_ids: ids, sprint_id: sprintId });
      const target = sprintId ? sprints.find((s) => s.id === sprintId)?.name : "the backlog";
      toast(`${r.moved} ticket${r.moved === 1 ? "" : "s"} moved to ${target}`);
      selected.clear();
      await load();
    });
  }

  // ------------------------------------------------------------- rows + sections
  const row = (t) => h(`div.sp-row${selected.has(t.id) ? ".is-selected" : ""}${CLOSED.includes(t.status) ? ".is-done" : ""}`, {
    draggable: owner ? "true" : null, dataset: { id: t.id },
    ondragstart: (e) => {
      const ids = selected.has(t.id) ? [...selected] : [t.id];
      e.dataTransfer.setData("text/plain", JSON.stringify(ids));
      e.dataTransfer.effectAllowed = "move";
      e.currentTarget.classList.add("dragging");
    },
    ondragend: (e) => e.currentTarget.classList.remove("dragging"),
  },
  owner && h("input", {
    type: "checkbox", checked: selected.has(t.id), "aria-label": `Select ${t.key}`,
    onchange: (e) => { if (e.target.checked) selected.add(t.id); else selected.delete(t.id); drawBar(); e.target.closest(".sp-row").classList.toggle("is-selected", e.target.checked); },
  }),
  h("a.key", { href: `#/tickets/${t.key}` }, t.key),
  typeBadge(t.type),
  h("a.sp-title", { href: `#/tickets/${t.key}`, title: t.title }, t.title),
  h("span.sp-meta", statusBadge(t.status), priorityBadge(t.priority),
    t.estimated_hours ? h("span.muted.small", `${t.estimated_hours}h`) : null, avatarStack(t.assignees, "sm")));

  function dropZone(el, sprintId) {
    if (!owner) return el;
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop"); });
    el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove("drop"); });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop");
      try { move(JSON.parse(e.dataTransfer.getData("text/plain")), sprintId); } catch { /* not a ticket */ }
    });
    return el;
  }

  async function activeCard(s) {
    const items = ticketsBy.get(s.id) || [];
    const pct = s.ticket_count ? Math.round((s.done_count / s.ticket_count) * 100) : 0;
    const elapsed = s.days_total ? Math.min(100, Math.max(0, Math.round(((s.days_total - Math.max(0, s.days_left ?? 0) - 1) / s.days_total) * 100))) : 0;
    let chart = h("p.muted.small", "Burndown appears once the sprint has dates.");
    try {
      const bd = await api.get(`/sprints/${s.id}/burndown`);
      if (bd.length) {
        chart = lineChart({
          labels: bd.map((p) => p.date), height: 180,
          formatLabel: (l, long) => new Date(`${l}T00:00`).toLocaleDateString(undefined, long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" }),
          series: [
            { name: "Remaining", color: "var(--series-1)", values: bd.map((p) => p.remaining) },
            { name: "Ideal", color: "var(--muted)", values: bd.map((p) => p.ideal), dashed: true },
          ],
        });
      }
    } catch { /* chart is optional */ }
    return dropZone(h("section.card.sprint-active",
      h("div.sprint-head",
        h("div",
          h("div.row.wrap", h("span.sprint-status.active", h("i"), "Active"), h("h2.sprint-name", s.name), daysLeftPill(s)),
          h("div.muted.small.sprint-dates", icon("calendar", { size: 13 }), sprintRange(s), s.days_total ? ` · ${s.days_total} days` : ""),
          s.goal && h("p.sprint-goal", icon("target", { size: 14 }), s.goal)),
        h("div.row.wrap.sprint-actions",
          h("a.btn.sm", { href: `#/projects/${project.id}?sprint=active` }, icon("columns", { size: 14 }), "Board"),
          s.can_manage && h("button.btn.sm", { onclick: () => sprintDialog(project, s, load) }, icon("edit", { size: 14 }), "Edit"),
          s.can_manage && h("button.btn.sm.primary", { onclick: () => completeDialog(s, sprints.filter((x) => x.status === "planned"), load) }, icon("check", { size: 14 }), "Complete sprint"))),
      h("div.sprint-stats",
        h("div.sprint-progress",
          h("div.row.between.small", h("span", h("strong", `${s.done_count}/${s.ticket_count}`), " tickets done"), h("strong", `${pct}%`)),
          h("div.sp-bar", h("i.done", { style: { width: `${pct}%` } }), h("b.time", { style: { left: `${elapsed}%` }, title: `${elapsed}% of the sprint has passed` }))),
        h("div.sprint-kpi", h("span.muted.small", "Open"), h("strong", String(s.open_count))),
        h("div.sprint-kpi", h("span.muted.small", "Hours"), h("strong", `${s.spent_hours}/${s.estimated_hours || 0}h`)),
        h("div.sprint-kpi", h("span.muted.small", "Time used"), h("strong", `${elapsed}%`))),
      h("div.sprint-body",
        h("div.sp-list", items.length ? items.map(row) : h("div.sp-empty", owner ? "Drag tickets here from the backlog." : "No tickets in this sprint yet.")),
        h("div.sprint-chart", h("div.small.muted.chart-title", "Burndown"), chart))), s.id);
  }

  function plannedCard(s) {
    const items = ticketsBy.get(s.id) || [];
    const hours = items.reduce((a, t) => a + (t.estimated_hours || 0), 0);
    return dropZone(h("section.card.sprint-planned",
      h("div.sprint-head",
        h("div",
          h("div.row.wrap", h("span.sprint-status", h("i"), "Planned"), h("h2.sprint-name", s.name),
            h("span.muted.small", `${items.length} ticket${items.length === 1 ? "" : "s"}${hours ? ` · ${hours}h` : ""}`)),
          h("div.muted.small.sprint-dates", icon("calendar", { size: 13 }), sprintRange(s), s.days_total ? ` · ${s.days_total} days` : ""),
          s.goal && h("p.sprint-goal", icon("target", { size: 14 }), s.goal)),
        s.can_manage && h("div.row.wrap.sprint-actions",
          h("button.btn.sm", { onclick: () => sprintDialog(project, s, load) }, icon("edit", { size: 14 }), "Edit"),
          h("button.btn.sm.ghost.danger", {
            onclick: async () => {
              if (!(await confirmDialog("Delete sprint", `Delete ${s.name}? Its ${items.length} ticket(s) go back to the backlog.`))) return;
              await busy(null, async () => { await api.del(`/sprints/${s.id}`); toast("Sprint deleted"); await load(); });
            },
          }, icon("trash", { size: 14 })),
          h("button.btn.sm.primary", {
            disabled: sprints.some((x) => x.status === "active"),
            title: sprints.some((x) => x.status === "active") ? "Complete the active sprint first" : "Start this sprint",
            onclick: (e) => busy(e.currentTarget, async () => { await api.post(`/sprints/${s.id}/start`); toast(`${s.name} started`); await load(); }),
          }, icon("rocket", { size: 14 }), "Start sprint"))),
      h("div.sp-list", items.length ? items.map(row) : h("div.sp-empty", owner ? "Drag tickets here, or select them in the backlog." : "Nothing planned yet."))), s.id);
  }

  function backlogCard() {
    const hours = backlog.reduce((a, t) => a + (t.estimated_hours || 0), 0);
    return dropZone(h("section.card.sprint-backlog",
      h("div.sprint-head",
        h("div", h("div.row.wrap", h("span.sprint-status.backlog", h("i"), "Backlog"),
          h("span.muted.small", `${backlog.length} open ticket${backlog.length === 1 ? "" : "s"} not in a sprint${hours ? ` · ${hours}h` : ""}`)))),
      h("div.sp-list", backlog.length ? backlog.map(row) : h("div.sp-empty", "The backlog is empty - everything open is planned."))), null);
  }

  function completedList() {
    const done = sprints.filter((s) => s.status === "completed");
    if (!done.length) return null;
    return h("section.card.flush.sprint-history",
      h("button.sprint-history-toggle", { type: "button", onclick: () => { showCompleted = !showCompleted; draw(); } },
        icon(showCompleted ? "chevron-down" : "chevron-right", { size: 16 }), h("strong", `Completed sprints (${done.length})`)),
      showCompleted && h("div.table-wrap", h("table.table",
        h("thead", h("tr", h("th", "Sprint"), h("th", "Dates"), h("th", "Done"), h("th", "Hours"), h("th", "Completed"))),
        h("tbody", done.map((s) => h("tr",
          h("td", h("strong", s.name), s.goal ? h("div.muted.small.ellipsis", s.goal) : null),
          h("td.muted", sprintRange(s)),
          h("td", `${s.done_count} tickets`),
          h("td.muted", `${s.spent_hours}h`),
          h("td.muted", fmtDate(s.completed_at))))))));
  }

  const bar = h("div.bulk-bar", { hidden: true });
  function drawBar() {
    bar.hidden = !selected.size;
    if (!selected.size) return;
    const targets = sprints.filter((s) => s.status !== "completed");
    clear(bar, h("strong", `${selected.size} selected`),
      select("move", [["", "Move to…"], ...targets.map((s) => [String(s.id), `${s.name}${s.status === "active" ? " (active)" : ""}`]), ["backlog", "Backlog"]], "", {
        "aria-label": "Move to",
        onchange: (e) => { const v = e.target.value; if (v) move([...selected], v === "backlog" ? null : Number(v)); },
      }),
      h("button.btn.sm.ghost", { onclick: () => { selected.clear(); draw(); } }, "Clear selection"));
  }

  async function draw() {
    const active = sprints.find((s) => s.status === "active");
    const planned = sprints.filter((s) => s.status === "planned");
    const activeEl = active ? await activeCard(active) : null;
    clear(container,
      h("div.row.between.wrap.sprint-toolbar",
        h("p.muted.small", owner ? "Plan tickets into sprints by selecting them or dragging rows between sections." : "Sprints of this project."),
        owner && h("button.btn.primary", { onclick: () => sprintDialog(project, null, load) }, icon("plus", { size: 15 }), "New sprint")),
      bar,
      !active && !planned.length && emptyState("No sprints yet", owner ? "Create a sprint, plan tickets into it from the backlog, then start it." : "An owner hasn't planned a sprint yet.",
        owner ? h("button.btn.primary", { onclick: () => sprintDialog(project, null, load) }, "Create the first sprint") : null, "timeline"),
      activeEl,
      planned.map(plannedCard),
      backlogCard(),
      completedList());
    drawBar();
  }

  await load();
}
