// Timeline: a Gantt-style calendar of planned tickets per person.
// Admins see everyone; project owners the people of their projects; developers themselves.
import { api } from "../api.js";
import { currentQuery, setQuery } from "../app.js";
import { avatar, clear, emptyState, errorBox, fmtDate, h, label, parseDate, select, spinner } from "../ui.js";

const DAY = 86400000;
const ZOOMS = { "2w": { days: 14, px: 56 }, "4w": { days: 28, px: 34 }, "3m": { days: 91, px: 14 } };

const localDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayIndex = (start, d) => Math.round((localDay(d) - start) / DAY);
const monday = (d) => addDays(localDay(d), -((d.getDay() + 6) % 7));

/** Greedy interval partitioning: overlapping bars go to separate lanes. */
function lanes(items) {
  const ends = [];
  return items.map((it) => {
    let lane = ends.findIndex((e) => e < it.from);
    if (lane === -1) { lane = ends.length; ends.push(it.to); } else ends[lane] = it.to;
    return { ...it, lane };
  });
}

export async function renderTimeline(main, { projectId = null } = {}) {
  const q = currentQuery();
  const state = {
    zoom: ZOOMS[q.get("zoom")] ? q.get("zoom") : "4w",
    start: q.get("from") ? localDay(new Date(`${q.get("from")}T00:00`)) : monday(new Date()),
    project: projectId ? String(projectId) : (q.get("project") || ""),
    person: q.get("person") || "",
    done: q.get("done") === "1",
  };
  const projects = projectId ? [] : await api.get("/projects");
  const body = h("div.tl-body");
  const rangeLabel = h("strong.tl-range");
  let people = [];

  const personSel = h("select", { "aria-label": "Person", onchange: (e) => { state.person = e.target.value; load(); } });
  const controls = h("div.card.filters-card", h("div.filters",
    h("div.chips", Object.keys(ZOOMS).map((z) => h("button.chip", {
      type: "button", "aria-pressed": String(state.zoom === z),
      onclick: (e) => {
        state.zoom = z;
        e.currentTarget.parentElement.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget)));
        load();
      },
    }, { "2w": "2 weeks", "4w": "4 weeks", "3m": "3 months" }[z]))),
    h("div.row",
      h("button.btn.sm", { "aria-label": "Earlier", onclick: () => { state.start = addDays(state.start, -Math.max(7, Math.round(ZOOMS[state.zoom].days / 2))); load(); } }, "‹"),
      h("button.btn.sm", { onclick: () => { state.start = monday(new Date()); load(); } }, "Today"),
      h("button.btn.sm", { "aria-label": "Later", onclick: () => { state.start = addDays(state.start, Math.max(7, Math.round(ZOOMS[state.zoom].days / 2))); load(); } }, "›"),
      rangeLabel),
    !projectId && select("project", [["", "All projects"], ...projects.map((p) => [String(p.id), `${p.key} · ${p.name}`])], state.project,
      { "aria-label": "Project", onchange: (e) => { state.project = e.target.value; state.person = ""; load(); } }),
    personSel,
    h("label.check", h("input", { type: "checkbox", checked: state.done, onchange: (e) => { state.done = e.target.checked; load(); } }), "Show finished")));

  async function load() {
    const { days, px } = ZOOMS[state.zoom];
    const end = addDays(state.start, days - 1);
    if (!projectId) setQuery({ zoom: state.zoom !== "4w" ? state.zoom : "", from: iso(state.start), project: state.project, person: state.person, done: state.done ? "1" : "" });
    rangeLabel.textContent = `${fmtDate(state.start.toISOString())} – ${fmtDate(end.toISOString())}`;
    clear(body, spinner());
    let data;
    try {
      data = await api.get("/timeline", {
        start: iso(state.start), end: iso(end), project_id: state.project || undefined,
        user_id: state.person || undefined, include_done: state.done || undefined,
      });
    } catch (err) { clear(body, errorBox(err)); return; }

    if (!state.person) people = data.rows.map((r) => r.user);
    clear(personSel, h("option", { value: "" }, data.scope === "self" ? "Me" : "Everyone"),
      people.map((u) => h("option", { value: u.id, selected: String(u.id) === state.person }, u.name)));
    personSel.hidden = data.scope === "self";

    if (!data.rows.length) { clear(body, emptyState("Nobody to show", "No team members match these filters.")); return; }
    clear(body, grid(data, state.start, days, px));
    body.querySelector(".tl-today")?.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function grid(data, start, days, px) {
    const today = dayIndex(start, new Date());
    const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
    const width = days * px;
    const showDayNum = px >= 20;

    const monthsRow = h("div.tl-months", { style: { width: `${width}px` } });
    let i = 0;
    while (i < days) {
      const m = dates[i].getMonth();
      let j = i;
      while (j < days && dates[j].getMonth() === m) j += 1;
      monthsRow.append(h("span", { style: { left: `${i * px}px`, width: `${(j - i) * px}px` } },
        dates[i].toLocaleDateString(undefined, { month: "short", year: "numeric" })));
      i = j;
    }
    const daysRow = h("div.tl-days", { style: { width: `${width}px` } }, dates.map((d, k) => h(`span${[0, 6].includes(d.getDay()) ? ".we" : ""}${k === today ? ".is-today" : ""}`, {
      style: { left: `${k * px}px`, width: `${px}px` }, title: d.toDateString(),
    }, showDayNum ? [h("b", String(d.getDate())), px >= 30 ? h("i", d.toLocaleDateString(undefined, { weekday: "narrow" })) : null] : (d.getDay() === 1 ? h("b", String(d.getDate())) : ""))));

    // Weekend shading + today line, drawn once behind all rows.
    const backdrop = h("div.tl-backdrop", { style: { width: `${width}px` } },
      dates.map((d, k) => ([0, 6].includes(d.getDay()) ? h("span.we", { style: { left: `${k * px}px`, width: `${px}px` } }) : null)),
      today >= 0 && today < days ? h("span.tl-today", { style: { left: `${today * px + px / 2}px` } }) : null);

    const rows = data.rows.map((row) => {
      const items = lanes(row.tickets.map((t) => {
        const from = Math.max(0, dayIndex(start, parseDate(t.window_start)));
        const to = Math.min(days - 1, dayIndex(start, parseDate(t.window_end)));
        return { t, from, to, clippedL: dayIndex(start, parseDate(t.window_start)) < 0, clippedR: dayIndex(start, parseDate(t.window_end)) > days - 1 };
      }).filter((x) => x.to >= 0 && x.from <= days - 1));
      const laneCount = Math.max(1, ...items.map((x) => x.lane + 1));

      // Load per day (open tickets only) -> the strip under the bars highlights double-booked days.
      const load = new Array(days).fill(0);
      items.forEach(({ t, from, to }) => { if (!["done", "verified"].includes(t.status)) for (let k = from; k <= to; k += 1) load[k] += 1; });

      const bars = items.map(({ t, from, to, lane, clippedL, clippedR }) => {
        const finished = ["done", "verified"].includes(t.status);
        const classes = [`status-${t.status}`, t.overlaps.length && !finished ? "clash" : "", t.is_overdue ? "overdue" : "",
          t.start_planned ? "" : "est", finished ? "finished" : "", clippedL ? "cl" : "", clippedR ? "cr" : ""].filter(Boolean).join(" ");
        const tip = [`${t.key} ${t.title}`, `${label(t.status)} · ${label(t.priority)} priority`,
          `${t.start_planned ? "Start" : "From"} ${fmtDate(t.window_start)} → due ${fmtDate(t.window_end)}`,
          t.project.name, t.overlaps.length ? `Overlaps: ${t.overlaps.join(", ")}` : ""].filter(Boolean).join("\n");
        return h("a.tl-bar", {
          href: `#/tickets/${t.key}`, class: classes, title: tip,
          style: { left: `${from * px + 2}px`, width: `${(to - from + 1) * px - 4}px`, top: `${lane * 30 + 6}px` },
        }, h("span.tl-key", t.key), (to - from + 1) * px > 90 ? h("span.tl-title", t.title) : null);
      });
      const strip = h("div.tl-load", { style: { width: `${width}px` } },
        load.map((n, k) => (n > 1 ? h("span", { style: { left: `${k * px}px`, width: `${px}px` }, title: `${n} tickets on ${dates[k].toDateString()}` }) : null)));

      const person = h("div.tl-person",
        avatar(row.user, "sm"),
        h("div.grow", h("div.tl-name", row.user.name),
          h("div.small.muted",
            `${row.tickets.filter((t) => !["done", "verified"].includes(t.status)).length} planned`,
            row.overlap_count ? h("span.danger-text", ` · ${row.overlap_count} overlapping`) : null,
            row.unscheduled.length ? h("span", { title: row.unscheduled.map((t) => `${t.key} ${t.title}`).join("\n") }, ` · ${row.unscheduled.length} no due date`) : null)));
      return h("div.tl-row",
        person,
        h("div.tl-lane", { style: { width: `${width}px`, height: `${laneCount * 30 + 16}px` } }, bars, strip));
    });

    return h("div.card.flush.tl-card",
      h("div.tl-scroll",
        h("div.tl-head", h("div.tl-person.tl-corner", h("span.small.muted", data.scope === "all" ? "Everyone" : data.scope === "owned" ? "Your teams" : "You")),
          h("div.tl-scale", monthsRow, daysRow)),
        h("div.tl-rows", h("div.tl-backdrop-wrap", backdrop), rows)),
      h("div.tl-legend.small.muted",
        h("span", h("i.lg.clash"), "overlaps another ticket"),
        h("span", h("i.lg.load"), "day with 2+ tickets"),
        h("span", h("i.lg.est"), "no planned start (from assignment)"),
        h("span", h("i.lg.overdue"), "overdue")));
  }

  clear(main,
    !projectId && h("div.page-head", h("div", h("h1", "Timeline"),
      h("p.muted", "Planned work per person from start date to due date. Overlapping tickets are stacked and outlined."))),
    controls, body);
  await load();
}
