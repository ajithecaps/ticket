// DOM helpers, formatting and shared widgets. No framework: views build elements with h().

export const STATUSES = ["todo", "in_progress", "blocked", "in_review", "done", "verified"];
// "done" = finished by the developer; "verified" = cross-checked and closed by a project owner.
export const CLOSED = ["done", "verified"];
export const PRIORITIES = ["low", "medium", "high", "critical"];
export const TYPES = ["task", "bug", "feature", "improvement"];

export const LABELS = {
  todo: "To do", in_progress: "In progress", blocked: "Blocked", in_review: "In review", done: "Done", verified: "Verified",
  low: "Low", medium: "Medium", high: "High", critical: "Critical",
  task: "Task", bug: "Bug", feature: "Feature", improvement: "Improvement",
  owner: "Owner", developer: "Developer", admin: "Admin", user: "User",
};
export const label = (v) => LABELS[v] || v;

/**
 * h("div.card#main", {onclick, class, dataset, ...}, ...children)
 * Children may be strings, nodes, arrays, or null/false (skipped). Text is never parsed as HTML.
 */
export function h(tag, attrs, ...children) {
  if (attrs === null || typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [, name = "div", rest = ""] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || "div");
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === ".") el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "class") String(value).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "style" && typeof value === "object") {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith("--")) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ----------------------------------------------------------------------------- formatting
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

// The API returns UTC timestamps; naive ones (from SQLite) lack the "Z", so add it.
export function parseDate(value) {
  if (!value) return null;
  value = String(value).replace(" ", "T");
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const fmtDate = (v) => { const d = parseDate(v); return d ? dateFmt.format(d) : "—"; };
export const fmtDateTime = (v) => { const d = parseDate(v); return d ? dateTimeFmt.format(d) : "—"; };

export function timeAgo(value) {
  const d = parseDate(value);
  if (!d) return "—";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return "just now";
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, secs] of units) {
    const n = Math.floor(Math.abs(s) / secs);
    if (n >= 1) return s >= 0 ? `${n} ${unit}${n > 1 ? "s" : ""} ago` : `in ${n} ${unit}${n > 1 ? "s" : ""}`;
  }
  return "just now";
}

/** "2026-10-14" (local) for <input type=date> from an API timestamp. */
export function toDateInput(value) {
  const d = parseDate(value);
  if (!d) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Due dates are entered as a day; store end of that local day so "due today" is not overdue at 00:00. */
export function fromDateInput(value) {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59).toISOString();
}

/** Start dates are a day too; store the start of that local day. */
export function fromStartInput(value) {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0).toISOString();
}

export const fmtPct = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
export const fmtHours = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 10) / 10}h`);
export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ----------------------------------------------------------------------------- small widgets
export const statusBadge = (s) => h(`span.badge.status-${s}`, label(s));
export const priorityBadge = (p) => h(`span.prio.prio-${p}`, { title: `${label(p)} priority` }, h("i"), label(p));
export const typeBadge = (t) => h(`span.type.type-${t}`, label(t));

export function avatar(user, size = "") {
  if (!user) return h(`span.avatar.unassigned${size ? "." + size : ""}`, { title: "Unassigned" }, "?");
  const initials = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  let hash = 0;
  for (const c of user.email || user.name) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return h(`span.avatar${size ? "." + size : ""}`, { title: user.name, style: { "--hue": hash } }, initials);
}

export const userChip = (user) =>
  user ? h("span.user-chip", avatar(user, "sm"), h("span", user.name)) : h("span.muted", "Unassigned");

export function spinner() {
  return h("div.loading", h("span.spin"), "Loading…");
}

export function emptyState(title, text, action) {
  return h("div.empty", h("strong", title), text && h("p", text), action);
}

export function errorBox(err) {
  return h("div.alert.error", err.message || String(err));
}

// ----------------------------------------------------------------------------- clipboard
/**
 * Copy text to the clipboard. navigator.clipboard only exists on https/localhost and can still be
 * refused, so fall back to execCommand (works on plain-http LAN addresses), and finally show the text
 * pre-selected so the user can copy it by hand.
 */
export async function copyText(text, message = "Copied") {
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error("clipboard API unavailable");
    await navigator.clipboard.writeText(text);
    toast(message);
    return;
  } catch { /* fall through */ }

  const ta = h("textarea", { readonly: true, style: { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0" } }, text);
  document.body.append(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  if (ok) { toast(message); return; }

  const input = h("input", { value: text, readonly: true, "aria-label": "Text to copy", onfocus: (e) => e.target.select() });
  modal("Copy", [h("p.muted", "Press Ctrl/⌘ + C to copy."), input]);
  setTimeout(() => input.select(), 0);
}

// ----------------------------------------------------------------------------- markdown
let purifyHooked = false;

/** Render Markdown (GFM) to sanitised HTML inside a .markdown element. */
export function renderMarkdown(text) {
  const el = h("div.markdown");
  if (!text || !text.trim()) return el;
  if (!window.marked || !window.DOMPurify) {
    el.classList.add("plain");
    el.textContent = text;
    return el;
  }
  if (!purifyHooked) {
    window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
    });
    purifyHooked = true;
  }
  const html = window.marked.parse(text, { gfm: true, breaks: true });
  el.innerHTML = window.DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "button", "textarea", "select"], ADD_ATTR: ["target"] });
  // GFM task lists come out as <input type=checkbox disabled>; draw them as read-only glyphs instead.
  el.querySelectorAll("input").forEach((input) => {
    if (input.type !== "checkbox") { input.remove(); return; }
    const li = input.closest("li");
    li?.classList.add("task-item");
    li?.parentElement?.classList.add("task-list");
    input.replaceWith(h(`span.task-box${input.checked ? ".checked" : ""}`, input.checked ? "✓" : ""));
  });
  return el;
}

const MD_ACTIONS = [
  ["B", "Bold (Ctrl/⌘+B)", { wrap: "**", placeholder: "bold text" }, "b"],
  ["I", "Italic (Ctrl/⌘+I)", { wrap: "_", placeholder: "italic text" }, "i"],
  ["S", "Strikethrough", { wrap: "~~", placeholder: "text" }],
  ["H", "Heading", { line: "### " }],
  ["<>", "Inline code", { wrap: "`", placeholder: "code" }],
  ["{ }", "Code block", { block: "```\n", end: "\n```", placeholder: "code" }],
  ["❝", "Quote", { line: "> " }],
  ["•", "Bulleted list", { line: "- " }],
  ["1.", "Numbered list", { line: "1. " }],
  ["☐", "Checklist", { line: "- [ ] " }],
  ["🔗", "Link (Ctrl/⌘+K)", { link: true }, "k"],
];

/**
 * YouTrack-style Markdown editor: toolbar + Write / Preview tabs.
 * Returns {el, textarea, get value(), set value(v), focus()}.
 */
export function markdownEditor({ value = "", placeholder = "", rows = 8, label: aria = "Text", autofocus = false } = {}) {
  const ta = h("textarea.md-input", { rows, placeholder, "aria-label": aria, maxLength: 20000 }, value);
  const preview = h("div.md-preview", { hidden: true });
  const writeTab = h("button.active", { type: "button", "aria-pressed": "true", onclick: () => show(false) }, "Write");
  const previewTab = h("button", { type: "button", "aria-pressed": "false", onclick: () => show(true) }, "Preview");

  function show(isPreview) {
    writeTab.classList.toggle("active", !isPreview);
    previewTab.classList.toggle("active", isPreview);
    writeTab.setAttribute("aria-pressed", String(!isPreview));
    previewTab.setAttribute("aria-pressed", String(isPreview));
    toolbar.hidden = isPreview;
    ta.hidden = isPreview;
    preview.hidden = !isPreview;
    if (isPreview) {
      clear(preview, ta.value.trim() ? renderMarkdown(ta.value) : h("p.muted", "Nothing to preview."));
    } else ta.focus();
  }

  function apply(action) {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const selected = v.slice(s, e);
    let insert; let selStart; let selEnd;
    if (action.wrap) {
      const text = selected || action.placeholder;
      insert = action.wrap + text + action.wrap;
      selStart = s + action.wrap.length; selEnd = selStart + text.length;
    } else if (action.block) {
      const text = selected || action.placeholder;
      const lead = s > 0 && v[s - 1] !== "\n" ? "\n" : "";
      insert = lead + action.block + text + action.end + "\n";
      selStart = s + lead.length + action.block.length; selEnd = selStart + text.length;
    } else if (action.line) {
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      const block = v.slice(lineStart, e) || "";
      const lines = block.split("\n").map((l, i) => (action.line === "1. " ? `${i + 1}. ` : action.line) + l);
      ta.setRangeText(lines.join("\n"), lineStart, e, "end");
      ta.dispatchEvent(new Event("input"));
      ta.focus();
      return;
    } else if (action.link) {
      const text = selected || "link text";
      insert = `[${text}](https://)`;
      selStart = s + text.length + 3; selEnd = selStart + 8;
    }
    ta.setRangeText(insert, s, e, "end");
    ta.setSelectionRange(selStart, selEnd);
    ta.dispatchEvent(new Event("input"));
    ta.focus();
  }

  const toolbar = h("div.md-toolbar", { role: "toolbar", "aria-label": "Formatting" },
    MD_ACTIONS.map(([text, title, action]) => h("button", { type: "button", title, "aria-label": title, onmousedown: (e) => e.preventDefault(), onclick: () => apply(action) }, text)),
    h("a.md-help", { href: "https://www.markdownguide.org/cheat-sheet/", target: "_blank", rel: "noopener", title: "Markdown help" }, "Markdown supported"));

  ta.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    const hit = MD_ACTIONS.find((a) => a[3] === e.key.toLowerCase());
    if (hit) { e.preventDefault(); apply(hit[2]); }
  });
  // Continue lists on Enter, like most Markdown editors.
  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.defaultPrevented) return;
    const s = ta.selectionStart;
    const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
    const line = ta.value.slice(lineStart, s);
    const m = line.match(/^(\s*)([-*] \[[ xX]\] |[-*] |(\d+)\. )/);
    if (!m) return;
    e.preventDefault();
    if (line.trim() === m[2].trim()) { ta.setRangeText("", lineStart, s, "end"); return; } // empty item ends the list
    const next = m[3] ? `${m[1]}${Number(m[3]) + 1}. ` : m[1] + m[2].replace(/\[[xX]\]/, "[ ]");
    ta.setRangeText("\n" + next, s, ta.selectionEnd, "end");
  });

  const el = h("div.md-editor",
    h("div.md-head", h("div.md-tabs", writeTab, previewTab), toolbar),
    h("div.md-body", ta, preview));
  if (autofocus) setTimeout(() => ta.focus(), 0);
  return {
    el, textarea: ta,
    get value() { return ta.value; },
    set value(v) { ta.value = v; show(false); },
    focus: () => ta.focus(),
    showWrite: () => show(false),
  };
}

// ----------------------------------------------------------------------------- toasts
export function toast(message, kind = "ok") {
  const el = h(`div.toast.${kind}`, { role: kind === "error" ? "alert" : "status" }, message);
  document.getElementById("toasts").append(el);
  setTimeout(() => el.classList.add("out"), 3500);
  setTimeout(() => el.remove(), 4000);
}

/** Run an async action from a button; disables it and reports errors as toasts. */
export async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message || String(err), "error");
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// ----------------------------------------------------------------------------- modal
export function modal(title, body, { wide = false } = {}) {
  const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const dialog = h(`div.modal${wide ? ".wide" : ""}`, { role: "dialog", "aria-modal": "true", "aria-label": title },
    h("header", h("h2", title), h("button.icon-btn", { "aria-label": "Close", onclick: close }, "✕")),
    h("div.modal-body", body),
  );
  const backdrop = h("div.backdrop", { onmousedown: (e) => { if (e.target === backdrop) close(); } }, dialog);
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey);
  setTimeout(() => dialog.querySelector("input, textarea, select")?.focus(), 0);
  return { close, dialog };
}

export function confirmDialog(title, text, confirmLabel = "Delete") {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const m = modal(title, [
      h("p", text),
      h("div.form-actions",
        h("button.btn", { onclick: () => finish(false) }, "Cancel"),
        h("button.btn.danger", { onclick: () => finish(true) }, confirmLabel)),
    ]);
    const observer = new MutationObserver(() => {
      if (!m.dialog.isConnected) { observer.disconnect(); if (!done) { done = true; resolve(false); } }
    });
    observer.observe(document.body, { childList: true });
  });
}

// ----------------------------------------------------------------------------- forms
export function field(labelText, input, hint) {
  return h("label.field", h("span.field-label", labelText), input, hint && h("span.hint", hint));
}

export function select(name, options, value, attrs = {}) {
  return h("select", { name, ...attrs },
    options.map((o) => {
      const [v, text, extra] = Array.isArray(o) ? o : [o, label(o)];
      return h("option", { value: v, selected: String(v) === String(value ?? ""), ...extra }, text);
    }));
}

/** Collects named inputs of a form into an object (empty strings kept; caller decides). */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.multiple) out[el.name] = [...el.selectedOptions].map((o) => o.value);
    else out[el.name] = el.value;
  }
  return out;
}

/**
 * Searchable user picker backed by /users/lookup. Calls onPick(user|null).
 * opts: {projectId, placeholder, allowNone, initial}
 */
export function userPicker(lookup, onPick, opts = {}) {
  const input = h("input", { type: "search", placeholder: opts.placeholder || "Search people…", autocomplete: "off" });
  const list = h("ul.picker-list", { role: "listbox" });
  const wrap = h("div.picker", input, list);
  let timer;
  let items = [];
  let active = -1;

  const render = () => {
    clear(list,
      opts.allowNone && h("li", { class: active === -1 ? "active" : "", onmousedown: (e) => { e.preventDefault(); pick(null); } },
        h("span.muted", "Unassigned")),
      items.map((u, i) => h("li", {
        class: i === active ? "active" : "",
        onmousedown: (e) => { e.preventDefault(); pick(u); },
      }, avatar(u, "sm"), h("span", u.name), h("span.muted", u.email))),
      !items.length && !opts.allowNone && h("li.muted.none", "No matches"),
    );
  };
  const search = async () => {
    try {
      items = await lookup(input.value.trim());
      active = items.length ? 0 : -1;
      render();
      wrap.classList.add("open");
    } catch (err) { toast(err.message, "error"); }
  };
  const pick = (u) => {
    wrap.classList.remove("open");
    input.value = u ? u.name : "";
    onPick(u);
  };
  input.addEventListener("focus", search);
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 150); });
  input.addEventListener("blur", () => setTimeout(() => wrap.classList.remove("open"), 100));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(opts.allowNone ? -1 : 0, active - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter" && wrap.classList.contains("open")) {
      e.preventDefault();
      if (active >= 0 && items[active]) pick(items[active]);
      else if (opts.allowNone) pick(null);
    }
  });
  if (opts.initial) input.value = opts.initial.name;
  return wrap;
}
