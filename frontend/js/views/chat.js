// Team chat: project channels, public/private channels and direct messages, all live over a WebSocket.
// Threads, reactions, pins, files (drag/drop/paste), @mentions, emoji, typing indicators, presence,
// unread markers, search and desktop notifications.
import { api, auth, request } from "../api.js";
import { icon } from "../icons.js";
import { realtime } from "../realtime.js";
import { EMOJI, QUICK_REACTIONS, recentEmoji, rememberEmoji, searchEmoji } from "../emoji.js";
import { activeCalls, callsSupported, currentCall, fmtDuration, initCalls, join as joinCall, onCallsChange, startCall, stopCalls } from "../calls.js";
import { prefs, sounds } from "../sounds.js";
import { fileCard as previewCard, files as previewFiles, openPreview } from "../preview.js";
import {
  avatar, busy, clear, confirmDialog, copyText, emptyState, errorBox, field, fmtBytes, h, modal, parseDate,
  renderMarkdown, spinner, timeAgo, toast,
} from "../ui.js";

const LAST_KEY = "chat.lastChannel";
const GROUP_MS = 5 * 60 * 1000;
const TYPING_MS = 6000;
const me = () => auth.user;
const isAdmin = () => auth.user?.role === "admin";

// ============================================================================ shared state
// Lives for the whole session so the nav badge and desktop notifications work on every page.
const shared = {
  channels: new Map(), // id -> channel (from /chat/channels)
  users: new Map(), // id -> {id, name, email, designation, online}
  online: new Set(),
  usersLoaded: null,
  viewing: null, // channel id currently open in the chat view (and visible)
  saved: new Set(), // message ids I bookmarked
  unsub: null,
};

async function loadUsers(force = false) {
  if (!shared.usersLoaded || force) {
    shared.usersLoaded = api.get("/chat/users").then((list) => {
      shared.users = new Map(list.map((u) => [u.id, u]));
      shared.online = new Set(list.filter((u) => u.online).map((u) => u.id));
    });
  }
  return shared.usersLoaded;
}

const userById = (id) => shared.users.get(id) || (id === me()?.id ? me() : null);
const userByEmail = (email) => [...shared.users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase());

let badgeTimer = null;
function refreshBadgeSoon(delay = 250) {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(refreshBadge, delay);
}
async function refreshBadge() {
  if (!auth.user) return;
  try {
    const list = await api.get("/chat/channels");
    shared.channels = new Map(list.map((c) => [c.id, c]));
    paintBadge();
    view?.onChannels(list);
  } catch { /* offline: keep the old badge */ }
}
function paintBadge() {
  let unread = 0;
  let mentions = 0;
  for (const c of shared.channels.values()) {
    if (c.id === shared.viewing) continue;
    if (!c.muted) unread += c.unread ? 1 : 0;
    mentions += c.mentions;
  }
  document.querySelectorAll(".chat-count").forEach((el) => {
    el.hidden = !unread && !mentions;
    el.textContent = mentions ? String(Math.min(mentions, 99)) : "";
    el.classList.toggle("dot-only", !mentions);
    el.title = mentions ? `${mentions} mention${mentions === 1 ? "" : "s"} or direct messages` : `${unread} conversation${unread === 1 ? "" : "s"} with new messages`;
  });
  window.desktop?.setBadge(mentions, unread > 0); // dock / taskbar in the desktop app
}

function mentionsMe(body) {
  if (!body) return false;
  const email = me()?.email?.toLowerCase();
  const lower = body.toLowerCase();
  return (email && lower.includes(`@${email}`)) || /(^|\s)@(channel|here|everyone)\b/.test(body);
}

function desktopNotify(msg) {
  const ch = shared.channels.get(msg.channel_id);
  if (!ch || ch.muted) return;
  const isDm = ch.kind === "dm";
  if (!isDm && !mentionsMe(msg.body)) return;
  const visibleHere = !document.hidden && shared.viewing === msg.channel_id;
  if (visibleHere) return;
  window.desktop?.attention();
  const who = msg.user?.name || "Someone";
  const title = isDm ? who : `${who} in ${ch.kind === "project" ? ch.display_name : "#" + ch.name}`;
  const body = plainText(msg.body) || (msg.files.length ? `Sent ${msg.files.length} file${msg.files.length === 1 ? "" : "s"}` : "");
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, { body: body.slice(0, 180), tag: `chat-${msg.channel_id}`, renotify: true });
      n.onclick = () => { window.desktop?.focus(); window.focus(); location.hash = `#/chat/${msg.channel_id}?m=${msg.id}`; n.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
  } else if (!location.hash.startsWith("#/chat")) {
    toast(`${title}: ${body.slice(0, 80)}`);
  }
}

function plainText(md) {
  return (md || "")
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/@([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g, (_, e) => "@" + (userByEmail(e)?.name || e))
    .replace(/[*_~`>#]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function playFor(m) {
  const ch = shared.channels.get(m.channel_id);
  const loud = !ch || ch.kind === "dm" || mentionsMe(m.body);
  if (ch?.muted && !mentionsMe(m.body)) return;
  if (m.parent_id && !loud) return;
  const here = !document.hidden && shared.viewing === m.channel_id;
  if (loud && !here) sounds.mention();
  else sounds.message(here);
}

/** Called once the app shell exists: connect the socket, keep the badge fresh, notify. */
export function startChat() {
  stopChat();
  realtime.start();
  initCalls(() => shared.users);
  loadUsers(true).catch(() => {});
  refreshBadge();
  api.get("/chat/saved/ids").then((ids) => { shared.saved = new Set(ids); }).catch(() => {});
  shared.unsub = realtime.on((ev) => {
    switch (ev.type) {
      case "_open":
        refreshBadgeSoon(50);
        loadUsers(true).then(() => view?.onPresence()).catch(() => {});
        break;
      case "message.new":
        if (ev.message.call) { refreshBadgeSoon(400); break; }
        if (ev.message.user?.id !== me()?.id) playFor(ev.message);
        if (ev.message.user?.id !== me()?.id && !ev.message.parent_id) desktopNotify(ev.message);
        else if (ev.message.parent_id && ev.message.user?.id !== me()?.id && mentionsMe(ev.message.body)) desktopNotify(ev.message);
        if (!shared.channels.has(ev.channel_id)) refreshBadgeSoon();
        else refreshBadgeSoon(400);
        break;
      case "read":
      case "channels":
        refreshBadgeSoon();
        break;
      case "saved":
        if (ev.saved) shared.saved.add(ev.message_id); else shared.saved.delete(ev.message_id);
        break;
      case "presence":
        if (ev.online) shared.online.add(ev.user_id); else shared.online.delete(ev.user_id);
        view?.onPresence();
        break;
      default:
    }
    view?.onEvent(ev);
  });
}

export function stopChat() {
  shared.unsub?.();
  shared.unsub = null;
  stopCalls();
  realtime.stop();
  shared.channels.clear();
  shared.usersLoaded = null;
  window.desktop?.setBadge(0);
}

// ============================================================================ small helpers
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const dayFmtYear = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

function dayLabel(d) {
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return (d.getFullYear() === today.getFullYear() ? dayFmt : dayFmtYear).format(d);
}

function channelIcon(c, size = 16) {
  if (c.kind === "project") return icon("folder", { size });
  if (c.kind === "dm") return null;
  return icon(c.is_private ? "lock" : "hash", { size });
}

/** Your own space: a direct message with nobody else in it. */
const isSelf = (c) => c?.kind === "dm" && (c.members || []).length === 1 && c.members[0].id === me()?.id;

function channelTitle(c) {
  if (isSelf(c)) return "Notes to self";
  return c.kind === "channel" ? c.name : c.display_name;
}

function dmPartner(c) {
  if (c.kind !== "dm") return null;
  const others = (c.members || []).filter((u) => u.id !== me().id);
  return others.length === 1 ? others[0] : others.length ? null : me();
}

function presenceAvatar(user, size = "sm") {
  const wrap = h("span.pres-avatar", avatar(user, size));
  if (user) wrap.append(h(`span.pres-dot${shared.online.has(user.id) ? ".on" : ""}`, { title: shared.online.has(user.id) ? "Online" : "Away" }));
  return wrap;
}

function dmAvatar(c) {
  const partner = dmPartner(c);
  if (partner) return presenceAvatar(partner);
  const others = (c.members || []).filter((u) => u.id !== me().id);
  return h("span.group-avatar", h("span", String(others.length)));
}

const blobCache = new Map();
function fileUrl(id, inline) {
  const key = `${id}:${inline ? 1 : 0}`;
  if (!blobCache.has(key)) {
    blobCache.set(key, request("GET", `/chat/files/${id}`, { params: inline ? { inline: true } : undefined, raw: true })
      .then((r) => r.blob()).then((b) => URL.createObjectURL(b))
      .catch((err) => { blobCache.delete(key); throw err; }));
  }
  return blobCache.get(key);
}

/** Preview chat files (images, PDF, Office, code …) with ← → between them. */
function previewChatFiles(list, index, meta) {
  openPreview(list.map((f) => previewFiles.chat(f, f.user?.name || meta)), index);
}

function linkRow(l, extra) {
  let host = "";
  try { host = new URL(l.url).hostname.replace(/^www\./, ""); } catch { /* keep empty */ }
  return h("div.link-row",
    h("span.link-ic", icon("link", { size: 15 })),
    h("a.link-main", { href: l.url, target: "_blank", rel: "noopener noreferrer", title: l.url },
      h("span.link-title", l.text || l.url.replace(/^https?:\/\/(www\.)?/, "")), h("span.link-host", host)),
    h("button.icon-btn.sm", { type: "button", title: "Copy link", "aria-label": "Copy link", onclick: () => copyText(l.url, "Link copied") }, icon("copy", { size: 14 })),
    extra);
}

/** Markdown + "@email" → name pills, "@channel" → broadcast pill. */
function renderBody(text) {
  const el = renderMarkdown(text);
  el.classList.add("msg-md");
  el.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
    const prev = a.previousSibling;
    const u = userByEmail(a.textContent);
    if (u && prev?.nodeType === 3 && prev.textContent.endsWith("@")) {
      prev.textContent = prev.textContent.slice(0, -1);
      a.replaceWith(mentionPill(u));
    }
  });
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!node.isConnected || node.parentElement?.closest("code, pre, a")) continue;
    const parts = node.textContent.split(/(@[\w.+-]+@[\w-]+(?:\.[\w-]+)+|@(?:channel|here|everyone)\b)/g);
    if (parts.length === 1) continue;
    node.replaceWith(...parts.map((p) => {
      if (/^@(channel|here|everyone)$/.test(p)) return h("span.mention.broadcast", p);
      const u = p.startsWith("@") && userByEmail(p.slice(1));
      return u ? mentionPill(u) : document.createTextNode(p);
    }));
  }
  // emoji-only messages are shown large
  const plain = (text || "").trim();
  if (isEmojiOnly(plain)) {
    el.classList.add("jumbo");
    el.replaceChildren(...graphemes(plain).filter((g) => g.trim()).map((g, i) => h("span.jumbo-e", { dataset: { fx: fxFor(g) }, style: { "--i": i } }, g)));
  }
  collapseLongCode(el);
  return el;
}

const isEmojiOnly = (t) => Boolean(t) && t.length <= 24 && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && /\p{Extended_Pictographic}/u.test(t);

function graphemes(text) {
  if (window.Intl?.Segmenter) return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((x) => x.segment);
  return [...text];
}

// Which little animation each emoji gets when it is sent on its own (big).
const FX = [
  [/😂|🤣|😆|😹|😅/u, "laugh"], [/❤️|💖|💗|💓|💕|🧡|💛|💚|💙|💜|🖤|🤍|😍|🥰|😘|🫶/u, "beat"],
  [/👍|👏|🙌|💪|✅|💯|🆗|👌|🤝/u, "pop"], [/🎉|🥳|🎊|🎈|🎂|🍾|🎁/u, "party"], [/🔥|⚡|💥/u, "flicker"],
  [/🚀|✈️/u, "launch"], [/👋|🤚|✋|🖐️/u, "wave"], [/😭|😢|🥺|😿/u, "sob"], [/😱|🤯|😮|😲|😳/u, "shock"],
  [/🤔|🧐|🤨/u, "think"], [/😎|🤩|✨|⭐|🌟|💫/u, "shine"], [/💩|🤡|👻|🙈|🤪|😜/u, "wobble"], [/😴|😪|🥱/u, "sleep"],
  [/😡|😠|🤬|😤/u, "rage"], [/🐛|🐞/u, "crawl"],
];
const fxFor = (e) => FX.find(([re]) => re.test(e))?.[1] || "bounce";

// Emoji that set off a burst across the conversation when they arrive live.
const BURST = /🎉|🥳|🎊|🚀|❤️|😂|🤣|🔥|👏|🎂|💯|✨|😍|🙌|🍾|🎈|💖|👍/u;

/** A shower of emoji over the conversation (respects reduced motion and the viewer's setting). */
function emojiBurst(container, emoji, { count = 22 } = {}) {
  if (!container || !prefs.get("effects") || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const fall = /🎉|🎊|🥳|🎈|✨/u.test(emoji);
  const fly = /🚀/u.test(emoji);
  const layer = h(`div.fx-layer.${fall ? "fall" : fly ? "fly" : "rise"}`);
  for (let i = 0; i < count; i++) {
    const size = 18 + Math.random() * 26;
    layer.append(h("span.fx-p", {
      style: {
        left: `${Math.random() * 96}%`, fontSize: `${size}px`,
        "--d": `${1.6 + Math.random() * 1.6}s`, "--delay": `${Math.random() * 0.6}s`,
        "--x": `${(Math.random() - 0.5) * 160}px`, "--r": `${(Math.random() - 0.5) * 540}deg`,
      },
    }, emoji));
  }
  container.append(layer);
  setTimeout(() => layer.remove(), 4200);
}

function reactionPop(chip, emoji) {
  if (!chip || !prefs.get("effects") || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  chip.classList.remove("bump");
  void chip.offsetWidth;
  chip.classList.add("bump");
  const r = chip.getBoundingClientRect();
  for (let i = 0; i < 6; i++) {
    const p = h("span.fx-mini", { style: { left: `${r.left + r.width / 2}px`, top: `${r.top}px`, "--x": `${(Math.random() - 0.5) * 90}px`, "--y": `${-40 - Math.random() * 50}px`, "--r": `${(Math.random() - 0.5) * 300}deg` } }, emoji);
    document.body.append(p);
    setTimeout(() => p.remove(), 900);
  }
}

/** Long code blocks start folded with a "Show all" toggle. */
function collapseLongCode(el) {
  el.querySelectorAll(".md-codeblock").forEach((block) => {
    const lines = (block.querySelector("code")?.textContent || "").split("\n").length;
    if (lines <= 18) return;
    block.classList.add("folded");
    const btn = h("button.code-more", {
      type: "button",
      onclick: () => {
        const folded = block.classList.toggle("folded");
        btn.textContent = folded ? `Show all ${lines} lines` : "Show less";
      },
    }, `Show all ${lines} lines`);
    block.append(btn);
  });
}

// ---------------------------------------------------------------------------- code snippets
const SNIPPET_LANGS = ["", "javascript", "typescript", "python", "java", "go", "rust", "php", "ruby", "csharp", "cpp", "c", "kotlin", "swift",
  "sql", "bash", "json", "yaml", "html", "css", "xml", "markdown", "dockerfile", "diff"];

function guessLang(code) {
  const t = code.trim();
  if (/^[[{]/.test(t)) { try { JSON.parse(t); return "json"; } catch { /* not JSON */ } }
  if (/^\s*(select|insert|update|delete|create|alter|with)\b/i.test(t)) return "sql";
  if (/^\s*(def |class \w+.*:|import \w+$|from \w[\w.]* import)/m.test(t)) return "python";
  if (/^\s*<(!doctype|html|div|span|template|\w+[ >])/i.test(t)) return "html";
  if (/^\s*(\$ |sudo |npm |pip |git |cd |docker |curl |export )/m.test(t)) return "bash";
  if (/^\s*(package |func |import \()/m.test(t)) return "go";
  if (/^\s*(public |private |protected )?(static )?(class|interface|void) /m.test(t)) return "java";
  if (/\b(const|let|function|console\.\w+|import .* from)\b|=>/.test(t)) return /:\s*(string|number|boolean)\b|interface /.test(t) ? "typescript" : "javascript";
  if (/^[\w-]+:\s/m.test(t) && !/[;{}]/.test(t)) return "yaml";
  if (/^\s*[.#]?[\w-]+\s*\{[^}]*:[^}]*\}/m.test(t)) return "css";
  return "";
}

function looksLikeCode(text) {
  if (text.split("\n").length < 3) return false;
  return /[{};]\s*$/m.test(text) || /^( {2,}|\t)\S/m.test(text)
    || /\b(function|const|let|var|def|class|import|return|public|private|SELECT|FROM|WHERE|#include|echo|fn|func)\b/.test(text) || /^\s*<\/?\w+/m.test(text);
}

function fence(code, lang) {
  const ticks = code.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${code.replace(/\s+$/, "")}\n${ticks}`;
}

function snippetDialog(onSend, initial = "") {
  const code = h("textarea.snippet-code", { rows: 14, spellcheck: false, placeholder: "Paste or write code…", "aria-label": "Code" });
  code.value = initial;
  const lang = h("select", { "aria-label": "Language" }, SNIPPET_LANGS.map((l) => h("option", { value: l }, l || "Auto / plain text")));
  const title = h("input", { placeholder: "Optional note, e.g. 'fix for PAY-12'", maxLength: 200 });
  const lines = h("span.muted.small");
  const sync = () => {
    const n = code.value ? code.value.split("\n").length : 0;
    lines.textContent = `${n} line${n === 1 ? "" : "s"}`;
    if (!lang.dataset.touched) lang.value = guessLang(code.value);
  };
  lang.addEventListener("change", () => { lang.dataset.touched = "1"; });
  code.addEventListener("input", sync);
  const send = h("button.btn.primary", { type: "submit" }, icon("send", { size: 14 }), "Send snippet");
  const form = h("form.form.snippet-form",
    h("div.snippet-bar", lang, lines, h("span.muted.small.snippet-hint", h("kbd", "Tab"), " indents · ", h("kbd", "Ctrl"), "+", h("kbd", "Enter"), " sends")),
    code, field("Note", title), h("div.form-actions", send));
  code.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = code;
      if (a === b && !e.shiftKey) code.setRangeText("  ", a, b, "end");
      else {
        const start = value.lastIndexOf("\n", a - 1) + 1;
        const block = value.slice(start, b);
        const out = e.shiftKey ? block.replace(/^ {1,2}/gm, "") : block.replace(/^/gm, "  ");
        code.setRangeText(out, start, b, "select");
      }
      sync();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  const m = modal("Code snippet", form, { wide: true });
  setTimeout(() => { sync(); code.focus(); }, 0);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!code.value.trim()) { toast("Write or paste some code first", "error"); return; }
    const body = [title.value.trim(), fence(code.value, lang.value)].filter(Boolean).join("\n");
    busy(send, async () => { await onSend(body, []); m.close(); });
  });
}

function mentionPill(u) {
  return h(`span.mention${u.id === me().id ? ".me" : ""}`, { title: u.email }, `@${u.name}`);
}

// ---------------------------------------------------------------------------- popovers
let openPop = null;
function closePop() { openPop?.close(); openPop = null; }

function popover(anchor, content, { align = "start", cls = "" } = {}) {
  closePop();
  const el = h(`div.chat-pop${cls ? "." + cls : ""}`, content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  let left = align === "end" ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + ht > innerHeight - 8) top = Math.max(8, r.top - ht - 6);
  Object.assign(el.style, { left: `${left}px`, top: `${top}px` });
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const close = () => {
    el.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    if (openPop?.el === el) openPop = null;
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  openPop = { el, close };
  return openPop;
}

function emojiPicker(anchor, onPick) {
  const grid = h("div.emoji-grid");
  const search = h("input.emoji-search", { type: "search", placeholder: "Search emoji…", "aria-label": "Search emoji" });
  const tabs = h("div.emoji-tabs");
  const pick = (e) => { rememberEmoji(e); pop.close(); onPick(e); };
  const cell = ([e, name]) => h("button.emoji-cell", { type: "button", title: `:${name.split(" ")[0]}:`, onclick: () => pick(e) }, e);
  const showAll = () => {
    const recent = recentEmoji();
    clear(grid,
      recent.length ? [h("div.emoji-cat", { id: "emoji-cat-recent" }, "Recently used"), h("div.emoji-row", recent.map((e) => cell([e, "recent"])))] : null,
      EMOJI.map(([cat, list], i) => [h("div.emoji-cat", { id: `emoji-cat-${i}` }, cat), h("div.emoji-row", list.map(cell))]));
  };
  search.addEventListener("input", () => {
    const q = search.value.trim();
    if (!q) return showAll();
    const found = searchEmoji(q, 80);
    clear(grid, found.length ? h("div.emoji-row", found.map(cell)) : h("p.muted.small.emoji-none", "No emoji found"));
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); grid.querySelector(".emoji-cell")?.click(); }
  });
  EMOJI.forEach(([cat, list], i) => tabs.append(h("button.emoji-tab", {
    type: "button", title: cat, onclick: () => { search.value = ""; showAll(); grid.querySelector(`#emoji-cat-${i}`)?.scrollIntoView({ block: "start" }); },
  }, list[0][0])));
  showAll();
  const pop = popover(anchor, [search, tabs, grid], { cls: "emoji-pop", align: "end" });
  setTimeout(() => search.focus(), 0);
  return pop;
}

function menu(anchor, items) {
  const pop = popover(anchor, h("div.chat-menu", items.filter(Boolean).map((it) => it === "-" ? h("hr") :
    h(`button${it.danger ? ".danger" : ""}`, { type: "button", onclick: () => { pop.close(); it.run(); } },
      it.icon ? icon(it.icon, { size: 15 }) : h("span.menu-ic"), h("span", it.label), it.hint ? h("kbd.menu-kbd", it.hint) : null))), { align: "end" });
  return pop;
}

// ============================================================================ composer
/**
 * Message box with Markdown shortcuts, @mention and :emoji: autocomplete, files (pick/paste/drop),
 * Enter to send, Shift+Enter for a new line, ↑ to edit your last message.
 */
function composer({ channelId, parentId = null, placeholder, onSend, onEditLast, candidates }) {
  const key = `${channelId}:${parentId || ""}`;
  const ta = h("textarea.cc-input", { rows: 1, placeholder, "aria-label": placeholder, maxLength: 10000 });
  ta.value = view?.drafts.get(key) || "";
  let files = [];
  const filesRow = h("div.cc-files");
  const sendBtn = h("button.cc-send", { type: "button", title: "Send (Enter)", "aria-label": "Send" }, icon("send", { size: 16 }));
  const fileInput = h("input", { type: "file", multiple: true, hidden: true, onchange: () => { addFiles(fileInput.files); fileInput.value = ""; } });
  const ac = h("ul.cc-ac", { role: "listbox", hidden: true });
  let acItems = [];
  let acIndex = 0;
  let acRange = null;
  let lastTyping = 0;

  const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`; };
  const sync = () => {
    sendBtn.disabled = !ta.value.trim() && !files.length;
    view?.drafts.set(key, ta.value);
    grow();
  };

  function addFiles(list) {
    for (const f of list) if (files.length < 10) files.push(f);
    renderFiles();
    sync();
    ta.focus();
  }
  function renderFiles() {
    clear(filesRow, files.map((f, i) => {
      const thumb = f.type.startsWith("image/") ? h("img", { src: URL.createObjectURL(f), alt: "" }) : icon("file", { size: 18 });
      return h("div.cfile", h("span.cfile-thumb", thumb),
        h("span.cfile-meta", h("span.cfile-name", f.name), h("span.muted.small", fmtBytes(f.size))),
        h("button.icon-btn.sm", { type: "button", "aria-label": `Remove ${f.name}`, onclick: () => { files.splice(i, 1); renderFiles(); sync(); } }, icon("x", { size: 13 })));
    }));
    filesRow.hidden = !files.length;
  }

  function wrap(before, after = before, placeholderText = "text") {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const sel = value.slice(s, e) || placeholderText;
    ta.setRangeText(before + sel + after, s, e, "end");
    ta.setSelectionRange(s + before.length, s + before.length + sel.length);
    ta.focus();
    sync();
  }
  function linePrefix(prefix) {
    const { selectionStart: s, value } = ta;
    const start = value.lastIndexOf("\n", s - 1) + 1;
    ta.setRangeText(prefix, start, start, "end");
    ta.focus();
    sync();
  }
  function insert(text) {
    const { selectionStart: s, selectionEnd: e } = ta;
    ta.setRangeText(text, s, e, "end");
    ta.focus();
    sync();
  }

  // ---- autocomplete
  function updateAc() {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = /(^|\s)([@:])([\w.+-]*)$/.exec(upto);
    if (!m || (m[2] === ":" && m[3].length < 2)) return hideAc();
    const q = m[3].toLowerCase();
    acRange = [ta.selectionStart - m[3].length - 1, ta.selectionStart];
    if (m[2] === "@") {
      const people = candidates().filter((u) => !q || u.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || u.email.toLowerCase().startsWith(q) || u.name.toLowerCase().startsWith(q));
      const specials = view?.current?.kind !== "dm" ? [["channel", "Notify everyone in this conversation"], ["here", "Notify everyone who is online"]]
        .filter(([s]) => s.startsWith(q)).map(([s, d]) => ({ special: s, desc: d })) : [];
      acItems = [...people.slice(0, 8).map((u) => ({ user: u })), ...specials];
    } else {
      acItems = searchEmoji(q, 8).map((e) => ({ emoji: e }));
    }
    if (!acItems.length) return hideAc();
    acIndex = 0;
    renderAc();
  }
  function renderAc() {
    ac.hidden = false;
    clear(ac, acItems.map((it, i) => h(`li${i === acIndex ? ".active" : ""}`, {
      role: "option", onmousedown: (e) => { e.preventDefault(); acIndex = i; chooseAc(); },
    }, it.user ? [presenceAvatar(it.user), h("strong", it.user.name), h("span.muted.small", it.user.designation || it.user.email)]
      : it.special ? [h("span.ac-at", icon("at", { size: 14 })), h("strong", `@${it.special}`), h("span.muted.small", it.desc)]
        : [h("span.ac-emoji", it.emoji[0]), h("span", `:${it.emoji[1].split(" ")[0]}:`)])));
  }
  function hideAc() { ac.hidden = true; acItems = []; acRange = null; }
  function chooseAc() {
    const it = acItems[acIndex];
    if (!it || !acRange) return;
    const text = it.user ? `@${it.user.email} ` : it.special ? `@${it.special} ` : it.emoji[0];
    ta.setRangeText(text, acRange[0], acRange[1], "end");
    if (it.emoji) rememberEmoji(it.emoji[0]);
    hideAc();
    sync();
  }

  async function send() {
    const body = ta.value.trim();
    if (!body && !files.length) return;
    const sending = files;
    ta.value = "";
    files = [];
    renderFiles();
    sync();
    hideAc();
    view?.drafts.delete(key);
    try {
      await onSend(body, sending, parentId);
      sounds.sent();
    } catch (err) {
      ta.value = body;
      files = sending;
      renderFiles();
      sync();
      toast(err.message, "error");
    }
  }

  ta.addEventListener("input", () => {
    sync();
    updateAc();
    const now = Date.now();
    if (ta.value.trim() && now - lastTyping > 3000) {
      lastTyping = now;
      realtime.send({ type: "typing", channel_id: channelId, parent_id: parentId });
    }
  });
  ta.addEventListener("click", updateAc);
  ta.addEventListener("blur", () => setTimeout(hideAc, 120));
  ta.addEventListener("keydown", (e) => {
    if (!ac.hidden && acItems.length) {
      if (e.key === "ArrowDown") { acIndex = (acIndex + 1) % acItems.length; renderAc(); e.preventDefault(); return; }
      if (e.key === "ArrowUp") { acIndex = (acIndex - 1 + acItems.length) % acItems.length; renderAc(); e.preventDefault(); return; }
      if (e.key === "Enter" || e.key === "Tab") { chooseAc(); e.preventDefault(); return; }
      if (e.key === "Escape") { hideAc(); e.preventDefault(); e.stopPropagation(); return; }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !mod) { e.preventDefault(); send(); return; }
    if (e.key === "Enter" && mod) { e.preventDefault(); send(); return; }
    if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); wrap("**"); return; }
    if (mod && e.key.toLowerCase() === "i") { e.preventDefault(); wrap("_"); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === "x") { e.preventDefault(); wrap("~~"); return; }
    if (e.key === "ArrowUp" && !ta.value && onEditLast) { if (onEditLast()) e.preventDefault(); }
  });
  const pasteHint = h("div.paste-hint", { hidden: true });
  let hintTimer = null;
  const hideHint = () => { pasteHint.hidden = true; clearTimeout(hintTimer); };
  ta.addEventListener("paste", (e) => {
    const text = (e.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n");
    const before = ta.value.slice(0, ta.selectionStart);
    const insideFence = ((before.match(/```/g) || []).length % 2) === 1;
    if (text && !insideFence && looksLikeCode(text)) {
      const start = ta.selectionStart;
      setTimeout(() => {
        const end = start + text.length;
        if (ta.value.slice(start, end) !== text) return;
        clear(pasteHint, icon("snippet", { size: 15 }), h("span", "Looks like code."),
          h("button.link", {
            type: "button", onmousedown: (ev) => ev.preventDefault(),
            onclick: () => {
              if (ta.value.slice(start, end) === text) {
                ta.setRangeText(`${start && ta.value[start - 1] !== "\n" ? "\n" : ""}${fence(text, guessLang(text))}\n`, start, end, "end");
                sync();
              }
              hideHint();
              ta.focus();
            },
          }, "Format as code block"),
          h("button.link.muted", { type: "button", onclick: hideHint }, "Keep as text"));
        pasteHint.hidden = false;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(hideHint, 10_000);
      }, 0);
    }
    const pasted = [...(e.clipboardData?.files || [])];
    if (pasted.length) {
      e.preventDefault();
      addFiles(pasted.map((f, i) => (f.name && f.name !== "image.png") ? f : new File([f], `pasted-${Date.now()}-${i}.${(f.type.split("/")[1] || "png")}`, { type: f.type })));
    }
  });
  sendBtn.addEventListener("click", send);

  const tool = (ic, title, run) => h("button.ctool", { type: "button", title, "aria-label": title, onmousedown: (e) => e.preventDefault(), onclick: run }, icon(ic, { size: 15 }));
  const emojiBtn = tool("smile", "Emoji", () => emojiPicker(emojiBtn, insert));
  const el = h("div.chat-composer",
    filesRow,
    pasteHint,
    h("div.cc-box", ac, ta,
      h("div.cc-bar",
        h("div.cc-tools",
          tool("bold", "Bold (Ctrl+B)", () => wrap("**")),
          tool("italic", "Italic (Ctrl+I)", () => wrap("_")),
          tool("strike", "Strikethrough", () => wrap("~~")),
          tool("snippet", "Code snippet", () => snippetDialog(async (b, f) => { await onSend(b, f, parentId); sounds.sent(); })),
          tool("code", "Inline code", () => (ta.value.slice(ta.selectionStart, ta.selectionEnd).includes("\n") ? wrap("```\n", "\n```", "code") : wrap("`", "`", "code"))),
          tool("link", "Link", () => wrap("[", "](https://)", "link text")),
          tool("list", "Bulleted list", () => linePrefix("- ")),
          h("span.ctool-sep"),
          tool("at", "Mention someone", () => { insert(ta.value && !/\s$/.test(ta.value.slice(0, ta.selectionStart)) ? " @" : "@"); updateAc(); }),
          emojiBtn,
          tool("paperclip", "Attach files", () => fileInput.click())),
        h("span.cc-hint", h("kbd", "Enter"), " to send · ", h("kbd", "Shift"), "+", h("kbd", "Enter"), " new line"),
        sendBtn)),
    fileInput);
  renderFiles();
  sync();
  return { el, focus: () => ta.focus(), addFiles, textarea: ta };
}

// ============================================================================ the view
let view = null;

export async function renderChat(container, [channelParam]) {
  const ctrl = new ChatView(container);
  view = ctrl;
  document.body.classList.add("chat-page");
  await ctrl.init(channelParam ? Number(channelParam) : null);
  return () => {
    ctrl.destroy();
    if (view === ctrl) view = null;
    shared.viewing = null;
    paintBadge();
    document.body.classList.remove("chat-page");
  };
}

class ChatView {
  constructor(container) {
    this.root = container;
    this.drafts = new Map();
    this.channels = [];
    this.current = null;
    this.messages = [];
    this.msgEls = new Map();
    this.hasMore = false;
    this.hasNewer = false;
    this.loading = false;
    this.members = [];
    this.panel = null; // {kind, ...}
    this.thread = null;
    this.typing = new Map(); // channelId -> Map(userId -> {name, parent_id, until})
    this.filter = "";
    this.collapsed = new Set(JSON.parse(safeGet("chat.collapsed") || "[]"));
    this.readTimer = null;
    this.typingTimer = setInterval(() => this.renderTyping(), 1500);
    this.onKey = (e) => this.handleKey(e);
    this.onVisible = () => { if (!document.hidden) { shared.viewing = this.current?.id ?? null; this.maybeMarkRead(); } else { shared.viewing = null; } };
    document.addEventListener("keydown", this.onKey);
    document.addEventListener("visibilitychange", this.onVisible);
    this.offCalls = onCallsChange(() => this.renderHeader());
  }

  destroy() {
    clearInterval(this.typingTimer);
    clearTimeout(this.readTimer);
    this.offCalls?.();
    document.removeEventListener("keydown", this.onKey);
    document.removeEventListener("visibilitychange", this.onVisible);
    closePop();
  }

  // ---------------------------------------------------------------- layout
  async init(channelId) {
    this.side = h("aside.chat-side");
    this.mainEl = h("section.chat-main");
    this.panelEl = h("aside.chat-panel", { hidden: true });
    this.el = h("div.chat", this.side, this.mainEl, this.panelEl);
    clear(this.root, this.el);
    clear(this.mainEl, spinner(6));
    this.renderSideSkeleton();
    try {
      await loadUsers();
      this.channels = await api.get("/chat/channels");
    } catch (err) {
      clear(this.mainEl, errorBox(err));
      return;
    }
    shared.channels = new Map(this.channels.map((c) => [c.id, c]));
    this.renderSide();
    const q = new URLSearchParams(location.hash.split("?")[1] || "");
    const target = channelId
      ?? this.pickDefault();
    if (target) await this.open(target, { around: q.get("m") ? Number(q.get("m")) : null, push: false });
    else this.renderWelcome();
    this.notifyPermissionHint();
  }

  pickDefault() {
    const byMention = this.channels.find((c) => c.mentions && !c.muted);
    if (byMention) return byMention.id;
    const last = Number(safeGet(LAST_KEY));
    if (last && this.channels.some((c) => c.id === last)) return last;
    const unread = this.channels.find((c) => c.unread && !c.muted);
    if (unread) return unread.id;
    return this.sorted("project")[0]?.id || this.channels[0]?.id || null;
  }

  renderSideSkeleton() {
    clear(this.side, h("div.chat-side-head", h("strong", "Chat")), spinner(8));
  }

  sorted(kind) {
    const list = this.channels.filter((c) => (kind === "channel" ? c.kind === "channel" : c.kind === kind) && !c.archived && !isSelf(c));
    if (kind === "dm") return list.sort((a, b) => (parseDate(b.last_message_at) || 0) - (parseDate(a.last_message_at) || 0));
    return list.sort((a, b) => channelTitle(a).localeCompare(channelTitle(b)));
  }

  renderSide() {
    const f = this.filter.toLowerCase();
    const match = (c) => !f || channelTitle(c).toLowerCase().includes(f) || (c.members || []).some((u) => u.name.toLowerCase().includes(f));
    const item = (c) => {
      const active = this.current?.id === c.id;
      const partner = dmPartner(c);
      return h(`a.chat-item${active ? ".active" : ""}${c.unread && !c.muted ? ".unread" : ""}${c.muted ? ".muted-ch" : ""}`, {
        href: `#/chat/${c.id}`, dataset: { id: c.id },
        onclick: (e) => { e.preventDefault(); this.open(c.id); },
        title: c.kind === "dm" ? c.display_name : (c.topic || channelTitle(c)),
      },
      h("span.chat-item-ic", c.kind === "dm" ? dmAvatar(c) : channelIcon(c)),
      h("span.chat-item-name", channelTitle(c), partner && partner.id === me().id ? h("span.muted", " (you)") : null),
      c.muted ? icon("bell-off", { size: 13, cls: "chat-item-mute" }) : null,
      c.mentions ? h("span.chat-item-badge", c.mentions > 99 ? "99+" : String(c.mentions)) : null);
    };
    const section = (key, title, list, addTitle, onAdd) => {
      const shown = list.filter(match);
      if (!shown.length && f) return null;
      const collapsed = this.collapsed.has(key) && !f;
      const unread = collapsed ? shown.filter((c) => c.unread && !c.muted) : [];
      return h("div.chat-sec",
        h("div.chat-sec-head",
          h("button.chat-sec-toggle", { type: "button", "aria-expanded": String(!collapsed), onclick: () => this.toggleSection(key) },
            icon(collapsed ? "chevron-right" : "chevron-down", { size: 13 }), title),
          onAdd ? h("button.icon-btn.sm", { type: "button", title: addTitle, "aria-label": addTitle, onclick: onAdd }, icon("plus", { size: 14 })) : null),
        h("div.chat-sec-list", (collapsed ? unread : shown).map(item),
          !shown.length ? h("p.chat-sec-empty", key === "dm" ? "No conversations yet" : "Nothing here yet") : null));
    };
    const filterInput = h("input.chat-filter", {
      type: "search", placeholder: "Find a conversation", value: this.filter, "aria-label": "Find a conversation",
      oninput: (e) => { this.filter = e.target.value; this.renderSide(); this.side.querySelector(".chat-filter").focus(); },
      onkeydown: (e) => {
        if (e.key === "Enter") { const first = this.side.querySelector(".chat-item"); if (first) this.open(Number(first.dataset.id)); }
      },
    });
    const live = realtime.connected;
    const archived = this.channels.filter((c) => c.archived);
    clear(this.side,
      h("div.chat-side-head",
        h("strong", "Chat"),
        h(`span.live-dot${live ? ".on" : ""}`, { title: live ? "Live" : "Reconnecting…" }),
        h("div.chat-side-actions",
          h("button.icon-btn", { type: "button", title: "Chat settings", "aria-label": "Chat settings", onclick: (e) => this.prefsMenu(e.currentTarget) }, icon("settings", { size: 17 })),
          h("button.icon-btn", { type: "button", title: "Search messages", "aria-label": "Search messages", onclick: () => this.openPanel({ kind: "search" }) }, icon("search", { size: 17 })),
          h("button.icon-btn", { type: "button", title: "New message", "aria-label": "New message", onclick: () => this.newDm() }, icon("compose", { size: 17 })))),
      h("div.chat-side-filter", icon("search", { size: 14 }), filterInput),
      h("nav.chat-side-scroll", { "aria-label": "Conversations" },
        this.mySpace(f),
        section("project", "Projects", this.sorted("project"), "Browse project channels", me().role === "admin" ? () => this.browse() : null),
        section("channel", "Channels", this.sorted("channel"), isAdmin() ? "Add a channel" : "Browse channels", (e) => (isAdmin() ? this.channelMenu(e.currentTarget) : this.browse())),
        section("dm", "Direct messages", this.sorted("dm"), "New message", () => this.newDm()),
        archived.length ? section("archived", "Archived", archived, null, null) : null),
      h("div.chat-side-foot",
        h("button.btn.ghost.sm", { type: "button", onclick: () => this.browse() }, icon("hash", { size: 14 }), "Browse channels")));
  }

  prefsMenu(anchor) {
    const flip = (key, on, off) => () => {
      prefs.set(key, !prefs.get(key));
      toast(prefs.get(key) ? on : off);
      if (key === "sounds" && prefs.get(key)) sounds.test();
    };
    const tick = (key) => (prefs.get(key) ? "On" : "Off");
    const canAsk = "Notification" in window && Notification.permission !== "granted";
    menu(anchor, [
      { icon: prefs.get("sounds") ? "volume" : "volume-off", label: "Message sounds", hint: tick("sounds"), run: flip("sounds", "Message sounds on", "Message sounds off") },
      { icon: "phone", label: "Call ringtone", hint: tick("ringtone"), run: flip("ringtone", "Ringtone on", "Ringtone off") },
      { icon: "sparkles", label: "Animated effects", hint: tick("effects"), run: flip("effects", "Emoji effects on 🎉", "Effects off") },
      { icon: "bell", label: "Play a test sound", run: () => sounds.test() },
      canAsk ? {
        icon: "bell", label: "Desktop notifications", hint: Notification.permission === "denied" ? "Blocked" : "Off",
        run: async () => {
          if (Notification.permission === "denied") { toast("Notifications are blocked - allow them in the browser's site settings", "error"); return; }
          const p = await Notification.requestPermission();
          toast(p === "granted" ? "Desktop notifications on" : "Desktop notifications stay off");
        },
      } : null,
    ]);
  }

  mySpace(f) {
    const self = this.channels.find(isSelf);
    if (f && !"notes to self saved items links".includes(f.toLowerCase())) return null;
    const savedOpen = this.panel?.kind === "saved";
    return h("div.chat-sec.my-space",
      h("div.chat-sec-head", h("span.chat-sec-toggle.static", "My space")),
      h("div.chat-sec-list",
        h(`a.chat-item.space-item${self && this.current?.id === self.id ? ".active" : ""}`, {
          href: self ? `#/chat/${self.id}` : "#/chat", title: "Notes, links and files only you can see",
          onclick: (e) => { e.preventDefault(); this.openSelf(); },
        }, h("span.chat-item-ic.space-ic.notes", icon("edit", { size: 14 })), h("span.chat-item-name", "Notes to self")),
        h(`a.chat-item.space-item${savedOpen ? ".active" : ""}`, {
          href: "#/chat", title: "Messages, files and links you saved",
          onclick: (e) => { e.preventDefault(); this.openPanel({ kind: "saved", filter: "all" }); this.renderSide(); },
        }, h("span.chat-item-ic.space-ic.saved", icon("bookmark", { size: 14 })), h("span.chat-item-name", "Saved items"),
        shared.saved.size ? h("span.space-count", String(shared.saved.size)) : null)));
  }

  toggleSection(key) {
    if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
    safeSet("chat.collapsed", JSON.stringify([...this.collapsed]));
    this.renderSide();
  }

  channelMenu(anchor) {
    menu(anchor, [
      { icon: "plus", label: "Create a channel", run: () => this.createChannel() },
      { icon: "hash", label: "Browse channels", run: () => this.browse() },
    ]);
  }

  notifyPermissionHint() {
    if (!("Notification" in window) || Notification.permission !== "default") return;
    const foot = this.side.querySelector(".chat-side-foot");
    foot?.prepend(h("button.btn.ghost.sm.notify-hint", {
      type: "button",
      onclick: async (e) => {
        const p = await Notification.requestPermission();
        e.currentTarget?.remove();
        toast(p === "granted" ? "Desktop notifications on for mentions and direct messages" : "Desktop notifications stay off");
      },
    }, icon("bell", { size: 14 }), "Enable desktop notifications"));
  }

  renderWelcome() {
    clear(this.mainEl, h("div.chat-welcome",
      emptyState("Welcome to team chat", "Talk with your project teams in real time, start a channel, or message someone directly.",
        h("div.row.gap", h("button.btn.primary", { onclick: () => this.newDm() }, icon("compose", { size: 15 }), "New message"),
          isAdmin() ? h("button.btn", { onclick: () => this.createChannel() }, icon("plus", { size: 15 }), "Create a channel") : null), "message")));
  }

  // ---------------------------------------------------------------- open a conversation
  async open(id, { around = null, push = true } = {}) {
    closePop();
    let ch = this.channels.find((c) => c.id === id);
    try {
      if (!ch || ch.kind === "project" || !ch.joined) ch = { ...(ch || {}), ...(await api.get(`/chat/channels/${id}`)) };
    } catch (err) {
      clear(this.mainEl, errorBox(err));
      return;
    }
    if (push) history.replaceState(null, "", `#/chat/${id}`);
    safeSet(LAST_KEY, String(id));
    this.current = ch;
    shared.viewing = document.hidden ? null : id;
    this.messages = [];
    this.msgEls.clear();
    this.members = [];
    this.firstUnreadId = null;
    this.el.classList.add("has-current");
    if (this.panel?.kind !== "search") this.closePanel();
    this.renderSide();
    this.renderMain();
    this.loadMembers();
    await this.loadInitial(around);
  }

  async loadMembers() {
    const ch = this.current;
    try {
      const list = await api.get(`/chat/channels/${ch.id}/members`);
      if (this.current?.id === ch.id) {
        this.members = list;
        this.renderHeader();
        if (this.panel?.kind === "members") this.renderPanel();
      }
    } catch { /* header just shows no avatars */ }
  }

  candidates() {
    const list = this.members.length ? this.members : [...shared.users.values()];
    return list.filter((u) => u.id !== me().id && u.is_active !== false);
  }

  renderMain() {
    const ch = this.current;
    this.headerEl = h("header.chat-head");
    this.scrollEl = h("div.chat-scroll", { role: "log", "aria-live": "polite", "aria-label": `Messages in ${channelTitle(ch)}` });
    this.listEl = h("div.chat-list");
    this.topEl = h("div.chat-top");
    this.scrollEl.append(this.topEl, this.listEl);
    this.typingEl = h("div.chat-typing", { "aria-live": "polite" });
    this.jumpEl = h("button.chat-jump", { type: "button", hidden: true, onclick: () => this.jumpToLatest() }, icon("chevron-down", { size: 14 }), h("span", "Jump to latest"));
    this.scrollEl.addEventListener("scroll", () => this.onScroll(), { passive: true });

    let footer;
    if (ch.archived) {
      footer = h("div.chat-banner", icon("archive", { size: 16 }), h("span", "This conversation is archived. You can read it but not post."),
        ch.can_manage ? h("button.btn.sm", { onclick: () => this.patchChannel({ archived: false }, "Unarchived") }, "Unarchive") : null);
    } else if (!ch.can_post) {
      footer = h("div.chat-banner.join", h("span", "You're previewing ", h("strong", `#${ch.name || channelTitle(ch)}`), "."),
        h("button.btn.primary.sm", { onclick: (e) => busy(e.currentTarget, () => this.join()) }, "Join channel"));
    } else {
      this.composer = composer({
        channelId: ch.id,
        placeholder: isSelf(ch) ? "Jot a note, paste a link or drop a file…" : ch.kind === "dm" ? `Message ${ch.display_name}` : `Message ${ch.kind === "project" ? ch.display_name : "#" + ch.name}`,
        candidates: () => this.candidates(),
        onSend: (body, files) => this.send(body, files, null),
        onEditLast: () => this.editLast(),
      });
      footer = this.composer.el;
    }
    const dropHint = h("div.chat-drop", h("div", icon("upload", { size: 28 }), h("strong", "Drop files to share them")));
    const main = [this.headerEl, h("div.chat-body", this.scrollEl, this.jumpEl, dropHint), this.typingEl, footer];
    clear(this.mainEl, ...main);
    this.renderHeader();
    this.listEl.append(spinner(5));
    this.installDrop(dropHint);
    setTimeout(() => this.composer?.focus(), 0);
  }

  installDrop(hint) {
    let depth = 0;
    const has = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    this.mainEl.ondragenter = (e) => { if (!has(e) || !this.composer) return; depth++; hint.classList.add("on"); e.preventDefault(); };
    this.mainEl.ondragover = (e) => { if (has(e) && this.composer) e.preventDefault(); };
    this.mainEl.ondragleave = () => { depth = Math.max(0, depth - 1); if (!depth) hint.classList.remove("on"); };
    this.mainEl.ondrop = (e) => {
      if (!has(e) || !this.composer) return;
      e.preventDefault();
      depth = 0;
      hint.classList.remove("on");
      this.composer.addFiles(e.dataTransfer.files);
    };
  }

  renderHeader() {
    const ch = this.current;
    if (!ch || !this.headerEl) return;
    const partner = dmPartner(ch);
    const pinned = this.messages.filter((m) => m.pinned).length;
    const people = this.members.slice(0, 3);
    const titleBtn = h("button.chat-title", { type: "button", onclick: () => this.openPanel({ kind: "details" }), title: "Conversation details" },
      ch.kind === "dm" ? dmAvatar(ch) : h("span.chat-title-ic", channelIcon(ch, 18)),
      h("span.chat-title-text", channelTitle(ch)),
      icon("chevron-down", { size: 14 }));
    const sub = isSelf(ch)
      ? h("span.chat-sub", icon("lock", { size: 11 }), " Only you can see this")
      : ch.kind === "dm"
      ? (partner ? h("span.chat-sub", shared.online.has(partner.id) ? h("span.pres-word.on", "Online") : h("span.pres-word", "Away"),
        partner.designation || userById(partner.id)?.designation ? ` · ${partner.designation || userById(partner.id)?.designation}` : "") : h("span.chat-sub", `${(ch.members || []).length} people`))
      : h("button.chat-topic", { type: "button", title: ch.topic ? "Edit topic" : "Add a topic", onclick: () => this.editTopic(), disabled: !ch.can_post }, ch.topic || (ch.can_post ? "Add a topic" : ""));
    const action = (ic, title, run, extra) => h("button.icon-btn", { type: "button", title, "aria-label": title, onclick: run }, icon(ic, { size: 17 }), extra);
    const live = activeCalls.get(ch.id);
    const mine = currentCall()?.channel_id === ch.id;
    const label = ch.kind === "dm" ? ch.display_name : channelTitle(ch);
    const isDm = ch.kind === "dm" && (ch.members || []).length <= 2;
    const callButtons = !ch.can_post || isSelf(ch) ? null : live
      ? h(`button.btn.sm.call-join${mine ? ".in" : ""}`, {
        type: "button", onclick: () => joinCall(live.id, { video: false, label, channelId: ch.id }),
        title: mine ? "Show the call" : "Join the call",
      }, h("span.call-join-dot"), icon(live.video ? "video" : "phone", { size: 14 }), mine ? "In call" : `Join call · ${live.participant_ids?.length || 1}`)
      : [
        action("phone", isDm ? `Call ${label}` : "Start an audio call", () => this.call(false)),
        action("video", isDm ? `Video call ${label}` : "Start a video call", () => this.call(true)),
      ];
    clear(this.headerEl,
      h("button.icon-btn.chat-back", { type: "button", "aria-label": "Back to conversations", onclick: () => this.el.classList.remove("has-current") }, icon("chevron-left", { size: 18 })),
      h("div.chat-head-main", titleBtn, sub),
      h("div.chat-head-actions",
        ch.kind !== "dm" ? h("button.chat-people", { type: "button", title: "Members", onclick: () => this.openPanel({ kind: "members" }) },
          h("span.avatars", people.map((u) => avatar(u, "sm"))), h("span", String(ch.member_count ?? this.members.length))) : null,
        callButtons,
        callButtons ? h("span.head-sep") : null,
        action("pin", "Pinned messages", () => this.openPanel({ kind: "pins" }), pinned ? h("span.head-count", String(pinned)) : null),
        action("paperclip", "Files", () => this.openPanel({ kind: "files" })),
        action("link", "Links", () => this.openPanel({ kind: "links" })),
        action("search", "Search this conversation", () => this.openPanel({ kind: "search", channel: ch.id })),
        action(ch.muted ? "bell-off" : "bell", ch.muted ? "Unmute" : "Mute", () => this.toggleMute()),
        h("button.icon-btn", { type: "button", title: "More", "aria-label": "More", onclick: (e) => this.moreMenu(e.currentTarget) }, icon("more", { size: 17 }))));
  }

  call(video) {
    const ch = this.current;
    const isDm = ch.kind === "dm" && (ch.members || []).length <= 2;
    if (callsSupported() && !isDm && (ch.member_count || 0) > 2) toast(`Calling everyone in ${channelTitle(ch)} - they'll hear a ring`);
    startCall(ch.id, { video, label: ch.kind === "dm" ? ch.display_name : channelTitle(ch), dm: isDm });
  }

  moreMenu(anchor) {
    const ch = this.current;
    menu(anchor, [
      { icon: "check", label: "Mark as read", run: () => this.markRead(true) },
      { icon: "link", label: "Copy link", run: () => copyText(`${location.origin}${location.pathname}#/chat/${ch.id}`, "Link copied") },
      ch.kind !== "dm" && ch.can_post ? { icon: "edit", label: ch.topic ? "Edit topic" : "Add a topic", run: () => this.editTopic() } : null,
      ch.kind === "channel" && ch.can_manage ? { icon: "edit", label: "Rename channel", run: () => this.rename() } : null,
      ch.kind === "channel" && isAdmin() ? { icon: "user", label: "Add people", run: () => this.addPeople() } : null,
      ch.kind === "project" && ch.project_id ? { icon: "folder", label: "Open project", run: () => { location.hash = `#/projects/${ch.project_id}`; } } : null,
      "-",
      ch.kind !== "dm" && ch.can_manage ? { icon: "archive", label: ch.archived ? "Unarchive" : "Archive", danger: !ch.archived, run: () => this.archive() } : null,
      ch.kind === "channel" && ch.joined ? { icon: "logout", label: "Leave channel", danger: true, run: () => this.leave() } : null,
      ch.kind === "project" && ch.joined && me().role === "admin" && !this.members.some((u) => u.id === me().id && u.role !== "admin")
        ? { icon: "logout", label: "Leave channel", danger: true, run: () => this.leave() } : null,
    ]);
  }

  // ---------------------------------------------------------------- loading messages
  async loadInitial(around) {
    const ch = this.current;
    try {
      const page = await api.get(`/chat/channels/${ch.id}/messages`, around ? { around, limit: 60 } : { limit: 50 });
      if (this.current?.id !== ch.id) return;
      this.messages = page.messages;
      this.hasMore = page.has_more;
      this.hasNewer = page.has_newer;
      const firstUnread = this.messages.find((m) => m.id > ch.last_read_id && m.user?.id !== me().id);
      this.firstUnreadId = ch.joined && firstUnread ? firstUnread.id : null;
      this.renderList();
      this.renderHeader();
      if (around) this.highlight(around);
      else if (this.firstUnreadId && this.unreadCountAbove() > 4) this.msgEls.get(this.firstUnreadId)?.previousElementSibling?.scrollIntoView({ block: "start" });
      else this.scrollToBottom();
      this.maybeMarkRead();
    } catch (err) {
      clear(this.listEl, errorBox(err));
    }
  }

  unreadCountAbove() {
    return this.messages.filter((m) => this.firstUnreadId && m.id >= this.firstUnreadId).length;
  }

  async loadOlder() {
    if (this.loading || !this.hasMore || !this.messages.length) return;
    this.loading = true;
    const ch = this.current;
    this.topEl.replaceChildren(h("div.chat-loading", h("span.spin"), "Loading earlier messages…"));
    try {
      const page = await api.get(`/chat/channels/${ch.id}/messages`, { before: this.messages[0].id, limit: 50 });
      if (this.current?.id !== ch.id) return;
      const before = this.scrollEl.scrollHeight - this.scrollEl.scrollTop;
      this.messages = [...page.messages, ...this.messages];
      this.hasMore = page.has_more;
      this.renderList();
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight - before;
    } catch (err) { toast(err.message, "error"); } finally {
      this.loading = false;
    }
  }

  async loadNewer() {
    if (this.loading || !this.hasNewer || !this.messages.length) return;
    this.loading = true;
    const ch = this.current;
    try {
      const page = await api.get(`/chat/channels/${ch.id}/messages`, { after: this.messages.at(-1).id, limit: 100 });
      if (this.current?.id !== ch.id) return;
      const known = new Set(this.messages.map((m) => m.id));
      this.messages.push(...page.messages.filter((m) => !known.has(m.id)));
      this.hasNewer = page.has_newer;
      this.renderList(true);
    } catch (err) { toast(err.message, "error"); } finally {
      this.loading = false;
    }
  }

  async jumpToLatest() {
    if (this.hasNewer) {
      this.hasNewer = false;
      await this.loadInitial(null);
    } else this.scrollToBottom(true);
    this.jumpEl.hidden = true;
  }

  onScroll() {
    const el = this.scrollEl;
    if (el.scrollTop < 300) this.loadOlder();
    const nearBottom = this.atBottom();
    if (nearBottom && this.hasNewer) this.loadNewer();
    if (nearBottom && !this.hasNewer) { this.jumpEl.hidden = true; this.jumpEl.classList.remove("new"); }
    else if (el.scrollHeight - el.scrollTop - el.clientHeight > 600 || this.hasNewer) this.jumpEl.hidden = false;
    if (nearBottom) this.maybeMarkRead();
  }

  atBottom(slack = 80) {
    const el = this.scrollEl;
    return el && el.scrollHeight - el.scrollTop - el.clientHeight < slack;
  }

  scrollToBottom(smooth = false) {
    const el = this.scrollEl;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  highlight(id) {
    const el = this.msgEls.get(id);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 2400);
  }

  // ---------------------------------------------------------------- rendering messages
  intro() {
    const ch = this.current;
    const partner = dmPartner(ch);
    let title;
    let text;
    if (ch.kind === "dm") {
      title = isSelf(ch) ? "Notes to self" : ch.display_name;
      text = isSelf(ch)
        ? "Only you can see this. Jot notes, paste links, drop documents and pin what matters - Links, Files and Pinned (top right) keep them one click away."
        : `This is the very beginning of your conversation with ${ch.display_name}.`;
    } else if (ch.kind === "project") {
      title = `Welcome to ${ch.display_name}`;
      text = "Everyone in the project is here. Talk tickets (PAY-12 links itself), share files and keep decisions in one place.";
    } else {
      title = `Welcome to #${ch.name}`;
      text = ch.topic || `This is the start of the ${ch.is_private ? "private" : ""} #${ch.name} channel.`;
    }
    return h("div.chat-intro",
      h("div.chat-intro-ic", ch.kind === "dm" ? (partner ? avatar(partner, "lg") : icon("users", { size: 26 })) : channelIcon(ch, 26)),
      h("h2", title), h("p.muted", text));
  }

  renderList(keepScroll = false) {
    const top = this.scrollEl.scrollTop;
    this.msgEls.clear();
    const nodes = [];
    if (!this.hasMore) nodes.push(this.intro());
    let prev = null;
    for (const m of this.messages) {
      nodes.push(...this.separators(prev, m));
      const el = this.renderMessage(m, prev);
      this.msgEls.set(m.id, el);
      nodes.push(el);
      prev = m;
    }
    this.listEl.replaceChildren(...nodes);
    this.topEl.replaceChildren(this.hasMore ? h("div.chat-loading.idle", "Scroll up for earlier messages") : "");
    if (keepScroll) this.scrollEl.scrollTop = top;
  }

  separators(prev, m) {
    const out = [];
    const d = parseDate(m.created_at);
    const pd = prev && parseDate(prev.created_at);
    if (!pd || d.toDateString() !== pd.toDateString()) out.push(h("div.day-sep", h("span", dayLabel(d))));
    if (m.id === this.firstUnreadId) out.push(h("div.unread-sep", h("span", "New")));
    return out;
  }

  grouped(prev, m) {
    if (!prev || !prev.user || !m.user || prev.user.id !== m.user.id || prev.deleted || m.deleted || prev.call || m.call) return false;
    if (m.id === this.firstUnreadId) return false;
    const a = parseDate(prev.created_at);
    const b = parseDate(m.created_at);
    return b - a < GROUP_MS && a.toDateString() === b.toDateString() && !prev.reply_count;
  }

  renderMessage(m, prev, { inThread = false } = {}) {
    const isMe = m.user?.id === me().id;
    const grouped = !inThread ? this.grouped(prev, m) : (prev && this.grouped(prev, m));
    const d = parseDate(m.created_at);
    const time = h("a.msg-time", {
      href: `#/chat/${m.channel_id}?m=${m.parent_id || m.id}`, title: fullFmt.format(d),
      onclick: (e) => { e.preventDefault(); copyText(`${location.origin}${location.pathname}#/chat/${m.channel_id}?m=${m.parent_id || m.id}`, "Link to message copied"); },
    }, timeFmt.format(d));
    const cls = [
      "msg", grouped && "grouped", isMe && "mine", m.pinned && "pinned", m.deleted && "deleted",
      !isMe && mentionsMe(m.body) && "mentioned",
    ].filter(Boolean).join(".");
    const body = m.deleted
      ? h("p.msg-deleted", icon("trash", { size: 13 }), "This message was deleted.")
      : m.call ? this.callCard(m.call) : m.body ? renderBody(m.body) : null;
    const el = h(`div.${cls}`, { dataset: { id: m.id }, tabindex: "-1" },
      h("div.msg-gutter", grouped ? h("span.msg-gtime", timeFmt.format(d)) : (m.user ? presenceAvatar(m.user, "") : avatar(null))),
      h("div.msg-main",
        grouped ? null : h("div.msg-head",
          h("strong.msg-author", m.user?.name || "Deleted user"),
          m.user && userById(m.user.id)?.role === "admin" ? h("span.msg-tag", "Admin") : null,
          time,
          m.pinned ? h("span.msg-pin", icon("pin", { size: 12 }), "Pinned") : null,
          shared.saved.has(m.id) ? h("span.msg-saved", { title: "In your saved items" }, icon("bookmark", { size: 12 }), "Saved") : null),
        grouped && m.pinned ? h("span.msg-pin", icon("pin", { size: 12 }), "Pinned") : null,
        h("div.msg-body", body, m.edited_at && !m.deleted ? h("span.msg-edited", { title: `Edited ${fullFmt.format(parseDate(m.edited_at))}` }, "(edited)") : null),
        this.renderFiles(m),
        this.renderReactions(m),
        !inThread && m.reply_count ? this.threadSummary(m) : null),
      m.deleted ? null : this.actions(m, inThread));
    return el;
  }

  callCard(c) {
    const inIt = currentCall()?.id === c.id;
    const n = c.participant_ids.length;
    const kind = c.video ? "Video call" : "Audio call";
    const status = c.active
      ? `In progress · ${n} ${n === 1 ? "person" : "people"}`
      : c.answered_at ? `Ended · lasted ${fmtDuration(c.duration_seconds || 0)}` : (c.started_by === me().id ? "No answer" : "Missed call");
    const ch = this.current;
    const label = ch?.kind === "dm" ? ch.display_name : channelTitle(ch || {});
    const missed = !c.active && !c.answered_at;
    return h(`div.call-card${c.active ? ".live" : ""}${missed ? ".missed" : ""}`,
      h("span.call-card-ic", icon(c.video ? "video" : "phone", { size: 18 })),
      h("div.call-card-meta", h("strong", c.active ? `${kind} started` : missed && c.started_by !== me().id ? `Missed ${kind.toLowerCase()}` : kind), h("span.muted.small", status)),
      c.active ? h("span.avatars", c.participant_ids.slice(0, 4).map((id) => avatar(userById(id) || { id, name: "?", email: String(id) }, "sm"))) : null,
      c.active && !inIt && ch?.can_post ? h("button.btn.primary.sm", { type: "button", onclick: () => joinCall(c.id, { video: false, label, channelId: c.channel_id }) }, icon("phone", { size: 14 }), "Join")
        : inIt ? h("span.msg-tag.ok", "You're in this call")
          : !c.active && ch?.can_post ? h("button.btn.sm", { type: "button", onclick: () => this.call(c.video) }, icon(c.video ? "video" : "phone", { size: 14 }), "Call back") : null);
  }

  renderFiles(m) {
    if (!m.files?.length) return null;
    const images = m.files.filter((f) => f.is_image);
    const others = m.files.filter((f) => !f.is_image);
    const open = (f) => previewChatFiles(m.files, m.files.indexOf(f), m.user?.name);
    return h("div.msg-files",
      images.length ? h(`div.msg-images${images.length > 1 ? ".multi" : ""}`, images.map((f) => {
        const img = h("img", { alt: f.filename, loading: "lazy" });
        const btn = h("button.msg-image", { type: "button", title: `Preview ${f.filename}`, onclick: () => open(f) }, img);
        fileUrl(f.id, true).then((u) => {
          const stick = this.atBottom(120);
          img.src = u;
          img.onload = () => { if (stick) this.scrollToBottom(); };
        }).catch(() => btn.replaceWith(this.fileCard(f, m.files, m.files.indexOf(f))));
        return btn;
      })) : null,
      others.length ? h("div.msg-docs", others.map((f) => this.fileCard(f, m.files, m.files.indexOf(f), m.user?.name))) : null);
  }

  /** A previewable file card; `list` lets ← → move between the files around it. */
  fileCard(f, list = [f], index = 0, meta) {
    return previewCard(list.map((x) => previewFiles.chat(x, x.user?.name || meta)), index);
  }

  renderReactions(m) {
    if (!m.reactions?.length) return null;
    return h("div.msg-reactions",
      m.reactions.map((r) => {
        const mine = r.user_ids.includes(me().id);
        const names = r.user_ids.map((id) => (id === me().id ? "You" : userById(id)?.name || "Someone"));
        return h(`button.reaction${mine ? ".mine" : ""}`, {
          type: "button", title: `${names.join(", ")} reacted with ${r.emoji}`, "aria-pressed": String(mine),
          onclick: () => this.react(m, r.emoji),
        }, h("span.reaction-e", r.emoji), h("span.reaction-n", String(r.count)));
      }),
      this.current?.can_post ? h("button.reaction.add", { type: "button", title: "Add reaction", "aria-label": "Add reaction", onclick: (e) => emojiPicker(e.currentTarget, (em) => this.react(m, em)) }, icon("smile", { size: 14 }), icon("plus", { size: 10 })) : null);
  }

  threadSummary(m) {
    return h("button.thread-sum", { type: "button", onclick: () => this.openThread(m.id) },
      h("span.thread-sum-n", `${m.reply_count} ${m.reply_count === 1 ? "reply" : "replies"}`),
      m.last_reply_at ? h("span.thread-sum-t", `Last reply ${timeAgo(m.last_reply_at)}`) : null,
      h("span.thread-sum-go", "View thread", icon("chevron-right", { size: 13 })));
  }

  actions(m, inThread) {
    const ch = this.current;
    const isMe = m.user?.id === me().id;
    const canPost = ch?.can_post;
    const bar = h("div.msg-actions", { role: "toolbar", "aria-label": "Message actions" },
      canPost ? QUICK_REACTIONS.slice(0, 3).map((e) => h("button.ma.ma-emoji", { type: "button", title: `React ${e}`, onclick: () => this.react(m, e) }, e)) : null,
      canPost ? h("button.ma", { type: "button", title: "Add reaction", "aria-label": "Add reaction", onclick: (e) => emojiPicker(e.currentTarget, (em) => this.react(m, em)) }, icon("smile", { size: 16 })) : null,
      !inThread && canPost ? h("button.ma", { type: "button", title: "Reply in thread", "aria-label": "Reply in thread", onclick: () => this.openThread(m.id) }, icon("message", { size: 16 })) : null,
      h(`button.ma${shared.saved.has(m.id) ? ".on" : ""}`, {
        type: "button", title: shared.saved.has(m.id) ? "Remove from saved" : "Save for later", "aria-label": "Save for later",
        onclick: () => this.toggleSave(m),
      }, icon("bookmark", { size: 16 })),
      h("button.ma", {
        type: "button", title: "More actions", "aria-label": "More actions",
        onclick: (e) => menu(e.currentTarget, [
          isMe && canPost && !m.call ? { icon: "edit", label: "Edit message", run: () => this.startEdit(m) } : null,
          !inThread && canPost ? { icon: "message", label: "Reply in thread", run: () => this.openThread(m.id) } : null,
          canPost ? { icon: "pin", label: m.pinned ? "Unpin" : "Pin to conversation", run: () => this.pin(m) } : null,
          { icon: "bookmark", label: shared.saved.has(m.id) ? "Remove from saved" : "Save for later", run: () => this.toggleSave(m) },
          !inThread && !isMe ? { icon: "eye-off", label: "Mark unread from here", run: () => this.markUnread(m) } : null,
          { icon: "link", label: "Copy link", run: () => copyText(`${location.origin}${location.pathname}#/chat/${m.channel_id}?m=${m.parent_id || m.id}`, "Link copied") },
          m.body ? { icon: "copy", label: "Copy text", run: () => copyText(m.body, "Text copied") } : null,
          m.user && !isMe ? { icon: "compose", label: `Message ${m.user.name.split(" ")[0]}`, run: () => this.dmWith([m.user.id]) } : null,
          (isMe || ch?.can_manage) ? "-" : null,
          (isMe || ch?.can_manage) ? { icon: "trash", label: "Delete message", danger: true, run: () => this.remove(m) } : null,
        ]),
      }, icon("more", { size: 16 })));
    return bar;
  }

  // ---------------------------------------------------------------- applying live events
  onChannels(list) {
    if (!this.side) return;
    this.channels = list;
    if (this.current) {
      const fresh = list.find((c) => c.id === this.current.id);
      if (fresh) {
        const changed = fresh.archived !== this.current.archived || fresh.can_post !== this.current.can_post;
        this.current = { ...this.current, ...fresh, last_read_id: this.current.last_read_id };
        if (changed) { this.renderMain(); this.renderList(); this.scrollToBottom(); } else this.renderHeader();
      }
    }
    this.renderSide();
    this.maybeMarkRead();
  }

  onPresence() {
    if (!this.side) return;
    this.renderSide();
    this.renderHeader();
    this.listEl?.querySelectorAll(".msg").forEach((el) => {
      const m = this.messages.find((x) => x.id === Number(el.dataset.id));
      const dot = el.querySelector(".msg-gutter .pres-dot");
      if (m?.user && dot) dot.classList.toggle("on", shared.online.has(m.user.id));
    });
    if (this.panel?.kind === "members") this.renderPanel();
  }

  onEvent(ev) {
    if (!this.side) return;
    if (ev.type === "_open" || ev.type === "_close") {
      this.side?.querySelector(".live-dot")?.classList.toggle("on", ev.type === "_open");
      if (ev.type === "_open" && this.current && this.messages.length && !this.hasNewer) this.catchUp();
      return;
    }
    const ch = this.current;
    if (ev.type === "typing") return this.onTyping(ev);
    if (!ch || ev.channel_id !== ch.id) return;
    switch (ev.type) {
      case "message.new": return this.onNew(ev.message);
      case "message.update": return this.onUpdate(ev.message);
      case "message.delete": return this.onDelete(ev.id, ev.parent_id);
      case "read":
        ch.last_read_id = Math.max(ch.last_read_id, ev.last_read_id);
        return undefined;
      case "channels":
        this.loadMembers();
        return undefined;
      default: return undefined;
    }
  }

  async catchUp() {
    // after a reconnect: fetch anything that arrived while we were offline
    const ch = this.current;
    try {
      const page = await api.get(`/chat/channels/${ch.id}/messages`, { after: this.messages.at(-1).id, limit: 100 });
      if (this.current?.id !== ch.id) return;
      page.messages.forEach((m) => this.onNew(m));
      if (page.has_newer) { this.hasNewer = true; this.jumpEl.hidden = false; }
    } catch { /* next event will do */ }
  }

  onNew(m) {
    const typing = this.typing.get(m.channel_id);
    if (typing?.delete(m.user?.id)) this.renderTyping();
    if (m.parent_id) {
      if (this.thread?.parent.id === m.parent_id && !this.thread.replies.some((r) => r.id === m.id)) {
        const stick = this.threadAtBottom();
        this.thread.replies.push(m);
        this.renderThreadList();
        if (stick || m.user?.id === me().id) this.threadScrollBottom();
      }
      return;
    }
    if (this.hasNewer || this.messages.some((x) => x.id === m.id)) return;
    const stick = this.atBottom(140) || m.user?.id === me().id;
    const prev = this.messages.at(-1);
    this.messages.push(m);
    const intro = this.listEl.querySelector(".chat-intro, .skeleton-block");
    if (intro?.classList.contains("skeleton-block")) intro.remove();
    for (const sep of this.separators(prev, m)) this.listEl.append(sep);
    const el = this.renderMessage(m, prev);
    el.classList.add("arrive");
    const trigger = !m.call && (m.body || "").match(BURST);
    if (trigger) emojiBurst(this.mainEl.querySelector(".chat-body"), trigger[0], { count: isEmojiOnly((m.body || "").trim()) ? 26 : 14 });
    this.msgEls.set(m.id, el);
    this.listEl.append(el);
    if (stick) { this.scrollToBottom(true); this.maybeMarkRead(); } else if (m.user?.id !== me().id) {
      this.jumpEl.hidden = false;
      this.jumpEl.classList.add("new");
      this.jumpEl.querySelector("span").textContent = "New messages";
    }
  }

  onUpdate(m) {
    if (this.thread) {
      if (this.thread.parent.id === m.id) { this.thread.parent = m; this.renderThreadParent(); }
      const i = this.thread.replies.findIndex((r) => r.id === m.id);
      if (i >= 0) { this.thread.replies[i] = m; this.renderThreadList(); }
    }
    const i = this.messages.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    this.messages[i] = m;
    const old = this.msgEls.get(m.id);
    if (old?.querySelector(".msg-edit")) return; // being edited right now; refresh after
    const el = this.renderMessage(m, this.messages[i - 1]);
    this.msgEls.set(m.id, el);
    old?.replaceWith(el);
    this.renderHeader();
    if (this.panel?.kind === "pins") this.renderPanel();
  }

  onDelete(id, parentId) {
    if (this.thread) {
      if (this.thread.parent.id === id) { this.closePanel(); toast("The thread was deleted"); } else {
        const before = this.thread.replies.length;
        this.thread.replies = this.thread.replies.filter((r) => r.id !== id);
        if (before !== this.thread.replies.length) this.renderThreadList();
      }
    }
    if (parentId) return;
    const i = this.messages.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.messages.splice(i, 1);
    const keep = this.scrollEl.scrollTop;
    this.renderList();
    this.scrollEl.scrollTop = keep;
  }

  onTyping(ev) {
    if (ev.user_id === me().id) return;
    if (!this.typing.has(ev.channel_id)) this.typing.set(ev.channel_id, new Map());
    this.typing.get(ev.channel_id).set(ev.user_id, { name: ev.name, parent_id: ev.parent_id, until: Date.now() + TYPING_MS });
    this.renderTyping();
  }

  renderTyping() {
    const now = Date.now();
    const describe = (list) => {
      if (!list.length) return "";
      const names = list.map((t) => t.name.split(" ")[0]);
      if (names.length === 1) return `${names[0]} is typing`;
      if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
      return "Several people are typing";
    };
    let changed = false;
    for (const map of this.typing.values()) {
      for (const [uid, t] of map) if (t.until < now) { map.delete(uid); changed = true; }
    }
    const here = [...(this.typing.get(this.current?.id)?.values() || [])];
    const main = here.filter((t) => !t.parent_id);
    const thread = here.filter((t) => this.thread && t.parent_id === this.thread.parent.id);
    const paint = (el, list) => {
      if (!el) return;
      const text = describe(list);
      if (el.dataset.text === text) return;
      el.dataset.text = text;
      clear(el, text ? [h("span.typing-dots", h("i"), h("i"), h("i")), h("span", text)] : null);
    };
    paint(this.typingEl, main);
    paint(this.panelEl?.querySelector(".thread-typing"), thread);
    return changed;
  }

  // ---------------------------------------------------------------- read state
  maybeMarkRead() {
    const ch = this.current;
    if (!ch || !this.scrollEl || document.hidden || (!ch.joined && ch.kind !== "project")) return;
    if (!this.atBottom(120) || this.hasNewer) return;
    const last = [...this.messages].reverse().find((m) => !m.deleted);
    if (!last || last.id <= ch.last_read_id) {
      this.clearLocalUnread();
      return;
    }
    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => this.markRead(false), 350);
  }

  async markRead(all) {
    const ch = this.current;
    const last = this.messages.at(-1);
    if (!ch || !last) return;
    ch.last_read_id = Math.max(ch.last_read_id, last.id);
    this.clearLocalUnread();
    try {
      await api.post(`/chat/channels/${ch.id}/read`, { message_id: last.id });
      if (all) toast("Marked as read");
    } catch { /* retried on next scroll */ }
  }

  clearLocalUnread() {
    const ch = this.current;
    const local = this.channels.find((c) => c.id === ch.id);
    if (local && (local.unread || local.mentions)) {
      local.unread = 0;
      local.mentions = 0;
      shared.channels.set(local.id, local);
      this.renderSide();
      paintBadge();
    }
  }

  async markUnread(m) {
    const ch = this.current;
    await busy(null, async () => {
      await api.post(`/chat/channels/${ch.id}/read`, { message_id: m.id, unread: true });
      ch.last_read_id = m.id - 1;
      this.firstUnreadId = m.id;
      this.renderList(true);
      toast("Marked unread - it will stay unread until you come back");
      shared.viewing = null;
      refreshBadgeSoon(0);
    });
  }

  // ---------------------------------------------------------------- actions
  async send(body, files, parentId) {
    const ch = this.current;
    const form = new FormData();
    form.append("body", body);
    if (parentId) form.append("parent_id", String(parentId));
    files.forEach((f) => form.append("files", f, f.name));
    const m = await api.upload(`/chat/channels/${ch.id}/messages`, form);
    if (this.current?.id !== ch.id) return;
    if (parentId) {
      this.onNew(m);
    } else {
      this.onNew(m);
      ch.last_read_id = Math.max(ch.last_read_id, m.id);
      this.scrollToBottom(true);
    }
  }

  async react(m, emoji) {
    try {
      const updated = await api.post(`/chat/messages/${m.id}/reactions`, { emoji });
      this.onUpdate(updated);
      const r = updated.reactions.find((x) => x.emoji === emoji);
      if (r?.user_ids.includes(me().id)) {
        const scope = this.msgEls.get(m.id) || this.panelEl;
        const chip = [...scope.querySelectorAll(".reaction")].find((b) => b.querySelector(".reaction-e")?.textContent === emoji);
        reactionPop(chip, emoji);
      }
    } catch (err) { toast(err.message, "error"); }
  }

  async toggleSave(m) {
    try {
      const r = await api.post(`/chat/messages/${m.id}/save`);
      if (r.saved) shared.saved.add(m.id); else shared.saved.delete(m.id);
      this.onUpdate(this.messages.find((x) => x.id === m.id) || m);
      this.renderSide();
      toast(r.saved ? "Saved - find it under My space › Saved items" : "Removed from saved");
      if (this.panel?.kind === "saved") this.renderPanel();
    } catch (err) { toast(err.message, "error"); }
  }

  async openSelf() {
    try {
      const ch = await api.post("/chat/self");
      if (!this.channels.some((c) => c.id === ch.id)) this.channels.push(ch);
      await this.open(ch.id);
    } catch (err) { toast(err.message, "error"); }
  }

  async pin(m) {
    try {
      const updated = await api.post(`/chat/messages/${m.id}/pin`);
      this.onUpdate(updated);
      toast(updated.pinned ? "Pinned to the conversation" : "Unpinned");
    } catch (err) { toast(err.message, "error"); }
  }

  async remove(m) {
    if (!(await confirmDialog("Delete message", "Delete this message for everyone? This cannot be undone."))) return;
    try {
      await api.del(`/chat/messages/${m.id}`);
      if (m.reply_count) return; // the server keeps a placeholder; the update event redraws it
      this.onDelete(m.id, m.parent_id);
    } catch (err) { toast(err.message, "error"); }
  }

  editLast() {
    const mine = [...this.messages].reverse().find((m) => m.user?.id === me().id && !m.deleted && !m.call);
    if (!mine) return false;
    this.startEdit(mine);
    return true;
  }

  startEdit(m) {
    const el = this.msgEls.get(m.id) || this.panelEl.querySelector(`.msg[data-id="${m.id}"]`);
    const bodyEl = el?.querySelector(".msg-body");
    if (!bodyEl) return;
    const ta = h("textarea.msg-edit-input", { rows: 2, value: m.body });
    ta.value = m.body;
    const cancel = () => this.onUpdate(m.parent_id ? m : this.messages.find((x) => x.id === m.id) || m);
    const save = async () => {
      const text = ta.value.trim();
      if (!text) return toast("A message cannot be empty - delete it instead", "error");
      if (text === m.body) return cancel();
      try {
        const updated = await api.patch(`/chat/messages/${m.id}`, { body: text });
        bodyEl.closest(".msg").querySelector(".msg-edit")?.remove();
        this.onUpdate(updated);
      } catch (err) { toast(err.message, "error"); }
      return undefined;
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); bodyEl.closest(".msg").querySelector(".msg-edit")?.remove(); cancel(); }
    });
    const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 300)}px`; };
    ta.addEventListener("input", grow);
    bodyEl.replaceChildren(h("div.msg-edit", ta,
      h("div.msg-edit-bar", h("span.muted.small", "Escape to cancel · Enter to save"),
        h("button.btn.sm", { type: "button", onclick: () => { bodyEl.closest(".msg").querySelector(".msg-edit")?.remove(); cancel(); } }, "Cancel"),
        h("button.btn.primary.sm", { type: "button", onclick: save }, "Save"))));
    setTimeout(() => { grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    el.scrollIntoView({ block: "nearest" });
  }

  async toggleMute() {
    const ch = this.current;
    try {
      const r = await api.post(`/chat/channels/${ch.id}/mute`, { muted: !ch.muted });
      ch.muted = r.muted;
      const local = this.channels.find((c) => c.id === ch.id);
      if (local) local.muted = r.muted;
      this.renderHeader();
      this.renderSide();
      toast(r.muted ? "Muted - no badges or desktop alerts except @mentions" : "Unmuted");
    } catch (err) { toast(err.message, "error"); }
  }

  async patchChannel(patch, message) {
    const ch = this.current;
    try {
      const fresh = await api.patch(`/chat/channels/${ch.id}`, patch);
      this.current = { ...ch, ...fresh };
      const i = this.channels.findIndex((c) => c.id === ch.id);
      if (i >= 0) this.channels[i] = { ...this.channels[i], ...fresh };
      if (message) toast(message);
      if ("archived" in patch) { this.renderMain(); this.renderList(); this.scrollToBottom(); }
      this.renderHeader();
      this.renderSide();
      if (this.panel?.kind === "details") this.renderPanel();
    } catch (err) { toast(err.message, "error"); }
  }

  editTopic() {
    const ch = this.current;
    const input = h("textarea", { rows: 3, maxLength: 300, placeholder: "What is this conversation about?" });
    input.value = ch.topic || "";
    const form = h("form.form", field("Topic", input, "Shown under the name. Up to 300 characters."),
      h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Save")));
    const m = modal(ch.topic ? "Edit topic" : "Add a topic", form);
    form.addEventListener("submit", async (e) => { e.preventDefault(); await this.patchChannel({ topic: input.value }, "Topic updated"); m.close(); });
  }

  rename() {
    const ch = this.current;
    const input = h("input", { value: ch.name, required: true, maxLength: 80 });
    const form = h("form.form", field("Channel name", input, "Lower-case letters, numbers, - and _"),
      h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Rename")));
    const m = modal("Rename channel", form);
    form.addEventListener("submit", async (e) => { e.preventDefault(); await this.patchChannel({ name: input.value }, "Renamed"); m.close(); });
  }

  async archive() {
    const ch = this.current;
    if (!ch.archived && !(await confirmDialog("Archive conversation", `Archive ${channelTitle(ch)}? Nobody can post, but everything stays readable and it can be unarchived.`, "Archive"))) return;
    await this.patchChannel({ archived: !ch.archived }, ch.archived ? "Unarchived" : "Archived");
  }

  async leave() {
    const ch = this.current;
    if (!(await confirmDialog("Leave channel", `Leave ${channelTitle(ch)}?${ch.is_private ? " It's private - you'll need someone to add you back." : ""}`, "Leave"))) return;
    try {
      await api.post(`/chat/channels/${ch.id}/leave`);
      this.channels = this.channels.filter((c) => c.id !== ch.id);
      this.current = null;
      this.el.classList.remove("has-current");
      this.renderSide();
      const next = this.pickDefault();
      if (next) this.open(next); else this.renderWelcome();
      toast(`Left ${channelTitle(ch)}`);
    } catch (err) { toast(err.message, "error"); }
  }

  async join() {
    const ch = this.current;
    const fresh = await api.post(`/chat/channels/${ch.id}/join`);
    this.channels = await api.get("/chat/channels");
    this.current = { ...ch, ...fresh };
    this.renderMain();
    this.renderList();
    this.scrollToBottom();
    this.renderSide();
    toast(`Joined ${channelTitle(ch)}`);
  }

  // ---------------------------------------------------------------- dialogs
  peopleChooser(initial = [], { exclude = [] } = {}) {
    const chosen = new Map(initial.map((u) => [u.id, u]));
    const chips = h("div.people-chips");
    const input = h("input", { type: "search", placeholder: "Type a name or email…", autocomplete: "off", "aria-label": "Search people" });
    const list = h("ul.people-list", { role: "listbox" });
    const skip = new Set([me().id, ...exclude]);
    const paintChips = () => clear(chips, [...chosen.values()].map((u) => h("span.person-chip", avatar(u, "sm"), u.name,
      h("button", { type: "button", "aria-label": `Remove ${u.name}`, onclick: () => { chosen.delete(u.id); paintChips(); paintList(); } }, icon("x", { size: 12 })))));
    const paintList = () => {
      const q = input.value.trim().toLowerCase();
      const people = [...shared.users.values()].filter((u) => !skip.has(u.id) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))).slice(0, 50);
      clear(list, people.map((u) => h(`li${chosen.has(u.id) ? ".on" : ""}`, {
        role: "option", "aria-selected": String(chosen.has(u.id)),
        onclick: () => { if (chosen.has(u.id)) chosen.delete(u.id); else chosen.set(u.id, u); paintChips(); paintList(); input.focus(); },
      }, presenceAvatar(u), h("span.pl-name", u.name, h("span.muted.small", u.designation || u.email)), h("span.pl-check", icon("check", { size: 14 })))),
      !people.length ? h("li.muted.none", "No one found") : null);
    };
    input.addEventListener("input", paintList);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); list.querySelector("li[role=option]")?.click(); input.value = ""; paintList(); } });
    paintChips();
    paintList();
    return { el: h("div.people-chooser", chips, input, list), chosen: () => [...chosen.keys()], input };
  }

  newDm() {
    const chooser = this.peopleChooser();
    const go = h("button.btn.primary", { type: "submit" }, "Open conversation");
    const form = h("form.form", h("p.muted.small", "Pick one person for a direct message, or several for a small group (up to 8)."), chooser.el, h("div.form-actions", go));
    const m = modal("New message", form);
    setTimeout(() => chooser.input.focus(), 0);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const ids = chooser.chosen();
      if (!ids.length) return toast("Choose at least one person", "error");
      busy(go, async () => { await this.dmWith(ids); m.close(); });
      return undefined;
    });
  }

  async dmWith(ids) {
    const ch = await api.post("/chat/dm", { user_ids: ids });
    if (!this.channels.some((c) => c.id === ch.id)) this.channels.push(ch);
    await this.open(ch.id);
  }

  createChannel() {
    const name = h("input", { name: "name", required: true, maxLength: 80, placeholder: "e.g. design-reviews" });
    const topic = h("input", { name: "topic", maxLength: 300, placeholder: "What's it for? (optional)" });
    const priv = h("input", { type: "checkbox" });
    const chooser = this.peopleChooser();
    const preview = h("span.muted.small");
    name.addEventListener("input", () => { preview.textContent = name.value.trim() ? `#${name.value.trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")}` : ""; });
    const go = h("button.btn.primary", { type: "submit" }, "Create channel");
    const form = h("form.form",
      field("Name", name, preview), field("Topic", topic),
      h("label.check.private-toggle", priv, h("span", h("strong", "Make private"), h("span.muted.small", "Only invited people can find and read it."))),
      h("div.field", h("span.field-label", "Add people (optional)"), chooser.el),
      h("div.form-actions", go));
    const m = modal("Create a channel", form, { wide: true });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(go, async () => {
        const ch = await api.post("/chat/channels", { name: name.value, topic: topic.value, is_private: priv.checked, member_ids: chooser.chosen() });
        m.close();
        this.channels = await api.get("/chat/channels");
        await this.open(ch.id);
        toast(`#${ch.name} created`);
      });
    });
  }

  addPeople() {
    const ch = this.current;
    const chooser = this.peopleChooser([], { exclude: this.members.map((u) => u.id) });
    const go = h("button.btn.primary", { type: "submit" }, "Add");
    const form = h("form.form", chooser.el, h("div.form-actions", go));
    const m = modal(`Add people to #${ch.name}`, form);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const ids = chooser.chosen();
      if (!ids.length) return m.close();
      busy(go, async () => {
        this.members = await api.post(`/chat/channels/${ch.id}/members`, { user_ids: ids });
        ch.member_count = this.members.length;
        m.close();
        this.renderHeader();
        if (this.panel?.kind === "members") this.renderPanel();
        toast(`Added ${ids.length} ${ids.length === 1 ? "person" : "people"}`);
      });
      return undefined;
    });
  }

  async browse() {
    const listEl = h("div.browse-list", spinner(4));
    const search = h("input", { type: "search", placeholder: "Search channels", "aria-label": "Search channels" });
    const m = modal("Browse channels", h("div.browse", h("div.row.gap", search,
      isAdmin() ? h("button.btn.sm", { type: "button", onclick: () => { m.close(); this.createChannel(); } }, icon("plus", { size: 14 }), "Create") : null), listEl), { wide: true });
    let all = [];
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const rows = all.filter((c) => !q || channelTitle(c).toLowerCase().includes(q) || (c.topic || "").toLowerCase().includes(q));
      clear(listEl, rows.length ? rows.map((c) => h("div.browse-row",
        h("span.browse-ic", channelIcon(c, 18)),
        h("div.browse-meta",
          h("strong", channelTitle(c), c.archived ? h("span.msg-tag", "Archived") : null, c.joined ? h("span.msg-tag.ok", "Joined") : null),
          h("span.muted.small", [c.topic, `${c.member_count ?? 0} member${c.member_count === 1 ? "" : "s"}`].filter(Boolean).join(" · "))),
        h("div.browse-actions",
          h("button.btn.sm", { type: "button", onclick: () => { m.close(); this.open(c.id); } }, "View"),
          !c.joined && !c.archived ? h("button.btn.primary.sm", {
            type: "button",
            onclick: (e) => busy(e.currentTarget, async () => {
              await api.post(`/chat/channels/${c.id}/join`);
              m.close();
              this.channels = await api.get("/chat/channels");
              await this.open(c.id);
              toast(`Joined ${channelTitle(c)}`);
            }),
          }, "Join") : null))) : emptyState("No channels found", isAdmin() ? "Create one for a topic, a team or a launch." : "Ask an admin to create a channel.", null, "hash"));
    };
    search.addEventListener("input", paint);
    try { all = await api.get("/chat/channels/browse"); paint(); } catch (err) { clear(listEl, errorBox(err)); }
    search.focus();
  }

  // ---------------------------------------------------------------- right panel
  openPanel(panel) {
    if (panel.kind === "thread" || this.panel?.kind !== panel.kind || panel.channel !== this.panel?.channel) {
      this.panel = panel;
      if (panel.kind !== "thread") this.thread = null;
      this.renderPanel();
    } else this.closePanel();
  }

  closePanel() {
    this.panel = null;
    this.thread = null;
    this.panelEl.hidden = true;
    this.el.classList.remove("has-panel");
    this.panelEl.replaceChildren();
  }

  panelShell(title, sub, ...body) {
    this.panelEl.hidden = false;
    this.panelEl.classList.remove("is-thread");
    this.el.classList.add("has-panel");
    clear(this.panelEl,
      h("header.panel-head",
        h("div", h("strong", title), sub ? h("span.muted.small", sub) : null),
        h("button.icon-btn", { type: "button", "aria-label": "Close panel", onclick: () => this.closePanel() }, icon("x", { size: 18 }))),
      h("div.panel-body", ...body));
  }

  async renderPanel() {
    const p = this.panel;
    const ch = this.current;
    if (!p) return;
    if (p.kind === "members") {
      const online = this.members.filter((u) => shared.online.has(u.id)).length;
      this.panelShell("Members", `${this.members.length} · ${online} online`,
        ch.kind === "channel" && isAdmin() ? h("button.btn.sm.panel-add", { type: "button", onclick: () => this.addPeople() }, icon("plus", { size: 14 }), "Add people") : null,
        h("ul.member-list", this.members.map((u) => h("li",
          presenceAvatar(u, ""),
          h("div.member-meta", h("strong", u.name, u.id === me().id ? h("span.muted", " (you)") : null), h("span.muted.small", u.designation || u.email)),
          u.role !== "member" ? h(`span.msg-tag${u.role === "owner" ? ".ok" : ""}`, u.role === "owner" ? (ch.kind === "project" ? "Owner" : "Creator") : "Admin") : null,
          h("div.member-actions",
            u.id !== me().id ? h("button.icon-btn.sm", { type: "button", title: `Message ${u.name}`, onclick: () => this.dmWith([u.id]) }, icon("message", { size: 14 })) : null,
            ch.kind === "channel" && isAdmin() && u.id !== me().id ? h("button.icon-btn.sm", {
              type: "button", title: `Remove ${u.name}`,
              onclick: async () => {
                if (!(await confirmDialog("Remove member", `Remove ${u.name} from #${ch.name}?`, "Remove"))) return;
                await busy(null, async () => { await api.del(`/chat/channels/${ch.id}/members/${u.id}`); await this.loadMembers(); });
              },
            }, icon("x", { size: 14 })) : null)))));
    } else if (p.kind === "pins") {
      this.panelShell("Pinned", channelTitle(ch), spinner(3));
      try {
        const pins = await api.get(`/chat/channels/${ch.id}/pins`);
        if (this.panel !== p) return;
        clear(this.panelEl.querySelector(".panel-body"), pins.length ? pins.map((m) => this.resultCard(m))
          : emptyState("Nothing pinned yet", "Pin important messages from the ⋯ menu so everyone can find them.", null, "pin"));
      } catch (err) { clear(this.panelEl.querySelector(".panel-body"), errorBox(err)); }
    } else if (p.kind === "files") {
      this.panelShell("Files", channelTitle(ch), spinner(3));
      try {
        const files = await api.get(`/chat/channels/${ch.id}/files`);
        if (this.panel !== p) return;
        const images = files.filter((f) => f.is_image);
        const docs = files.filter((f) => !f.is_image);
        clear(this.panelEl.querySelector(".panel-body"), files.length ? [
          images.length ? h("div.panel-gallery", images.map((f) => {
            const img = h("img", { alt: f.filename });
            fileUrl(f.id, true).then((u) => { img.src = u; }).catch(() => {});
            return h("button.gallery-cell", { type: "button", title: f.filename, onclick: () => previewChatFiles(images, images.indexOf(f)) }, img);
          })) : null,
          docs.map((f) => h("div.panel-file", this.fileCard(f, docs, docs.indexOf(f)), h("span.muted.small", `${f.user?.name || "Someone"} · ${timeAgo(f.created_at)}`),
            h("button.link.small", { type: "button", onclick: () => this.goTo(ch.id, f.message_id) }, "Show in chat"))),
        ] : emptyState("No files yet", "Drag files into the conversation or paste a screenshot.", null, "paperclip"));
      } catch (err) { clear(this.panelEl.querySelector(".panel-body"), errorBox(err)); }
    } else if (p.kind === "links") {
      this.panelShell("Links", channelTitle(ch), spinner(3));
      try {
        const links = await api.get(`/chat/channels/${ch.id}/links`);
        if (this.panel !== p) return;
        const filter = h("input.panel-search", { type: "search", placeholder: "Filter links", "aria-label": "Filter links" });
        const listEl = h("div.link-list");
        const paint = () => {
          const q = filter.value.trim().toLowerCase();
          const shown = links.filter((l) => !q || l.url.toLowerCase().includes(q) || (l.text || "").toLowerCase().includes(q));
          clear(listEl, shown.map((l) => h("div.link-item", linkRow(l, h("button.icon-btn.sm", { type: "button", title: "Show in chat", "aria-label": "Show in chat", onclick: () => this.goTo(ch.id, l.parent_id || l.message_id) }, icon("message", { size: 14 }))),
            h("span.muted.small.link-by", `${l.user?.name || "Someone"} · ${timeAgo(l.created_at)}${l.pinned ? " · 📌 pinned" : ""}`))),
          !shown.length ? h("p.muted.small", "No matching links.") : null);
        };
        filter.addEventListener("input", paint);
        clear(this.panelEl.querySelector(".panel-body"), links.length ? [filter, listEl]
          : emptyState("No links yet", isSelf(ch) ? "Paste a link here to keep it - it shows up in this list." : "Links shared in this conversation collect here.", null, "link"));
        if (links.length) paint();
      } catch (err) { clear(this.panelEl.querySelector(".panel-body"), errorBox(err)); }
    } else if (p.kind === "saved") {
      const chips = h("div.chips.seg", [["all", "All"], ["links", "Links"], ["files", "Files"]].map(([k, t]) =>
        h("button.chip", { type: "button", "aria-pressed": String(p.filter === k), onclick: () => { this.panel = { ...p, filter: k }; this.renderPanel(); } }, t)));
      const search = h("input.panel-search", { type: "search", placeholder: "Search saved items", value: p.q || "", "aria-label": "Search saved items" });
      const listEl = h("div.saved-list", spinner(3));
      this.panelShell("Saved items", "Only you can see these", chips, search, listEl);
      const load = async () => {
        try {
          const items = await api.get("/chat/saved", { kind: p.filter || "all", q: search.value.trim() || undefined });
          if (this.panel !== p) return;
          clear(listEl, items.length ? items.map((m) => this.savedCard(m))
            : emptyState(search.value.trim() ? "Nothing matches" : "Nothing saved yet",
              search.value.trim() ? "Try other words." : "Hover any message and press the bookmark, or use ⋯ › Save for later. Files and links you save land here too.", null, "bookmark"));
        } catch (err) { clear(listEl, errorBox(err)); }
      };
      let timer;
      search.addEventListener("input", () => { p.q = search.value; clearTimeout(timer); timer = setTimeout(load, 250); });
      load();
    } else if (p.kind === "search") {
      const input = h("input.panel-search", { type: "search", placeholder: p.channel ? `Search in ${channelTitle(ch)}` : "Search all messages", value: p.q || "", "aria-label": "Search messages" });
      const results = h("div.search-results", p.q ? spinner(3) : h("p.muted.small.search-hint", "Search words across messages. Results only include conversations you can read."));
      const scope = h("div.chips.seg",
        h("button.chip", { type: "button", "aria-pressed": String(!p.channel), onclick: () => { this.panel = { ...p, channel: null, q: input.value }; this.renderPanel(); } }, "Everywhere"),
        ch ? h("button.chip", { type: "button", "aria-pressed": String(Boolean(p.channel)), onclick: () => { this.panel = { ...p, channel: ch.id, q: input.value }; this.renderPanel(); } }, "This conversation") : null);
      this.panelShell("Search", null, input, scope, results);
      let timer;
      const run = async () => {
        const q = input.value.trim();
        p.q = q;
        if (!q) return clear(results);
        clear(results, spinner(3));
        try {
          const found = await api.get("/chat/search", { q, channel_id: p.channel || undefined });
          if (this.panel !== p || p.q !== q) return undefined;
          clear(results, found.length ? [h("p.muted.small", `${found.length}${found.length === 50 ? "+" : ""} result${found.length === 1 ? "" : "s"}`), found.map((m) => this.resultCard(m, q))]
            : emptyState("No matches", "Try other words.", null, "search"));
        } catch (err) { clear(results, errorBox(err)); }
        return undefined;
      };
      input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 250); });
      setTimeout(() => input.focus(), 0);
      if (p.q) run();
    } else if (p.kind === "details") {
      const created = ch.kind === "channel" && ch.created_by ? userById(ch.created_by) : null;
      this.panelShell("Details", null,
        h("div.details-hero", ch.kind === "dm" ? dmAvatar(ch) : h("span.details-ic", channelIcon(ch, 24)), h("h3", channelTitle(ch)),
          h("span.muted.small", ch.kind === "project" ? `Project channel · ${ch.project_key}` : ch.kind === "dm" ? "Direct message" : ch.is_private ? "Private channel" : "Public channel")),
        ch.kind !== "dm" ? h("div.details-block", h("span.field-label", "Topic"), h("p", ch.topic || h("span.muted", "No topic")),
          ch.can_post ? h("button.link.small", { type: "button", onclick: () => this.editTopic() }, "Edit") : null) : null,
        created ? h("div.details-block", h("span.field-label", "Created by"), h("p", created.name)) : null,
        h("div.details-actions",
          h("button.btn.sm", { type: "button", onclick: () => this.openPanel({ kind: "members" }) }, icon("users", { size: 14 }), "Members"),
          h("button.btn.sm", { type: "button", onclick: () => this.openPanel({ kind: "pins" }) }, icon("pin", { size: 14 }), "Pinned"),
          h("button.btn.sm", { type: "button", onclick: () => this.openPanel({ kind: "files" }) }, icon("paperclip", { size: 14 }), "Files"),
          h("button.btn.sm", { type: "button", onclick: () => this.openPanel({ kind: "links" }) }, icon("link", { size: 14 }), "Links"),
          h("button.btn.sm", { type: "button", onclick: () => this.toggleMute() }, icon(ch.muted ? "bell" : "bell-off", { size: 14 }), ch.muted ? "Unmute" : "Mute"),
          ch.kind === "project" ? h("a.btn.sm", { href: `#/projects/${ch.project_id}` }, icon("folder", { size: 14 }), "Open project") : null));
    } else if (p.kind === "thread") {
      await this.renderThreadPanel();
    }
  }

  savedCard(m) {
    const where = m.channel.kind === "channel" ? `#${m.channel.display_name}` : (m.channel.kind === "dm" && m.channel.display_name.endsWith("(you)") ? "Notes to self" : m.channel.display_name);
    const body = m.body ? renderBody(m.body) : null;
    const filesList = m.files?.length ? h("div.saved-files", m.files.map((f, i) => this.fileCard(f, m.files, i, m.user?.name))) : null;
    const links = m.links?.length ? h("div.saved-links", m.links.slice(0, 5).map((l) => linkRow(l))) : null;
    return h("div.saved-card",
      h("div.result-head", avatar(m.user, "sm"), h("strong", m.user?.name || "Someone"), h("span.muted.small", `in ${where}`),
        h("span.muted.small.result-time", { title: `Saved ${timeAgo(m.saved_at)}` }, timeAgo(m.created_at))),
      body ? h("div.result-body", body) : null,
      filesList, links,
      h("div.saved-actions",
        h("button.btn.sm", { type: "button", onclick: () => this.goTo(m.channel_id, m.parent_id || m.id) }, icon("message", { size: 14 }), "Open in chat"),
        h("button.btn.ghost.sm", { type: "button", onclick: () => this.toggleSave(m) }, icon("bookmark", { size: 14 }), "Remove")));
  }

  resultCard(m, q) {
    const where = m.channel ? (m.channel.kind === "channel" ? `#${m.channel.display_name}` : m.channel.display_name) : null;
    const body = renderBody(m.body || "");
    if (q) markWords(body, q);
    return h("button.result-card", { type: "button", onclick: () => this.goTo(m.channel_id, m.parent_id || m.id) },
      h("div.result-head", avatar(m.user, "sm"), h("strong", m.user?.name || "Someone"), where ? h("span.muted.small", `in ${where}`) : null,
        h("span.muted.small.result-time", timeAgo(m.created_at))),
      h("div.result-body", body),
      m.files?.length ? h("span.muted.small", icon("paperclip", { size: 12 }), ` ${m.files.length} file${m.files.length === 1 ? "" : "s"}`) : null);
  }

  async goTo(channelId, messageId) {
    if (this.current?.id === channelId && this.msgEls.has(messageId)) return this.highlight(messageId);
    const keep = this.panel?.kind === "search" ? this.panel : null;
    await this.open(channelId, { around: messageId });
    if (keep) { this.panel = keep; this.renderPanel(); }
    return undefined;
  }

  // ---------------------------------------------------------------- threads
  async openThread(id) {
    this.panel = { kind: "thread", id };
    this.panelShell("Thread", channelTitle(this.current), spinner(4));
    try {
      this.thread = await api.get(`/chat/messages/${id}/thread`);
      if (this.panel?.id !== id) return;
      this.renderThreadPanel();
    } catch (err) { clear(this.panelEl.querySelector(".panel-body"), errorBox(err)); }
  }

  renderThreadPanel() {
    if (!this.thread) return;
    const ch = this.current;
    this.threadParentEl = h("div.thread-parent");
    this.threadListEl = h("div.thread-list");
    this.threadScrollEl = h("div.thread-scroll", this.threadParentEl, this.threadListEl);
    const comp = ch.can_post ? composer({
      channelId: ch.id, parentId: this.thread.parent.id, placeholder: "Reply…",
      candidates: () => this.candidates(),
      onSend: (body, files, parentId) => this.send(body, files, parentId),
    }) : null;
    this.panelShell("Thread", channelTitle(ch), this.threadScrollEl, h("div.thread-typing"), comp?.el);
    this.panelEl.classList.add("is-thread");
    this.renderThreadParent();
    this.renderThreadList();
    this.threadScrollBottom();
    setTimeout(() => comp?.focus(), 0);
  }

  renderThreadParent() {
    if (!this.threadParentEl) return;
    const n = this.thread.replies.length;
    clear(this.threadParentEl, this.renderMessage(this.thread.parent, null, { inThread: true }),
      h("div.thread-count", h("span", `${n} ${n === 1 ? "reply" : "replies"}`)));
  }

  renderThreadList() {
    if (!this.threadListEl) return;
    let prev = null;
    clear(this.threadListEl, this.thread.replies.map((m) => { const el = this.renderMessage(m, prev, { inThread: true }); prev = m; return el; }));
    const count = this.threadParentEl?.querySelector(".thread-count span");
    if (count) count.textContent = `${this.thread.replies.length} ${this.thread.replies.length === 1 ? "reply" : "replies"}`;
  }

  threadAtBottom() {
    const el = this.threadScrollEl;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  threadScrollBottom() {
    const el = this.threadScrollEl;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // ---------------------------------------------------------------- keyboard
  handleKey(e) {
    if (document.querySelector(".backdrop, .pal-backdrop") || e.target.closest?.(".call-ui, .call-ring")) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const items = [...this.side.querySelectorAll(".chat-item")];
      const i = items.findIndex((a) => Number(a.dataset.id) === this.current?.id);
      const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
      if (next) { e.preventDefault(); this.open(Number(next.dataset.id)); }
      return;
    }
    if (e.key === "Escape" && this.panel && !e.target.closest?.("textarea, input")) { this.closePanel(); return; }
    // typing anywhere in the view goes to the composer
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && !e.target.closest?.("input, textarea, select, [contenteditable]")
      && this.composer && !openPop && (document.activeElement === document.body || this.root.contains(document.activeElement))) {
      this.composer.focus();
    }
  }
}

function markWords(root, q) {
  const words = q.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return;
  const re = new RegExp(`(${words.join("|")})`, "gi");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = node.textContent.split(re);
    if (parts.length === 1) continue;
    node.replaceWith(...parts.map((p, i) => (i % 2 ? h("mark", p) : document.createTextNode(p))));
  }
}

function safeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function safeSet(key, value) { try { localStorage.setItem(key, value); } catch { /* per-viewer only */ } }
