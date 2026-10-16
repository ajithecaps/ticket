// Timeline: a Gantt chart of planned tickets, grouped by person (or project).
// Admins see everyone; project owners the people of their projects; developers themselves.
// Owners can drag a bar to move it, or drag its ends to change the start / due date.
import { api } from "../api.js";
import { currentQuery, setQuery } from "../app.js";
import {
  avatar, clear, emptyState, errorBox, fmtDate, fmtHours, fromDateInput, fromStartInput, h, label, parseDate, spinner,
  toast,
} from "../ui.js";

const DAY = 86400000;
const ROW = 34;
const ZOOMS = {
  day: { px: 38, span: 35, step: 7, label: "Day" },
  week: { px: 15, span: 91, step: 28, label: "Week" },
  month: { px: 5, span: 210, step: 91, label: "Month" },
};
const FINISHED = ["done", "verified"];
const COLLAPSE_KEY = "tickets.gantt.collapsed";

const localDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayIndex = (start, d) => Math.round((localDay(d) - start) / DAY);
const monday = (d) => addDays(localDay(d), -((d.getDay() + 6) % 7));
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
const short = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });

function progress(t) {
  if (FINISHED.includes(t.status)) return 100;
  const ratio = t.estimated_hours ? Math.min(0.95, (t.spent_hours || 0) / t.estimated_hours) : null;
  if (t.status === "in_review") return 85;
  if (t.status === "in_progress") return Math.round((ratio ?? 0.5) * 100);
  if (t.status === "blocked") return Math.round((ratio ?? 0.3) * 100);
  return Math.round((ratio ?? 0) * 100);
}

function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]")); } catch { return new Set(); }
}
function saveCollapsed(set) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* per-viewer nicety only */ }
}

export async function renderTimeline(main, { projectId = null } = {}) {
  const q = currentQuery();
  const state = {
    zoom: ZOOMS[q.get("zoom")] ? q.get("zoom") : "day",
    start: q.get("from") ? localDay(new Date(`${q.get("from")}T00:00`)) : null,
    project: projectId ? String(projectId) : (q.get("project") || ""),
    person: q.get("person") || "",
    group: q.get("group") === "project" ? "project" : "person",
    done: q.get("done") === "1",
  };
  const defaultStart = () => addDays(monday(new Date()), state.zoom === "day" ? -7 : state.zoom === "week" ? -14 : -28);
  state.start = state.start || defaultStart();
  const collapsed = loadCollapsed();
  const projects = projectId ? [] : await api.get("/projects");

  const chart = h("div.gantt-wrap");
  const rangeLabel = h("strong.tl-range");
  const personSel = h("select", { "aria-label": "Person", onchange: (e) => { state.person = e.target.value; load(); } });
  let people = [];
  let lastData = null;
  let keepScroll = null;

  const chipGroup = (options, current, onPick, aria) => h("div.chips.seg", { role: "group", "aria-label": aria },
    options.map(([v, text]) => h("button.chip", {
      type: "button", "aria-pressed": String(current() === v),
      onclick: (e) => {
        onPick(v);
        e.currentTarget.parentElement.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget)));
      },
    }, text)));

  const toolbar = h("div.card.gantt-toolbar",
    h("div.row.wrap",
      chipGroup(Object.entries(ZOOMS).map(([k, z]) => [k, z.label]), () => state.zoom, (v) => { state.zoom = v; state.start = defaultStart(); load(); }, "Zoom"),
      h("div.row.nav-btns",
        h("button.btn.sm", { "aria-label": "Earlier", onclick: () => { state.start = addDays(state.start, -ZOOMS[state.zoom].step); load(); } }, "‹"),
        h("button.btn.sm", { onclick: () => { state.start = defaultStart(); load({ toToday: true }); } }, "Today"),
        h("button.btn.sm", { "aria-label": "Later", onclick: () => { state.start = addDays(state.start, ZOOMS[state.zoom].step); load(); } }, "›"),
        rangeLabel)),
    h("div.row.wrap",
      chipGroup([["person", "By person"], ["project", "By project"]], () => state.group, (v) => { state.group = v; draw(); }, "Group by"),
      !projectId && h("select", { "aria-label": "Project", onchange: (e) => { state.project = e.target.value; state.person = ""; load(); } },
        h("option", { value: "" }, "All projects"),
        projects.map((p) => h("option", { value: p.id, selected: String(p.id) === state.project }, `${p.key} · ${p.name}`))),
      personSel,
      h("label.check", h("input", { type: "checkbox", checked: state.done, onchange: (e) => { state.done = e.target.checked; load(); } }), "Show finished"),
      h("button.btn.sm.ghost", { onclick: () => { groupsOf(lastData).forEach((g) => collapsed.delete(g.key)); saveCollapsed(collapsed); draw(); } }, "Expand all"),
      h("button.btn.sm.ghost", { onclick: () => { groupsOf(lastData).forEach((g) => collapsed.add(g.key)); saveCollapsed(collapsed); draw(); } }, "Collapse all")));

  async function load({ toToday = false } = {}) {
    const { span } = ZOOMS[state.zoom];
    const end = addDays(state.start, span - 1);
    if (!projectId) {
      setQuery({ zoom: state.zoom !== "day" ? state.zoom : "", from: iso(state.start), project: state.project,
        person: state.person, group: state.group !== "person" ? state.group : "", done: state.done ? "1" : "" });
    }
    rangeLabel.textContent = `${short(state.start)} – ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
    if (!lastData) clear(chart, spinner());
    try {
      const [data, releases] = await Promise.all([
        api.get("/timeline", { start: iso(state.start), end: iso(end), project_id: state.project || undefined,
          user_id: state.person || undefined, include_done: state.done || undefined }),
        api.get("/releases", { project_id: state.project || undefined }).catch(() => []),
      ]);
      data.releases = releases;
      lastData = data;
    } catch (err) { clear(chart, errorBox(err)); return; }

    if (!state.person) people = lastData.rows.map((r) => r.user);
    clear(personSel, h("option", { value: "" }, lastData.scope === "self" ? "Me" : "Everyone"),
      people.map((u) => h("option", { value: u.id, selected: String(u.id) === state.person }, u.name)));
    personSel.hidden = lastData.scope === "self";
    draw({ toToday });
  }

  // ---------------------------------------------------------------- grouping
  function groupsOf(data) {
    if (!data) return [];
    if (state.group === "person") {
      return data.rows.map((r) => ({
        key: `u${r.user.id}`, kind: "person", user: r.user, tickets: r.tickets, unscheduled: r.unscheduled,
        overlapCount: r.overlap_count,
      }));
    }
    const byProject = new Map();
    data.rows.forEach((r) => r.tickets.forEach((t) => {
      if (!byProject.has(t.project.id)) byProject.set(t.project.id, { key: `p${t.project.id}`, kind: "project", project: t.project, tickets: [], unscheduled: [] });
      byProject.get(t.project.id).tickets.push(t);
    }));
    return [...byProject.values()]
      .map((g) => ({ ...g, tickets: g.tickets.sort((a, b) => a.window_start.localeCompare(b.window_start)), overlapCount: g.tickets.filter((t) => t.overlaps.length).length }))
      .sort((a, b) => a.project.name.localeCompare(b.project.name));
  }

  // ---------------------------------------------------------------- drawing
  function draw({ toToday = false } = {}) {
    const data = lastData;
    if (!data) return;
    const { px, span } = ZOOMS[state.zoom];
    const start = state.start;
    const dates = Array.from({ length: span }, (_, i) => addDays(start, i));
    const width = span * px;
    const today = dayIndex(start, new Date());
    const groups = groupsOf(data);
    const scroller = chart.querySelector(".g-scroll");
    if (scroller && !toToday) keepScroll = { left: scroller.scrollLeft, top: scroller.scrollTop };

    if (!groups.length) {
      clear(chart, h("div.card", emptyState(data.rows.length ? "Nothing planned in this period" : "Nobody to show",
        data.rows.length ? "Tickets appear here once they have a due date. Use ‹ › to look at other weeks." : "No team members match these filters.")));
      return;
    }

    // ---- header: two scale tiers + milestones
    const tierTop = h("div.g-tier.top", { style: { width: `${width}px` } });
    const tierBottom = h("div.g-tier.bottom", { style: { width: `${width}px` } });
    const segments = (keyOf, text) => {
      const out = [];
      let i = 0;
      while (i < span) {
        const k = keyOf(dates[i]);
        let j = i;
        while (j < span && keyOf(dates[j]) === k) j += 1;
        const content = text(dates[i], j - i);
        out.push(h("span", { style: { left: `${i * px}px`, width: `${(j - i) * px}px` } }, content ? h("em", content) : ""));
        i = j;
      }
      return out;
    };
    if (state.zoom === "month") {
      tierTop.append(...segments((d) => d.getFullYear(), (d) => String(d.getFullYear())));
      tierBottom.append(...segments((d) => `${d.getFullYear()}-${d.getMonth()}`, (d, n) => (n * px > 34 ? d.toLocaleDateString(undefined, { month: "short" }) : "")));
    } else {
      tierTop.append(...segments((d) => `${d.getFullYear()}-${d.getMonth()}`, (d, n) => (n * px > 60 ? d.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : d.toLocaleDateString(undefined, { month: "short" }))));
      if (state.zoom === "day") {
        tierBottom.append(...dates.map((d, k) => h(`span.day${isWeekend(d) ? ".we" : ""}${k === today ? ".is-today" : ""}`,
          { style: { left: `${k * px}px`, width: `${px}px` }, title: d.toDateString() },
          h("b", String(d.getDate())), h("i", d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)))));
      } else {
        tierBottom.append(...segments((d) => iso(monday(d)), (d, n) => (n * px >= 28 ? `${monday(d).getDate()}` : "")));
      }
    }

    // Releases inside the range become milestones.
    const milestones = (data.releases || []).map((r) => {
      const when = parseDate(r.status === "released" ? r.released_at : r.planned_date);
      if (!when) return null;
      const k = dayIndex(start, when);
      if (k < 0 || k >= span) return null;
      return { r, k };
    }).filter(Boolean);
    const milestoneRow = h("div.g-tier.milestones", { style: { width: `${width}px` } },
      milestones.map(({ r, k }) => h(`a.g-milestone.${r.status}`, {
        href: `#/releases/${r.id}`, style: { left: `${k * px + px / 2}px` },
        title: `${r.project.key} ${r.name} · ${r.status === "released" ? "released" : "planned"} ${fmtDate(r.status === "released" ? r.released_at : r.planned_date)}`,
      }, h("i"), h("span", `${r.project.key} ${r.name}`))));

    const header = h("div.g-header",
      h("div.g-left.g-left-head",
        h("span.c-key", "Key"), h("span.c-title", state.group === "person" ? "Person / ticket" : "Project / ticket"),
        h("span.c-date", "Start"), h("span.c-date", "Due"), h("span.c-dur", "Days")),
      h("div.g-scale", tierTop, tierBottom, milestones.length ? milestoneRow : null));

    // ---- background: weekends, week lines, today, milestone lines
    const bg = h("div.g-bg", { style: { width: `${width}px` } },
      state.zoom !== "month" ? dates.map((d, k) => (isWeekend(d) ? h("span.we", { style: { left: `${k * px}px`, width: `${px}px` } }) : null)) : null,
      dates.map((d, k) => ((state.zoom === "day" ? d.getDay() === 1 : d.getDate() === 1) && k ? h("span.line", { style: { left: `${k * px}px` } }) : null)),
      milestones.map(({ k, r }) => h(`span.mline.${r.status}`, { style: { left: `${k * px + px / 2}px` } })),
      today >= 0 && today < span ? h("span.today", { style: { left: `${today * px + px / 2}px` } }, h("em", "Today")) : null);

    // ---- rows
    const body = h("div.g-body", h("div.g-bg-wrap", bg));
    groups.forEach((g) => {
      const isOpen = !collapsed.has(g.key);
      const open = g.tickets.filter((t) => !FINISHED.includes(t.status));
      const load = new Array(span).fill(0);
      open.forEach((t) => {
        const a = Math.max(0, dayIndex(start, parseDate(t.window_start)));
        const b = Math.min(span - 1, dayIndex(start, parseDate(t.window_end)));
        for (let k = a; k <= b; k += 1) load[k] += 1;
      });
      const busiest = Math.max(0, ...load);

      const toggle = () => { if (collapsed.has(g.key)) collapsed.delete(g.key); else collapsed.add(g.key); saveCollapsed(collapsed); draw(); };
      const who = g.kind === "person"
        ? [avatar(g.user, "sm"), h("span.g-gname", g.user.name)]
        : [h("span.key-pill", g.project.key), h("span.g-gname", g.project.name)];
      const stats = [
        `${open.length} open`,
        g.overlapCount ? h("span.danger-text", ` · ${g.overlapCount} overlapping`) : null,
        g.unscheduled?.length ? h("span", { title: g.unscheduled.map((t) => `${t.key} ${t.title}`).join("\n") }, ` · ${g.unscheduled.length} without due date`) : null,
      ];
      body.append(h("div.g-row.g-group",
        h("div.g-left", { onclick: toggle },
          h("button.g-toggle", { type: "button", "aria-expanded": String(isOpen), "aria-label": isOpen ? "Collapse" : "Expand" }, isOpen ? "▾" : "▸"),
          who, h("span.g-stats.small.muted", stats)),
        h("div.g-right", { style: { width: `${width}px` } },
          // Workload heat strip: how many open tickets this group has on each day.
          h("div.g-heat", load.map((n, k) => (n ? h(`span.h${Math.min(n, 3)}`, {
            style: { left: `${k * px}px`, width: `${px}px` }, title: `${n} ticket${n > 1 ? "s" : ""} · ${dates[k].toDateString()}`,
          }) : null))),
          !isOpen && busiest ? h("span.g-collapsed-note.small.muted", { style: { left: "6px" } }, `${g.tickets.length} tickets · up to ${busiest} on one day`) : null)));

      if (!isOpen) return;
      g.tickets.forEach((t) => body.append(ticketRow(t, { start, span, px, width, showAssignee: g.kind === "project" })));
      if (g.kind === "person" && g.unscheduled?.length) {
        body.append(h("div.g-row.g-unsched",
          h("div.g-left", h("span.c-key"), h("span.c-title.small.muted", "No due date: ",
            g.unscheduled.slice(0, 6).map((t, i) => [i ? ", " : "", h("a", { href: `#/tickets/${t.key}`, title: t.title }, t.key)]),
            g.unscheduled.length > 6 ? ` +${g.unscheduled.length - 6}` : "")),
          h("div.g-right", { style: { width: `${width}px` } })));
      }
    });

    const scroll = h("div.g-scroll", h("div.g-grid", { style: { "--g-width": `${width}px` } }, header, body));
    clear(chart, h("div.card.flush.gantt", scroll, legend(), tip));

    if (keepScroll && !toToday) { scroll.scrollLeft = keepScroll.left; scroll.scrollTop = keepScroll.top; keepScroll = null; } else if (today >= 0 && today < span) {
      requestAnimationFrame(() => { scroll.scrollLeft = Math.max(0, today * px - (scroll.clientWidth - leftWidth(scroll)) / 3); });
    }
  }

  const leftWidth = (scroll) => scroll.querySelector(".g-left")?.offsetWidth || 0;

  function ticketRow(t, { start, span, px, width, showAssignee }) {
    const s = parseDate(t.window_start);
    const e = parseDate(t.window_end);
    let from = dayIndex(start, s);
    let to = dayIndex(start, e);
    const clippedL = from < 0;
    const clippedR = to > span - 1;
    const finished = FINISHED.includes(t.status);
    const pct = progress(t);

    const bar = h("a.g-bar", {
      href: `#/tickets/${t.key}`, draggable: "false",
      class: [`status-${t.status}`, t.overlaps.length && !finished ? "clash" : "", t.is_overdue ? "overdue" : "", t.start_planned ? "" : "est",
        finished ? "finished" : "", clippedL ? "cl" : "", clippedR ? "cr" : "", t.can_reschedule ? "movable" : ""].filter(Boolean).join(" "),
    },
    h("span.g-fill", { style: { width: `${pct}%` } }),
    t.can_reschedule && !clippedL ? h("span.g-handle.l") : null,
    t.can_reschedule && !clippedR ? h("span.g-handle.r") : null);
    const place = () => {
      const a = Math.max(0, from);
      const b = Math.min(span - 1, to);
      bar.style.left = `${a * px + 1}px`;
      bar.style.width = `${Math.max(px - 2, (b - a + 1) * px - 2)}px`;
      lbl.style.left = `${(b + 1) * px + 6}px`;
    };
    const lbl = h("span.g-label", h("b", t.key), " ", t.title, showAssignee && t.assignee ? h("span.muted", ` · ${t.assignee.name}`) : null,
      pct && !finished ? h("span.muted", ` · ${pct}%`) : null);
    place();

    bar.addEventListener("mouseenter", (ev) => showTip(ev, t, from, to, start));
    bar.addEventListener("mousemove", moveTip);
    bar.addEventListener("mouseleave", hideTip);
    if (t.can_reschedule) enableDrag(bar, t, { px, start, get: () => [from, to], set: (a, b) => { from = a; to = b; place(); } });

    return h("div.g-row",
      h("div.g-left",
        h("a.c-key.key", { href: `#/tickets/${t.key}` }, t.key),
        h("span.c-title", { title: t.title },
          h(`i.status-dot.status-${t.status}`),
          h("span.ellipsis", t.title),
          showAssignee && t.assignee ? avatar(t.assignee, "sm") : null,
          t.overlaps.length && !finished ? h("span.g-clash", { title: `Overlaps ${t.overlaps.join(", ")}` }, "⚠") : null),
        h(`span.c-date${t.start_planned ? "" : ".muted"}`, { title: t.start_planned ? "Planned start" : "No planned start: from assignment" }, short(s)),
        h(`span.c-date${t.is_overdue ? ".danger-text" : ""}`, short(e)),
        h("span.c-dur.muted", String(Math.max(1, Math.round((localDay(e) - localDay(s)) / DAY) + 1)))),
      h("div.g-right", { style: { width: `${width}px` } }, bar, lbl));
  }

  // ---------------------------------------------------------------- drag to reschedule
  function enableDrag(bar, t, { px, start, get, set }) {
    let drag = null;
    bar.addEventListener("dragstart", (e) => e.preventDefault());
    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const rect = bar.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const mode = e.target.classList.contains("l") || x < 7 ? "start" : e.target.classList.contains("r") || x > rect.width - 7 ? "end" : "move";
      const [from, to] = get();
      drag = { mode, x0: e.clientX, from, to, moved: false };
      bar.setPointerCapture(e.pointerId);
      bar.classList.add("dragging");
    });
    bar.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const d = Math.round((e.clientX - drag.x0) / px);
      if (d !== 0) drag.moved = true;
      let a = drag.from;
      let b = drag.to;
      if (drag.mode === "move") { a += d; b += d; } else if (drag.mode === "start") a = Math.min(drag.from + d, drag.to); else b = Math.max(drag.to + d, drag.from);
      set(a, b);
      tipText(`${drag.mode === "end" ? "Due" : "Start"} ${short(addDays(start, drag.mode === "end" ? b : a))}${drag.mode === "move" ? ` → due ${short(addDays(start, b))}` : ""}`, e);
    });
    const finish = async (e) => {
      if (!drag) return;
      const { mode, from, to, moved } = drag;
      drag = null;
      bar.classList.remove("dragging");
      bar.releasePointerCapture?.(e.pointerId);
      hideTip();
      if (!moved) return;
      bar.addEventListener("click", (ev) => ev.preventDefault(), { once: true, capture: true });
      const [a, b] = get();
      if (a === from && b === to) return;
      const body = {};
      if (mode !== "end") body.start_date = fromStartInput(iso(addDays(start, a)));
      if (mode !== "start") body.due_date = fromDateInput(iso(addDays(start, b)));
      try {
        await api.patch(`/tickets/${t.id}`, body);
        toast(`${t.key}: ${short(addDays(start, a))} → ${short(addDays(start, b))}`);
        await load();
      } catch (err) {
        set(from, to);
        toast(err.message, "error");
      }
    };
    bar.addEventListener("pointerup", finish);
    bar.addEventListener("pointercancel", finish);
  }

  // ---------------------------------------------------------------- tooltip
  const tip = h("div.g-tip", { hidden: true, role: "tooltip" });
  function showTip(ev, t) {
    const s = parseDate(t.window_start);
    const e = parseDate(t.window_end);
    const span = Math.round((localDay(e) - localDay(s)) / DAY) + 1;
    clear(tip,
      h("div.g-tip-head", h("b", t.key), h(`span.badge.status-${t.status}`, label(t.status))),
      h("div.g-tip-title", t.title),
      h("dl",
        h("dt", "Project"), h("dd", t.project.name),
        h("dt", "Assignee"), h("dd", t.assignee ? t.assignee.name : "—"),
        h("dt", t.start_planned ? "Start" : "From"), h("dd", fmtDate(t.window_start)),
        h("dt", "Due"), h("dd", { class: t.is_overdue ? "danger-text" : "" }, `${fmtDate(t.window_end)}${t.is_overdue ? " (overdue)" : ""}`),
        h("dt", "Duration"), h("dd", `${span} day${span > 1 ? "s" : ""}`),
        h("dt", "Priority"), h("dd", label(t.priority)),
        t.estimated_hours ? [h("dt", "Time"), h("dd", `${fmtHours(t.spent_hours)} of ${fmtHours(t.estimated_hours)}`)] : null),
      t.overlaps.length && !FINISHED.includes(t.status) ? h("div.g-tip-warn", `⚠ Overlaps ${t.overlaps.join(", ")}`) : null,
      t.can_reschedule ? h("div.g-tip-hint", "Drag to move · drag an end to change start or due") : null);
    tip.hidden = false;
    moveTip(ev);
  }
  function tipText(text, ev) { clear(tip, h("div.g-tip-title", text)); tip.hidden = false; moveTip(ev); }
  function moveTip(ev) {
    const pad = 14;
    const w = tip.offsetWidth || 260;
    const x = ev.clientX + pad + w > window.innerWidth ? ev.clientX - w - pad : ev.clientX + pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.min(window.innerHeight - (tip.offsetHeight || 160) - 8, ev.clientY + pad)}px`;
  }
  function hideTip() { tip.hidden = true; }

  function legend() {
    return h("div.g-legend.small.muted",
      h("span", h("i.lg.bar"), "planned (fill = progress)"),
      h("span", h("i.lg.clash"), "overlaps another ticket"),
      h("span", h("i.lg.heat"), "workload: 1 · 2 · 3+ tickets a day"),
      h("span", h("i.lg.est"), "no planned start"),
      h("span", h("i.lg.ms"), "release"),
      lastData && lastData.rows.some((r) => r.tickets.some((t) => t.can_reschedule)) ? h("span", "↔ drag bars to reschedule") : null);
  }

  clear(main,
    !projectId && h("div.page-head", h("div", h("h1", "Timeline"),
      h("p.muted", "Gantt chart of planned work - who is doing what, when, and where people are double-booked."))),
    toolbar, chart);
  await load({ toToday: true });
}
