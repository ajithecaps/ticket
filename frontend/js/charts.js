// Small SVG charts for the dashboard: a two-series line chart with crosshair + tooltip, sparklines,
// stacked horizontal bars. Colors come from CSS custom properties (--series-1/2, --st-*), so light and
// dark mode each use their own validated steps.
import { h } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => v !== null && v !== undefined && el.setAttribute(k, v));
  kids.flat().forEach((k) => k && el.append(k));
  return el;
};

/** Clean axis ticks: 0..max in 3-5 round steps. */
function niceTicks(max) {
  if (max <= 4) return Array.from({ length: Math.max(1, max) + 1 }, (_, i) => i);
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(2));
}
const compact = (n) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}K` : String(n));

// One shared tooltip element for every chart on the page.
let tipEl = null;
export function tooltip() {
  if (!tipEl) {
    tipEl = h("div.chart-tip", { role: "tooltip", hidden: true });
    document.body.append(tipEl);
  }
  return {
    show(ev, content) {
      tipEl.replaceChildren(...[content].flat());
      tipEl.hidden = false;
      const w = tipEl.offsetWidth;
      const hgt = tipEl.offsetHeight;
      const x = ev.clientX + 14 + w > innerWidth ? ev.clientX - w - 14 : ev.clientX + 14;
      tipEl.style.left = `${Math.max(8, x)}px`;
      tipEl.style.top = `${Math.max(8, Math.min(innerHeight - hgt - 8, ev.clientY - hgt / 2))}px`;
    },
    hide() { tipEl.hidden = true; },
  };
}

/**
 * Line chart. series: [{name, color: "var(--series-1)", values: [n]}]; labels: ["2026-10-01", ...].
 * Single y-axis, 2px lines, a light area wash under the first series, hover crosshair + tooltip.
 */
export function lineChart({ series, labels, height = 220, formatLabel = (l) => l }) {
  const W = 640;
  const H = height;
  const pad = { l: 34, r: 12, t: 12, b: 26 };
  const n = labels.length;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const x = (i) => pad.l + (n === 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (1 - v / top) * (H - pad.t - pad.b);

  const grid = ticks.map((t) => svg("g", {},
    svg("line", { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: "c-grid" }),
    svg("text", { x: pad.l - 6, y: y(t) + 3.5, class: "c-axis", "text-anchor": "end" }, compact(t))));
  const every = Math.max(1, Math.ceil(n / 7));
  const xlabels = labels.map((l, i) => (i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every / 2)
    ? svg("text", { x: x(i), y: H - 8, class: "c-axis", "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }, formatLabel(l))
    : null);

  const path = (vals) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const lines = series.map((s, si) => svg("g", {},
    si === 0 ? svg("path", { d: `${path(s.values)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`, class: "c-area", style: `fill:${s.color}` }) : null,
    svg("path", { d: path(s.values), class: "c-line", style: `stroke:${s.color}` }),
    svg("circle", { cx: x(n - 1), cy: y(s.values[n - 1]), r: 4, class: "c-dot", style: `fill:${s.color}` })));

  const cross = svg("line", { y1: pad.t, y2: H - pad.b, class: "c-cross", visibility: "hidden" });
  const hoverDots = series.map((s) => svg("circle", { r: 4.5, class: "c-dot", style: `fill:${s.color}`, visibility: "hidden" }));
  const tip = tooltip();
  const hit = svg("rect", { x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b, class: "c-hit" });
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "c-svg", role: "img",
    "aria-label": `${series.map((s) => s.name).join(" and ")} over ${n} days` }, grid, xlabels, lines, cross, hoverDots, hit);

  hit.addEventListener("mousemove", (ev) => {
    const box = root.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    hoverDots.forEach((d, si) => { d.setAttribute("cx", x(i)); d.setAttribute("cy", y(series[si].values[i])); d.setAttribute("visibility", "visible"); });
    tip.show(ev, [h("div.chart-tip-head", formatLabel(labels[i], true)),
      ...series.map((s) => h("div.chart-tip-row", h("i", { style: { background: s.color } }), h("span", s.name), h("strong", String(s.values[i]))))]);
  });
  hit.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    hoverDots.forEach((d) => d.setAttribute("visibility", "hidden"));
    tip.hide();
  });

  const legend = series.length > 1 && h("div.c-legend", series.map((s) => h("span", h("i", { style: { background: s.color } }), s.name)));
  return h("div.chart", legend, root);
}

/** Tiny trend line for a stat tile (no axes); last point emphasised. */
export function sparkline(values, { color = "var(--series-1)" } = {}) {
  const W = 96;
  const H = 28;
  const n = values.length;
  if (n < 2) return null;
  const max = Math.max(1, ...values);
  const x = (i) => 2 + (i / (n - 1)) * (W - 4);
  const y = (v) => 3 + (1 - v / max) * (H - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "c-spark", "aria-hidden": "true" },
    svg("path", { d, class: "c-spark-line" }),
    svg("circle", { cx: x(n - 1), cy: y(values[n - 1]), r: 2.5, style: `fill:${color}` }));
}

/**
 * Stacked horizontal bars, one row per item. rows: [{label: Node|string, segments: [{key, value}], href, extra}];
 * keys: [{key, name, color}] in stacking order. Width is relative to the largest total.
 */
export function stackedBars({ rows, keys, unit = "tickets" }) {
  const max = Math.max(1, ...rows.map((r) => r.segments.reduce((a, s) => a + s.value, 0)));
  const tip = tooltip();
  const color = Object.fromEntries(keys.map((k) => [k.key, k]));
  return h("div.c-bars",
    h("div.c-legend", keys.map((k) => h("span", h("i", { style: { background: k.color } }), k.name))),
    rows.map((r) => {
      const total = r.segments.reduce((a, s) => a + s.value, 0);
      return h("div.c-bar-row",
        h("div.c-bar-label", r.label),
        h("div.c-bar-track",
          h("div.c-bar", { style: { width: `${(total / max) * 100}%` } },
            r.segments.filter((s) => s.value).map((s) => h("span.c-seg", {
              style: { flex: String(s.value), background: color[s.key].color },
              onmousemove: (ev) => tip.show(ev, [h("div.chart-tip-head", r.name || ""),
                h("div.chart-tip-row", h("i", { style: { background: color[s.key].color } }), h("span", color[s.key].name), h("strong", String(s.value)))]),
              onmouseleave: () => tip.hide(),
            }))),
          h("span.c-bar-value", total ? `${total}` : "—")),
        r.extra ? h("div.c-bar-extra", r.extra) : null);
    }));
}
