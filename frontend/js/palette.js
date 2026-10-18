// Command palette (⌘K / Ctrl+K, or "/") and global keyboard shortcuts ("?" lists them).
import { api, auth } from "./api.js";
import { icon } from "./icons.js";
import { getTheme, setTheme } from "./theme.js";
import { avatar, clear, h, modal } from "./ui.js";

let navItems = [];
let actions = {};
export function configurePalette({ nav, newTicket, changePassword, logout, navigate }) {
  navItems = nav;
  actions = { newTicket, changePassword, logout, navigate };
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";

let open = null;

export function openPalette(initial = "") {
  if (open) { open.input.focus(); return; }
  const input = h("input.pal-input", { type: "text", placeholder: "Search tickets, docs, projects, people - or type a command…", "aria-label": "Command palette", autocomplete: "off", spellcheck: false, value: initial });
  const list = h("div.pal-list", { role: "listbox" });
  const footer = h("div.pal-foot",
    h("span", h("kbd", "↑"), h("kbd", "↓"), " navigate"), h("span", h("kbd", "↵"), " open"), h("span", h("kbd", "esc"), " close"));
  const box = h("div.pal", { role: "dialog", "aria-modal": "true", "aria-label": "Command palette" },
    h("div.pal-search", icon("search", { size: 18 }), input), list, footer);
  const backdrop = h("div.pal-backdrop", { onmousedown: (e) => { if (e.target === backdrop) close(); } }, box);
  document.body.append(backdrop);

  let items = [];
  let active = 0;
  let seq = 0;
  let projectsCache = null;

  function close() { backdrop.remove(); open = null; document.removeEventListener("keydown", onKey, true); }
  function run(item) { close(); item.run(); }

  const staticItems = () => [
    ...navItems.map((n) => ({ group: "Go to", label: n.label, icon: n.icon, hint: n.keys, run: () => actions.navigate(n.href) })),
    { group: "Actions", label: "Create ticket", icon: "plus", hint: "C", run: () => actions.newTicket() },
    { group: "Actions", label: "New documentation page", icon: "docs", run: () => actions.navigate("/docs/new") },
    { group: "Actions", label: `Switch theme (now ${getTheme()})`, icon: getTheme() === "dark" ? "moon" : getTheme() === "light" ? "sun" : "monitor",
      run: () => setTheme({ system: "light", light: "dark", dark: "system" }[getTheme()]) },
    { group: "Actions", label: "Keyboard shortcuts", icon: "keyboard", hint: "?", run: () => showShortcuts() },
    { group: "Actions", label: "Change password", icon: "key", run: () => actions.changePassword() },
    { group: "Actions", label: "Log out", icon: "logout", run: () => actions.logout() },
  ];

  function draw() {
    if (!items.length) { clear(list, h("div.pal-empty", "No results")); return; }
    active = Math.min(active, items.length - 1);
    let lastGroup = null;
    clear(list, items.map((it, i) => {
      const head = it.group !== lastGroup ? h("div.pal-group", it.group) : null;
      lastGroup = it.group;
      return [head, h(`div.pal-item${i === active ? ".active" : ""}`, {
        role: "option", "aria-selected": String(i === active),
        onmousemove: () => { if (active !== i) { active = i; draw(); } },
        onmousedown: (e) => { e.preventDefault(); run(it); },
      },
      it.avatar ? avatar(it.avatar, "sm") : icon(it.icon || "arrow", { size: 16 }),
      h("span.pal-label", it.label), it.sub ? h("span.pal-sub", it.sub) : null,
      it.hint ? h("span.pal-hint", String(it.hint).split(" ").map((k) => h("kbd", k))) : null)];
    }));
    list.querySelector(".pal-item.active")?.scrollIntoView({ block: "nearest" });
  }

  async function search() {
    const q = input.value.trim();
    const mine = ++seq;
    const lower = q.toLowerCase();
    const base = staticItems().filter((it) => !q || it.label.toLowerCase().includes(lower));
    items = q && KEY_RE.test(q)
      ? [{ group: "Tickets", label: `Open ${q.toUpperCase()}`, icon: "tickets", run: () => actions.navigate(`/tickets/${q.toUpperCase()}`) }, ...base]
      : base;
    draw();
    if (q.length < 2) return;
    try {
      projectsCache = projectsCache || await api.get("/projects");
      const [tickets, docs, people] = await Promise.all([
        api.get("/tickets", { q, limit: 6, sort: "updated_at" }),
        api.get("/docs", { q }).catch(() => []),
        api.get("/users/lookup", { q, limit: 4 }).catch(() => []),
      ]);
      if (mine !== seq) return;
      const found = [
        ...tickets.items.map((t) => ({ group: "Tickets", label: t.title, sub: t.key, icon: "tickets", run: () => actions.navigate(`/tickets/${t.key}`) })),
        ...projectsCache.filter((p) => p.name.toLowerCase().includes(lower) || p.key.toLowerCase() === lower)
          .slice(0, 4).map((p) => ({ group: "Projects", label: p.name, sub: p.key, icon: "folder", run: () => actions.navigate(`/projects/${p.id}`) })),
        ...docs.slice(0, 5).map((d) => ({ group: "Docs", label: d.title, sub: d.project.key, icon: "docs", run: () => actions.navigate(`/docs/${d.id}`) })),
        ...people.map((u) => ({ group: "People", label: u.name, sub: u.email, avatar: u,
          run: () => actions.navigate(`/tickets?assignee=${u.id}`) })),
      ];
      items = [...items.filter((it) => it.group === "Tickets" && it.label.startsWith("Open ")), ...found,
        ...base];
      draw();
    } catch { /* keep the static results */ }
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % Math.max(1, items.length); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % Math.max(1, items.length); draw(); }
    else if (e.key === "Enter" && items[active]) { e.preventDefault(); run(items[active]); }
  }
  let timer;
  input.addEventListener("input", () => { active = 0; clearTimeout(timer); timer = setTimeout(search, 140); });
  document.addEventListener("keydown", onKey, true);
  open = { input };
  search();
  setTimeout(() => input.focus(), 0);
}

// ----------------------------------------------------------------------------- shortcuts
const SHORTCUTS = [
  ["Search / command palette", `${MOD} K`, "/"],
  ["Create a ticket", "C"],
  ["Go to dashboard", "G D"], ["Go to tickets", "G T"], ["Go to projects", "G P"], ["Go to timeline", "G L"],
  ["Go to docs", "G O"], ["Go to releases", "G R"], ["Go to upcoming", "G U"], ["Go to notifications", "G N"], ["Go to chat", "G M"],
  ["Chat: previous / next conversation", "Alt ↑", "Alt ↓"], ["Chat: edit your last message", "↑"],
  ["Show this help", "?"],
  ["Bold / italic / link in editors", `${MOD} B`, `${MOD} I`, `${MOD} K`],
  ["Save a doc page", `${MOD} S`],
];

export function showShortcuts() {
  modal("Keyboard shortcuts", h("div.shortcuts", SHORTCUTS.map(([what, ...keys]) => h("div.shortcut-row",
    h("span", what), h("span.shortcut-keys", keys.map((k, i) => [i ? h("span.muted.small", " or ") : null, ...k.split(" ").map((x) => h("kbd", x))]))))));
}

const GOTO = { d: "/", t: "/tickets", p: "/projects", l: "/timeline", o: "/docs", r: "/releases", u: "/upcoming", n: "/notifications", m: "/chat" };
let pendingG = 0;

function typing(e) {
  const el = e.target;
  return el.closest?.("input, textarea, select, [contenteditable='true']") || document.querySelector(".backdrop, .pal-backdrop");
}

export function installShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (!auth.user) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.target.closest?.("textarea")) {
      e.preventDefault(); openPalette(); return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
    if (e.key === "/") { e.preventDefault(); openPalette(); return; }
    if (e.key === "?") { e.preventDefault(); showShortcuts(); return; }
    if (e.key === "c" || e.key === "C") { e.preventDefault(); actions.newTicket?.(); return; }
    if (e.key === "g" || e.key === "G") { pendingG = Date.now(); return; }
    if (pendingG && Date.now() - pendingG < 1200 && GOTO[e.key.toLowerCase()]) {
      e.preventDefault(); pendingG = 0; actions.navigate(GOTO[e.key.toLowerCase()]);
    }
  });
}
