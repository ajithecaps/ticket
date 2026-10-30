// The personal coach: a small agent that picks your next task (and says why), tracks the daily goal
// and streak, nudges about stuck work and cheers when you finish something. Lives in the top bar
// (progress ring + side panel), on the dashboard, and says hello once a day.
import { api, auth } from "../api.js";
import { icon } from "../icons.js";
import { navigate } from "../app.js";
import { busy, clear, h, priorityBadge, statusBadge, toast } from "../ui.js";

export const COACH_TONES = [
  { id: "cheerful", name: "Cheerful", emoji: "😄", sample: "Two down, one to go - you're on a roll!" },
  { id: "calm", name: "Calm", emoji: "🌿", sample: "One thing at a time. Begin with PAY-4." },
  { id: "coach", name: "Tough coach", emoji: "💪", sample: "Zero done. Change that - PAY-4, now." },
  { id: "witty", name: "Witty", emoji: "😏", sample: "PAY-4 won't close itself. (We checked.)" },
];
const ACTION = { start: "Start it", continue: "Keep going", unblock: "See what's blocking", follow_up: "Nudge the reviewer" };

let data = null;
let button = null;
let panel = null;
const listeners = new Set();

const today = () => new Date().toLocaleDateString("en-CA");
const storeKey = (what) => `grandesk.coach.${what}.${auth.user?.id}`;
function skipped() {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey("skip")) || "{}");
    return v.day === today() ? v.ids : [];
  } catch { return []; }
}
function skip(id) {
  try { localStorage.setItem(storeKey("skip"), JSON.stringify({ day: today(), ids: [...skipped(), id] })); } catch { /* per-viewer only */ }
}

/** The queue without what you put off today (unless that's everything). */
function queue() {
  if (!data) return [];
  const off = skipped();
  const rest = data.queue.filter((q) => !off.includes(q.ticket.id));
  return rest.length ? rest : data.queue;
}

export async function refreshCoach() {
  try { data = await api.get("/coach"); } catch { return null; }
  paintButton();
  if (panel?.isConnected) paintPanel();
  listeners.forEach((fn) => fn(data));
  return data;
}

// ----------------------------------------------------------------------------- top bar
function ring(done, goal, size = 30) {
  const r = size / 2 - 3, c = 2 * Math.PI * r, pct = Math.min(done / goal, 1);
  const svg = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-bg"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fg" stroke-dasharray="${c * pct} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  const el = h("span.coach-ring");
  el.innerHTML = svg;
  return el;
}

export function coachButton() {
  button = h("button.icon-btn.coach-btn", { type: "button", hidden: true, onclick: () => openPanel() });
  refreshCoach().then(() => greetOncePerDay());
  return button;
}

function paintButton() {
  if (!button) return;
  button.hidden = !data?.enabled;
  if (!data?.enabled) return;
  const { done_today: done, goal } = data.stats;
  button.title = `${data.name}: ${done} of ${goal} done today`;
  button.setAttribute("aria-label", button.title);
  button.classList.toggle("goal-met", done >= goal);
  clear(button, ring(done, goal), h("span.coach-btn-ic", icon("sparkles", { size: 14 })));
}

// ----------------------------------------------------------------------------- side panel
export function openPanel() {
  if (!data?.enabled) { navigate("/profile"); return; }
  if (panel?.isConnected) { closePanel(); return; }
  panel = h("aside.coach-panel", { role: "dialog", "aria-label": `${data.name}, your coach` });
  const scrim = h("div.coach-scrim", { onclick: closePanel });
  document.body.append(scrim, panel);
  const onKey = (e) => { if (e.key === "Escape") closePanel(); };
  document.addEventListener("keydown", onKey);
  panel._cleanup = () => { scrim.remove(); document.removeEventListener("keydown", onKey); };
  paintPanel();
  requestAnimationFrame(() => panel.classList.add("open"));
  refreshCoach();
}

function closePanel() {
  if (!panel) return;
  panel._cleanup?.();
  panel.remove();
  panel = null;
}

function orb(big = false) { return h(`span.coach-orb${big ? ".big" : ""}`, icon("sparkles", { size: big ? 22 : 16 })); }

function nextCard(item, { compact = false, onChange } = {}) {
  const t = item.ticket;
  async function act() {
    if (item.action === "start") {
      await busy(null, async () => {
        await api.post(`/tickets/${t.id}/status`, { status: "in_progress" });
        toast(`${t.key} started - go get it!`);
        await refreshCoach();
        onChange?.();
      });
    } else navigate(`/tickets/${t.key}`);
    if (item.action !== "start") closePanel();
  }
  return h("div.coach-next",
    h("div.row.between.wrap",
      h("a.key", { href: `#/tickets/${t.key}`, onclick: closePanel }, t.key),
      h("div.row", priorityBadge(t.priority), statusBadge(t.status))),
    h("a.coach-next-title", { href: `#/tickets/${t.key}`, onclick: closePanel }, t.title),
    h("ul.coach-reasons", item.reasons.map((r) => h("li", r))),
    !compact && h("div.row.wrap.coach-actions",
      h("button.btn.primary.sm", { type: "button", onclick: act }, item.action === "start" ? icon("play", { size: 13 }) : null, ACTION[item.action]),
      h("button.btn.ghost.sm", { type: "button", onclick: () => { skip(t.id); onChange ? onChange() : paintPanel(); } }, "Not now")));
}

function statsRow(s) {
  return h("div.coach-stats",
    h("div.coach-goal", ring(s.done_today, s.goal, 52),
      h("div", h("strong", `${s.done_today} / ${s.goal}`), h("span.muted.small", s.done_today >= s.goal ? "goal reached!" : "done today"))),
    h("div.coach-stat", h("strong", s.streak ? `${s.streak} 🔥` : "0"), h("span.muted.small", "day streak")),
    h("div.coach-stat", h("strong", String(s.done_week)), h("span.muted.small", "this week")));
}

function paintPanel() {
  if (!panel || !data) return;
  const [first, ...rest] = queue();
  clear(panel,
    h("div.coach-head",
      orb(true),
      h("div.grow", h("strong", data.name), h("span.muted.small", "your coach")),
      h("button.icon-btn", { type: "button", "aria-label": "Close", onclick: closePanel }, icon("x", { size: 18 }))),
    h("div.coach-body",
      h("h3.coach-greeting", data.greeting),
      h("p.coach-bubble", data.message),
      statsRow(data.stats),
      first ? [h("h4.coach-sub", "Next up"), nextCard(first, { onChange: paintPanel })] : null,
      rest.length ? [h("h4.coach-sub", "Then"), h("ul.coach-then", rest.slice(0, 3).map((q) => h("li",
        h("a", { href: `#/tickets/${q.ticket.key}`, onclick: closePanel }, h("span.key", q.ticket.key), h("span.ellipsis", q.ticket.title)),
        h("span.muted.small", q.reasons[0]))))] : null,
      data.nudges.length ? [h("h4.coach-sub", "Heads-up"), h("ul.coach-nudges", data.nudges.map((n) => h(`li.nudge-${n.kind}`,
        n.key ? h("a", { href: `#/tickets/${n.key}`, onclick: closePanel }, n.text) : n.text)))] : null),
    h("div.coach-foot", h("a", { href: "#/profile", onclick: closePanel }, icon("settings", { size: 14 }), "Coach settings")));
}

// ----------------------------------------------------------------------------- dashboard card
export function coachCard() {
  const card = h("section.card.coach-card", { hidden: true });
  const paint = (d) => {
    card.hidden = !d?.enabled;
    if (!d?.enabled) return;
    const first = queue()[0];
    clear(card,
      h("div.coach-card-main",
        orb(true),
        h("div.grow",
          h("div.row.wrap", h("strong", `${d.greeting}!`), h("span.muted.small", `- ${d.name}, your coach`)),
          h("p.coach-card-msg", d.message))),
      statsRow(d.stats),
      first && h("div.coach-card-next", h("span.coach-sub-inline", "Next up"), nextCard(first, { onChange: () => paint(data) })),
      h("button.btn.ghost.sm.coach-card-more", { type: "button", onclick: () => openPanel() }, "Open coach"));
  };
  listeners.add(paint);
  if (data) paint(data);
  refreshCoach();
  card._cleanup = () => listeners.delete(paint);
  return card;
}

// ----------------------------------------------------------------------------- hello & cheers
function greetOncePerDay() {
  if (!data?.enabled || !button) return;
  try {
    if (localStorage.getItem(storeKey("greeted")) === today()) return;
    localStorage.setItem(storeKey("greeted"), today());
  } catch { return; }
  const first = queue()[0];
  bubble([
    h("strong", `${data.greeting}! ✨`),
    h("p", data.message),
    first && h("button.btn.primary.sm", { type: "button", onclick: (e) => { e.target.closest(".coach-pop").remove(); openPanel(); } }, `Plan my day with ${data.name}`),
  ], 12000);
}

function bubble(children, ms = 6000, cls = "") {
  document.querySelectorAll(".coach-pop").forEach((el) => el.remove());
  const el = h(`div.coach-pop${cls}`, { role: "status" },
    orb(),
    h("div.coach-pop-body", children),
    h("button.icon-btn.sm", { type: "button", "aria-label": "Dismiss", onclick: () => el.remove() }, icon("x", { size: 14 })));
  document.body.append(el);
  setTimeout(() => el.classList.add("leaving"), ms);
  setTimeout(() => el.remove(), ms + 400);
}

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const host = h("div.confetti", { "aria-hidden": "true" });
  const colors = ["#6366f1", "#12b76a", "#f79009", "#ee46bc", "#2e90fa"];
  for (let i = 0; i < 36; i++) {
    host.append(h("i", { style: {
      left: `${50 + (Math.random() - 0.5) * 30}%`, background: colors[i % colors.length],
      "--dx": `${(Math.random() - 0.5) * 520}px`, "--dy": `${-180 - Math.random() * 260}px`, "--r": `${Math.random() * 720}deg`,
      animationDelay: `${Math.random() * 120}ms`,
    } }));
  }
  document.body.append(host);
  setTimeout(() => host.remove(), 1800);
}

/** Call after a status change: when you just finished one of your own tickets, the coach celebrates. */
export async function cheerIfMine(ticket, status) {
  if (status !== "done" || !auth.user || !(ticket.assignees || []).some((u) => u.id === auth.user.id)) return;
  let d;
  try { d = await api.get("/coach", { event: "done", key: ticket.key }); } catch { return; }
  data = d;
  paintButton();
  listeners.forEach((fn) => fn(d));
  if (!d.enabled || !d.cheer) return;
  confetti();
  const next = queue()[0];
  bubble([
    h("strong", d.cheer),
    d.stats.streak > 1 ? h("p", `🔥 ${d.stats.streak}-day streak`) : null,
    next && h("p.small", "Next: ", h("a", { href: `#/tickets/${next.ticket.key}` }, `${next.ticket.key} ${next.ticket.title}`)),
  ], 7000, ".cheer");
}
