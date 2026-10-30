import { api } from "../api.js";
import { currentQuery, setQuery } from "../app.js";
import { avatar, clear, emptyState, errorBox, fmtHours, fmtPct, h, spinner, toDateInput } from "../ui.js";
import { statusBar } from "./dashboard.js";

const METRICS = [
  ["completion_rate", "Completion", "Completed ÷ assigned"],
  ["on_time_rate", "On time", "Completed by the due date ÷ completed tickets that had one"],
  ["first_time_right_rate", "First-time right", "1 − (reopened ÷ ever reached done)"],
];

function scoreCell(score) {
  if (score === null || score === undefined) return h("span.muted", "—");
  const tone = score >= 75 ? "good" : score >= 50 ? "ok" : "low";
  return h(`span.score.${tone}`, h("span.score-bar", h("i", { style: { width: `${Math.max(2, score)}%` } })), h("strong", String(Math.round(score))));
}

/** Shared filter bar: date range presets + project. Calls onChange({from, to, project_id}). */
function filterBar(projects, state, onChange) {
  const today = new Date();
  const daysAgo = (n) => toDateInput(new Date(today.getTime() - n * 86400000).toISOString());
  const presets = [["All time", "", ""], ["Last 30 days", daysAgo(29), daysAgo(0)], ["Last 90 days", daysAgo(89), daysAgo(0)],
    ["This year", `${today.getFullYear()}-01-01`, daysAgo(0)]];

  const from = h("input", { type: "date", value: state.from || "", "aria-label": "From" });
  const to = h("input", { type: "date", value: state.to || "", "aria-label": "To" });
  const proj = h("select", { "aria-label": "Project" }, h("option", { value: "" }, "All projects"),
    projects.map((p) => h("option", { value: p.id, selected: String(p.id) === String(state.project_id || "") }, `${p.key} · ${p.name}`)));
  const emit = () => onChange({ from: from.value, to: to.value, project_id: proj.value });
  [from, to, proj].forEach((el) => el.addEventListener("change", emit));

  return h("div.card.filters-card", h("div.filters",
    h("div.chips", presets.map(([text, f, t]) => h("button.chip", {
      type: "button", "aria-pressed": String((state.from || "") === f && (state.to || "") === t),
      onclick: (e) => {
        from.value = f; to.value = t;
        e.currentTarget.parentElement.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget)));
        emit();
      },
    }, text))),
    h("label.inline", "From", from), h("label.inline", "To", to), proj));
}

export async function renderReports(main) {
  const projects = await api.get("/projects", { include_archived: true });
  const q = currentQuery();
  const state = { from: q.get("from") || "", to: q.get("to") || "", project_id: q.get("project") || "" };
  let sortKey = "efficiency_score";
  let report = null;
  const body = h("div");

  async function load() {
    setQuery({ from: state.from, to: state.to, project: state.project_id });
    clear(body, spinner());
    try {
      [report] = await Promise.all([api.get("/reports/efficiency", {
        from: state.from || undefined, to: state.to || undefined, project_id: state.project_id || undefined,
      })]);
      draw();
    } catch (err) { clear(body, errorBox(err)); }
  }

  function draw() {
    const devs = [...report.developers].sort((a, b) => (b[sortKey] ?? -1) - (a[sortKey] ?? -1));
    const qs = new URLSearchParams({ ...(state.from && { from: state.from }), ...(state.to && { to: state.to }), ...(state.project_id && { project: state.project_id }) }).toString();
    const th = (key, text, title) => h("th.sortable", {
      title, "aria-sort": sortKey === key ? "descending" : "none",
      onclick: () => { sortKey = key; draw(); },
    }, text, sortKey === key ? " ↓" : "");

    clear(body,
      h("section.stats",
        h("div.stat", h("span.stat-value", String(report.team.developers)), h("span.stat-label", "Developers")),
        h("div.stat", h("span.stat-value", String(report.team.assigned)), h("span.stat-label", "Tickets assigned")),
        h("div.stat", h("span.stat-value", String(report.team.completed)), h("span.stat-label", "Completed")),
        h(`div.stat${report.team.overdue_open ? ".danger" : ""}`, h("span.stat-value", String(report.team.overdue_open)), h("span.stat-label", "Overdue & open")),
        h("div.stat", h("span.stat-value", report.team.avg_efficiency_score === null ? "—" : String(Math.round(report.team.avg_efficiency_score))), h("span.stat-label", "Avg. score"))),
      devs.length ? h("div.card.flush", h("div.table-wrap", h("table.table.report",
        h("thead", h("tr",
          h("th", "Developer"),
          th("efficiency_score", "Score", "40% completion + 40% on-time + 20% first-time-right"),
          th("assigned", "Assigned"), th("completed", "Done"),
          METRICS.map(([k, text, title]) => th(k, text, title)),
          th("avg_resolution_hours", "Avg. resolve", "Mean time from assignment to completion"),
          th("overdue_open", "Overdue"))),
        h("tbody", devs.map((d) => h("tr", { onclick: () => { location.hash = `/reports/${d.user.id}${qs ? "?" + qs : ""}`; } },
          h("td", h("a.user-chip", { href: `#/reports/${d.user.id}${qs ? "?" + qs : ""}` }, avatar(d.user, "sm"), h("span", d.user.name))),
          h("td", scoreCell(d.efficiency_score)),
          h("td", String(d.assigned)), h("td", String(d.completed)),
          METRICS.map(([k]) => h("td", fmtPct(d[k]))),
          h("td", fmtHours(d.avg_resolution_hours)),
          h(`td${d.overdue_open ? ".overdue" : ""}`, String(d.overdue_open)))))))) : emptyState("No developers", "No one has tickets in this period."),
      h("p.muted.small.note",
        "Cohort: tickets each person is currently assigned to, received in the selected period, measured as of now (a shared ticket counts for everyone on it). ",
        "A dash means the metric can't be computed yet; the score re-weights around it. ",
        "Scores reward well-scoped work with generous dates — use the per-developer breakdown before drawing conclusions."));
  }

  clear(main,
    h("div.page-head", h("div", h("h1", "Efficiency"), h("p.muted", "How each developer is doing on the work assigned to them."))),
    filterBar(projects, state, (s) => { Object.assign(state, s); load(); }),
    body);
  await load();
}

export async function renderDeveloperReport(main, userId) {
  const q = currentQuery();
  const state = { from: q.get("from") || "", to: q.get("to") || "", project_id: q.get("project") || "" };
  const projects = await api.get("/projects", { include_archived: true });
  const body = h("div");

  async function load() {
    setQuery({ from: state.from, to: state.to, project: state.project_id });
    clear(body, spinner());
    try {
      const d = await api.get(`/reports/efficiency/${userId}`, {
        from: state.from || undefined, to: state.to || undefined, project_id: state.project_id || undefined,
      });
      draw(d);
    } catch (err) { clear(body, errorBox(err)); }
  }

  function draw(d) {
    const tile = (value, text, tone = "") => h(`div.stat${tone ? "." + tone : ""}`, h("span.stat-value", value), h("span.stat-label", text));
    clear(body,
      h("div.dev-head", avatar(d.user, "lg"), h("div", h("h2", d.user.name), h("p.muted", d.user.email)),
        h("div.dev-score", h("span.muted.small", "Efficiency score"), scoreCell(d.efficiency_score))),
      h("section.stats",
        tile(String(d.assigned), "Assigned"), tile(String(d.completed), "Completed"), tile(String(d.open), "Open"),
        tile(String(d.in_progress), "In progress"), tile(String(d.blocked), "Blocked", d.blocked ? "warn" : ""),
        tile(String(d.overdue_open), "Overdue", d.overdue_open ? "danger" : "")),
      h("div.grid-2",
        h("section.card",
          h("h2", "Quality & speed"),
          h("dl.metrics",
            METRICS.map(([k, text, title]) => [h("dt", { title }, text), h("dd", fmtPct(d[k]))]),
            h("dt", "Completed on time / late"), h("dd", `${d.completed_on_time} / ${d.completed_late}`),
            h("dt", "Tickets reopened"), h("dd", String(d.tickets_reopened)),
            h("dt", { title: "Assignment → completion" }, "Avg. resolution"), h("dd", fmtHours(d.avg_resolution_hours)),
            h("dt", { title: "Assignment → first moved to in progress" }, "Avg. time to start"), h("dd", fmtHours(d.avg_time_to_start_hours)),
            h("dt", "Estimated / spent"), h("dd", `${fmtHours(d.estimated_hours)} / ${fmtHours(d.spent_hours)}`),
            h("dt", { title: "Mean per-ticket 1 − |spent − estimate| ÷ estimate" }, "Estimate accuracy"), h("dd", fmtPct(d.estimate_accuracy)))),
        h("section.card",
          h("h2", "Current status mix"),
          statusBar(d.by_status))),
      h("section.card.flush",
        h("div.card-head", h("h2", "By project")),
        d.by_project.length ? h("div.table-wrap", h("table.table",
          h("thead", h("tr", h("th", "Project"), h("th", "Assigned"), h("th", "Completed"), h("th", "Open"), h("th", "Overdue"))),
          h("tbody", d.by_project.map((p) => h("tr",
            h("td", h("a", { href: `#/tickets?project=${p.project.id}` }, h("span.key-pill", p.project.key), p.project.name)),
            h("td", String(p.assigned)), h("td", String(p.completed)), h("td", String(p.open)),
            h(`td${p.overdue_open ? ".overdue" : ""}`, String(p.overdue_open)))))))
          : h("p.muted.pad", "No tickets in this period.")));
  }

  clear(main,
    h("div.crumbs", h("a", { href: "#/reports" }, "Efficiency"), " / Developer"),
    filterBar(projects, state, (s) => { Object.assign(state, s); load(); }),
    body);
  await load();
}
