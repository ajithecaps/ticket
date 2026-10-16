// "Is this person already busy then?" - shared by every place a ticket gets an assignee.
import { api } from "./api.js";
import { fmtDate, h, modal, statusBadge } from "./ui.js";

/** Open tickets of `user` overlapping start..end (end = due date). null when there is no due date. */
export async function fetchOverlaps(user, { start, end, excludeId } = {}) {
  if (!user || !end) return null;
  try {
    return await api.get("/timeline/overlaps", {
      user_id: user.id, end, start: start || undefined, exclude_ticket_id: excludeId || undefined,
    });
  } catch {
    return null; // not allowed to look (e.g. a developer) or offline: never block the action
  }
}

const count = (ov) => (ov ? ov.tickets.length + ov.hidden_count : 0);

/** Warning box listing the clashes, or null when there are none. */
export function overlapNote(ov, { compact = false } = {}) {
  if (!count(ov)) return null;
  const first = ov.user.name.split(/\s+/)[0];
  return h(`div.overlap-note${compact ? ".compact" : ""}`, { role: "status" },
    h("strong", `⚠ ${first} already has ${count(ov)} ticket${count(ov) > 1 ? "s" : ""} in these days`),
    h("ul", ov.tickets.slice(0, compact ? 3 : 8).map((t) => h("li",
      h("a", { href: `#/tickets/${t.key}`, target: compact ? null : "_blank" }, h("span.key", t.key)), " ",
      h("span", t.title), " ", h("span.muted.small", `${fmtDate(t.window_start)} – ${fmtDate(t.window_end)}`), " ",
      statusBadge(t.status))),
    ov.tickets.length > (compact ? 3 : 8) ? h("li.muted.small", `…and ${ov.tickets.length - (compact ? 3 : 8)} more`) : null,
    ov.hidden_count ? h("li.muted.small", `+${ov.hidden_count} in project${ov.hidden_count > 1 ? "s" : ""} you can't see`) : null));
}

const pad = (n) => String(n).padStart(2, "0");
/** Timeline link for this person, opened on the week the clash starts. */
function timelineHref(ov) {
  const d = new Date(ov.start);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `#/timeline?person=${ov.user.id}&from=${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

/** One line: "⚠ 2 overlapping tickets · View" - View opens the list (and a link to the timeline). */
export function overlapCount(ov) {
  const n = count(ov);
  if (!n) return null;
  const open = () => {
    const m = modal(`${ov.user.name}: overlapping tickets`, [
      h("p.muted", `${fmtDate(ov.start)} → ${fmtDate(ov.end)}`),
      overlapNote(ov),
      h("div.form-actions",
        h("a.btn", { href: timelineHref(ov), onclick: () => m.close() }, "Open in timeline"),
        h("button.btn.primary", { onclick: () => m.close() }, "Close")),
    ], { wide: true });
  };
  return h("div.overlap-count", { role: "status" },
    h("span", { title: `${n} other ticket${n > 1 ? "s" : ""} assigned to ${ov.user.name} in the same days` }, "⚠ ", h("strong", String(n)), " overlapping"),
    h("button.link.small", { type: "button", onclick: open }, "View"));
}

/** Before assigning: if the person is busy then, ask. Resolves true to go ahead. */
export async function confirmIfOverlapping(user, opts) {
  const ov = await fetchOverlaps(user, opts);
  if (!count(ov)) return true;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const m = modal(`Assign to ${user.name}?`, [
      h("p.muted", `This ticket runs ${opts.start ? fmtDate(opts.start) : "from now"} → ${fmtDate(opts.end)}.`),
      overlapNote(ov),
      h("div.form-actions",
        h("button.btn", { onclick: () => finish(false) }, "Pick someone else"),
        h("button.btn.primary", { onclick: () => finish(true) }, "Assign anyway")),
    ], { wide: true });
    const watch = new MutationObserver(() => { if (!m.dialog.isConnected) { watch.disconnect(); finish(false); } });
    watch.observe(document.body, { childList: true });
  });
}
