import { api, auth } from "../api.js";
import { STATUSES, avatar, clear, countUp, h, label, priorityBadge, spinner, avatarStack } from "../ui.js";
import { lineChart, sparkline, stackedBars } from "../charts.js";
import { daysLeftPill, sprintRange } from "./sprints.js";
import { ticketTable } from "./ticketlist.js";
import { coachCard } from "./coach.js";

const OPEN = ["todo", "in_progress", "blocked", "in_review"];

function stat(value, text, { tone = "", href } = {}) {
  const inner = [h("span.stat-value", String(value)), h("span.stat-label", text)];
  return href ? h(`a.stat${tone ? "." + tone : ""}`, { href }, inner) : h(`div.stat${tone ? "." + tone : ""}`, inner);
}

/** Horizontal stacked bar of counts by status, with a legend. */
export function statusBar(byStatus, keys = STATUSES) {
  const total = keys.reduce((n, s) => n + (byStatus[s] || 0), 0);
  return h("div.status-bar-wrap",
    h("div.status-bar", { role: "img", "aria-label": keys.map((s) => `${label(s)} ${byStatus[s] || 0}`).join(", ") },
      total ? keys.filter((s) => byStatus[s]).map((s) => h(`span.seg.status-${s}`, { style: { flex: byStatus[s] }, title: `${label(s)}: ${byStatus[s]}` }))
        : h("span.seg.empty")),
    h("ul.legend", keys.map((s) => h("li", h(`i.status-${s}`), label(s), h("strong", String(byStatus[s] || 0))))));
}

const PERIODS = [[7, "7 days"], [30, "30 days"], [90, "90 days"]];
const STATUS_KEYS = [
  { key: "todo", name: "To do", color: "var(--st-todo)" },
  { key: "in_progress", name: "In progress", color: "var(--st-in_progress)" },
  { key: "blocked", name: "Blocked", color: "var(--st-blocked)" },
  { key: "in_review", name: "In review", color: "var(--st-in_review)" },
];
const ACTION_TEXT = {
  created: "created", status_changed: "moved", assigned: "assigned", unassigned: "unassigned", commented: "commented on",
  updated: "updated", attachment_added: "attached a file to", time_logged: "logged time on", released: "released",
  release_added: "added to a release", converted: "created from an upcoming task",
};

function kpi({ label: text, value, href, tone = "", delta, spark, hint }) {
  const body = [
    h("span.kpi-label", text),
    h("div.kpi-main", h("span.kpi-value", value === null || value === undefined ? "—" : String(value)), spark || null),
    delta || (hint ? h("span.kpi-hint", hint) : null),
  ];
  return href ? h(`a.kpi${tone ? "." + tone : ""}`, { href }, body) : h(`div.kpi${tone ? "." + tone : ""}`, body);
}

/** "+3 vs previous 30 days" - up is good for completed, neutral for created. */
function deltaChip(now, prev, days, upIsGood) {
  const diff = now - prev;
  if (!prev && !now) return h("span.kpi-hint", `none in the last ${days} days`);
  const pct = prev ? Math.round((diff / prev) * 100) : null;
  const dir = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const tone = dir === "flat" || upIsGood === null ? "neutral" : (dir === "up") === upIsGood ? "good" : "bad";
  return h(`span.kpi-delta.${tone}`, { title: `Previous ${days} days: ${prev}` },
    dir === "up" ? "▲" : dir === "down" ? "▼" : "■", ` ${diff > 0 ? "+" : ""}${diff}${pct !== null && dir !== "flat" ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""} vs prev ${days}d`);
}

const shortDate = (iso, long) => new Date(`${iso}T00:00`).toLocaleDateString(undefined, long
  ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });

/** Merge consecutive identical events (same person, action and ticket) into one line with a count. */
function collapseActivity(items) {
  const out = [];
  for (const a of items) {
    const prev = out[out.length - 1];
    if (prev && prev.actor?.id === a.actor?.id && prev.action === a.action && prev.ticket.id === a.ticket.id && a.action !== "status_changed") {
      prev.times += 1;
    } else out.push({ ...a, times: 1 });
  }
  return out;
}

function activityItem(a) {
  const what = ACTION_TEXT[a.action] || a.action.replace(/_/g, " ");
  const extra = a.action === "status_changed" && a.new_value ? [" to ", h(`span.badge.status-${a.new_value}`, label(a.new_value))] : null;
  return h("li.feed-item",
    avatar(a.actor, "sm"),
    h("div.feed-body",
      h("div", h("strong", a.actor ? a.actor.name : "System"), ` ${what} `,
        h("a", { href: `#/tickets/${a.ticket.key}` }, h("span.key", a.ticket.key)), extra,
        a.times > 1 ? h("span.muted.small", ` ×${a.times}`) : null),
      h("div.muted.small.ellipsis", a.ticket_title)),
    h("span.muted.small.feed-time", { title: new Date(a.created_at.endsWith("Z") || a.created_at.includes("+") ? a.created_at : `${a.created_at}Z`).toLocaleString() }, timeAgoShort(a.created_at)));
}
function timeAgoShort(v) {
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  const s = (Date.now() - d) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export async function renderDashboard(main) {
  const isAdmin = auth.user.role === "admin";
  const state = { days: 30, project: "" };
  const projects = await api.get("/projects");
  const owned = projects.filter((p) => p.my_role === "owner" || p.my_role === "admin");
  const body = h("div.dash-body");

  const periodChips = h("div.chips.seg", PERIODS.map(([d, text]) => h("button.chip", {
    type: "button", "aria-pressed": String(state.days === d),
    onclick: (e) => {
      state.days = d;
      e.currentTarget.parentElement.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget)));
      load();
    },
  }, text)));
  const projectSel = h("select", { "aria-label": "Project", onchange: (e) => { state.project = e.target.value; load(); } },
    h("option", { value: "" }, "All my projects"), projects.map((p) => h("option", { value: p.id }, `${p.key} · ${p.name}`)));

  async function load() {
    clear(body, spinner());
    const params = { days: state.days, project_id: state.project || undefined };
    const [d, mine, activeSprints] = await Promise.all([
      api.get("/dashboard", params),
      api.get("/tickets/my", { status: OPEN, sort: "due_date", order: "asc", limit: 8, project_id: state.project || undefined }),
      api.get("/sprints/active").catch(() => []),
    ]);
    const sprintsShown = activeSprints.filter((s) => !state.project || String(s.project.id) === state.project);
    const sprintCard = sprintsShown.length > 0 && h("section.card.flush.dash-sprints",
      h("div.card-head", h("h2", "Active sprints")),
      h("ul.due-list", sprintsShown.map((s) => {
        const pct = s.ticket_count ? Math.round((s.done_count / s.ticket_count) * 100) : 0;
        return h("li.sprint-line",
          h("a.due-main", { href: `#/projects/${s.project.id}/sprints` }, h("span.key-pill", s.project.key), h("strong", s.name),
            h("span.muted.small", sprintRange(s))),
          h("div.due-meta", h("div.sp-bar.small", { title: `${s.done_count}/${s.ticket_count} done` }, h("i.done", { style: { width: `${pct}%` } })),
            h("span.small", `${pct}%`), daysLeftPill(s)));
      })));
    const k = d.kpis;
    const labels = d.trend.map((p) => p.date);
    const createdSeries = d.trend.map((p) => p.created);
    const completedSeries = d.trend.map((p) => p.completed);
    const projQs = state.project ? `&project=${state.project}` : "";

    const tiles = h("section.kpis",
      kpi({ label: "Open tickets", value: k.open, href: `#/tickets?${projQs.slice(1)}`, hint: `${k.unassigned} unassigned` }),
      kpi({ label: "In progress", value: k.in_progress, href: "#/tickets?status=in_progress", hint: k.blocked ? `${k.blocked} blocked` : "none blocked", tone: k.blocked ? "warn" : "" }),
      kpi({ label: "Overdue", value: k.overdue, href: "#/overdue", tone: k.overdue ? "danger" : "good", hint: k.overdue ? "past their due date" : "nothing late" }),
      kpi({ label: "Due in 7 days", value: k.due_week, hint: "open, with a due date" }),
      kpi({ label: `Completed · ${state.days}d`, value: k.completed, spark: sparkline(completedSeries, { color: "var(--series-2)" }), delta: deltaChip(k.completed, k.completed_prev, state.days, true) }),
      kpi({ label: `Created · ${state.days}d`, value: k.created, spark: sparkline(createdSeries), delta: deltaChip(k.created, k.created_prev, state.days, null) }),
      kpi({ label: "Avg. cycle time", value: k.avg_cycle_days === null ? null : `${k.avg_cycle_days}d`, hint: "start → done, completed in period" }),
      kpi({ label: "Awaiting verification", value: k.awaiting_verification, href: owned.length ? "#/verify" : "#/tickets?status=done", tone: k.awaiting_verification ? "accent" : "", hint: "done, not yet verified" }));

    const trendCard = h("section.card.dash-trend",
      h("div.card-head", h("div", h("h2", "Created vs completed"), h("p.muted.small", `Tickets per day, last ${state.days} days`))),
      lineChart({
        labels, height: 230,
        formatLabel: (l, long) => shortDate(l, long),
        series: [
          { name: "Created", color: "var(--series-1)", values: createdSeries },
          { name: "Completed", color: "var(--series-2)", values: completedSeries },
        ],
      }));

    const openTotal = STATUS_KEYS.reduce((a, s) => a + (d.by_status[s.key] || 0), 0);
    const prioMax = Math.max(1, ...Object.values(d.by_priority));
    const mixCard = h("section.card.dash-mix",
      h("div.card-head", h("h2", "Open work")),
      h("div.mix-total", h("span.kpi-value", String(openTotal)), h("span.muted.small", " open tickets")),
      statusBar(Object.fromEntries(STATUS_KEYS.map((s) => [s.key, d.by_status[s.key] || 0])), OPEN),
      h("h3.dash-sub", "By priority"),
      h("ul.prio-bars", ["critical", "high", "medium", "low"].map((p) => h("li",
        h("span.prio-name", priorityBadge(p)),
        h("span.prio-track", h(`i.prio-fill.prio-${p}`, { style: { width: `${(d.by_priority[p] / prioMax) * 100}%` } })),
        h("strong", String(d.by_priority[p]))))));

    const showWorkload = d.workload.length > 1 || d.scope !== "member";
    let workloadView = "chart";
    const workloadBody = h("div");
    const drawWorkload = () => clear(workloadBody, workloadView === "chart"
      ? stackedBars({
        keys: STATUS_KEYS,
        rows: d.workload.map((r) => ({
          name: r.user.name,
          label: h("a.user-chip", { href: `#/timeline?person=${r.user.id}` }, avatar(r.user, "sm"), h("span", r.user.name)),
          segments: STATUS_KEYS.map((s) => ({ key: s.key, value: r.by_status[s.key] || 0 })),
          extra: [r.overdue ? h("span.badge.danger", `${r.overdue} overdue`) : null, r.remaining_hours ? h("span.muted.small", `${r.remaining_hours}h left`) : null],
        })),
      })
      : h("div.table-wrap", h("table.table",
        h("thead", h("tr", h("th", "Person"), STATUS_KEYS.map((s) => h("th", s.name)), h("th", "Overdue"), h("th", "Hours left"))),
        h("tbody", d.workload.map((r) => h("tr", h("td", r.user.name), STATUS_KEYS.map((s) => h("td", String(r.by_status[s.key] || 0))),
          h("td", String(r.overdue)), h("td", String(r.remaining_hours))))))));
    drawWorkload();
    const workloadCard = showWorkload && h("section.card.dash-workload",
      h("div.card-head",
        h("div", h("h2", "Team workload"), h("p.muted.small", d.scope === "all" ? "Open tickets per person, all projects" : "Open tickets per person in the projects you own")),
        h("div.chips.seg", [["chart", "Chart"], ["table", "Table"]].map(([v, text]) => h("button.chip", {
          type: "button", "aria-pressed": String(v === workloadView),
          onclick: (e) => { workloadView = v; e.currentTarget.parentElement.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget))); drawWorkload(); },
        }, text)))),
      d.workload.some((r) => r.open) ? workloadBody : h("p.muted", "Nobody has open tickets."));

    const dueCard = h("section.card.flush.dash-due",
      h("div.card-head", h("h2", "Due this week"), h("a.small", { href: "#/timeline" }, "Timeline")),
      d.due_soon.length ? h("ul.due-list", d.due_soon.map((t) => h("li",
        h("a.due-main", { href: `#/tickets/${t.key}` }, h("span.key", t.key), h("span.ellipsis", t.title)),
        h("div.due-meta", avatarStack(t.assignees, "sm"), h(`span.chip-due${t.is_overdue ? ".overdue" : ""}`, shortDate(t.due_date.slice(0, 10))))))) : h("p.muted.pad", "Nothing due in the next 7 days."));

    const releaseCard = d.releases.length > 0 && h("section.card.flush.dash-releases",
      h("div.card-head", h("h2", "Upcoming releases"), h("a.small", { href: "#/releases" }, "All releases")),
      h("ul.due-list", d.releases.map((r) => h("li",
        h("a.due-main", { href: `#/releases/${r.id}` }, h("span.key-pill", r.project.key), h("strong", r.name)),
        h("div.due-meta", h("span.muted.small", `${r.ticket_count} ticket${r.ticket_count === 1 ? "" : "s"}`),
          r.planned_date ? h("span.chip-due", shortDate(r.planned_date.slice(0, 10))) : h("span.muted.small", "no date"))))));

    const feedCard = h("section.card.flush.dash-feed",
      h("div.card-head", h("h2", "Recent activity")),
      d.activity.length ? h("ul.feed", collapseActivity(d.activity).slice(0, 8).map(activityItem)) : h("p.muted.pad", "No activity yet."));

    const mineCard = h("section.card.flush",
      h("div.card-head", h("h2", "My open work"), h("a.small", { href: "#/tickets?assignee=me" }, "See all")),
      ticketTable(mine.items, { showProject: true }));

    clear(body,
      tiles,
      sprintCard,
      h("div.dash-grid", trendCard, mixCard),
      workloadCard ? h("div.dash-grid", workloadCard, h("div.dash-stack", dueCard, releaseCard)) : h("div.dash-grid.even", dueCard, releaseCard || feedCard),
      h("div.dash-grid", mineCard, workloadCard ? feedCard : (releaseCard ? feedCard : null)));
    body.classList.remove("dash-enter");
    void body.offsetWidth;
    body.classList.add("dash-enter");
    countUp(body);
  }

  const coach = coachCard();
  const first = auth.user.name.split(/\s+/)[0];
  const hour = new Date().getHours();
  clear(main,
    h("div.page-head",
      h("div", h("h1", `Good ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}, ${first}`),
        h("p.muted", isAdmin ? "Everything across your organisation." : owned.length ? "Your projects and your team at a glance." : "Here's what's on your plate.")),
      h("div.actions", projectSel, periodChips)),
    coach,
    body);
  await load();
  return () => coach._cleanup();
}
