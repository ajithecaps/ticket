// Markdown: rendering (GFM + extras) and the editor.
//
// Rendering: marked (GFM tables, task lists, strikethrough, autolinks) + footnotes, ==highlight==,
// $math$ / $$math$$ (KaTeX), ```mermaid diagrams, syntax-highlighted code with a copy button,
// GitHub-style callouts (> [!NOTE]), <details> sections, :emoji: shortcodes, heading anchors and
// ticket keys (PAY-12) as links. Everything is sanitised with DOMPurify; heavy libraries (highlight.js,
// KaTeX, Mermaid) are loaded only when a note actually uses them.
import { clear, copyText, h, modal, toast } from "./ui.js";

const VENDOR = "/static/vendor";

// ----------------------------------------------------------------------------- lazy loading
const loaded = new Map();
function loadScript(file) {
  if (!loaded.has(file)) {
    loaded.set(file, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${VENDOR}/${file}`;
      s.onload = resolve;
      s.onerror = () => { loaded.delete(file); reject(new Error(`Could not load ${file}`)); };
      document.head.append(s);
    }));
  }
  return loaded.get(file);
}
function loadCss(file) {
  if (!loaded.has(file)) {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = `${VENDOR}/${file}`;
    document.head.append(l);
    loaded.set(file, Promise.resolve());
  }
  return loaded.get(file);
}

const isDark = () => document.documentElement.dataset.theme === "dark"
  || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);

// ----------------------------------------------------------------------------- marked setup
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let configured = false;
function setup() {
  if (configured) return;
  configured = true;
  const { marked } = window;
  if (window.markedFootnote) marked.use(window.markedFootnote({ description: "Footnotes" }));
  marked.use({
    gfm: true,
    breaks: true,
    extensions: [
      {
        name: "mathBlock", level: "block",
        start: (src) => src.match(/^\$\$/m)?.index,
        tokenizer(src) {
          const m = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n|$)/.exec(src);
          if (m) return { type: "mathBlock", raw: m[0], tex: m[1].trim() };
          return undefined;
        },
        renderer: (t) => `<div class="md-math" data-display="1" data-tex="${esc(t.tex)}">${esc(t.tex)}</div>\n`,
      },
      {
        name: "mathInline", level: "inline",
        start: (src) => src.indexOf("$"),
        tokenizer(src) {
          const m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src);
          if (m) return { type: "mathInline", raw: m[0], tex: m[1] };
          return undefined;
        },
        renderer: (t) => `<span class="md-math" data-tex="${esc(t.tex)}">${esc(t.tex)}</span>`,
      },
      {
        name: "mark", level: "inline",
        start: (src) => src.indexOf("=="),
        tokenizer(src) {
          const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
          if (m) return { type: "mark", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
          return undefined;
        },
        renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; },
      },
    ],
    renderer: {
      code(code, infostring) {
        const lang = (infostring || "").trim().split(/\s+/)[0].toLowerCase();
        if (lang === "mermaid") return `<div class="md-mermaid" data-src="${esc(code)}"><pre>${esc(code)}</pre></div>\n`;
        return `<pre class="md-code" data-lang="${esc(lang)}"><code class="${lang ? `language-${esc(lang)}` : ""}">${esc(code)}</code></pre>\n`;
      },
    },
  });

  window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") || "";
      if (/^https?:/i.test(href)) { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
    }
    if (node.tagName === "INPUT" && node.getAttribute("type") !== "checkbox") node.remove();
  });
}

// ----------------------------------------------------------------------------- post-processing
// Project keys the viewer can see; "PAY-12" only becomes a link when PAY is one of them.
let projectKeys = null;
export function setProjectKeys(keys) { projectKeys = new Set(keys.map((k) => k.toUpperCase())); }

const EMOJI = {
  smile: "😄", grin: "😁", joy: "😂", wink: "😉", heart: "❤️", thumbsup: "👍", "+1": "👍", thumbsdown: "👎", "-1": "👎",
  ok_hand: "👌", clap: "👏", pray: "🙏", tada: "🎉", rocket: "🚀", fire: "🔥", bug: "🐛", sparkles: "✨", star: "⭐",
  warning: "⚠️", x: "❌", white_check_mark: "✅", heavy_check_mark: "✔️", check: "✔️", question: "❓", exclamation: "❗",
  bulb: "💡", memo: "📝", pushpin: "📌", link: "🔗", lock: "🔒", key: "🔑", hammer: "🔨", wrench: "🔧", gear: "⚙️",
  construction: "🚧", rotating_light: "🚨", zap: "⚡", hourglass: "⏳", calendar: "📅", chart: "📈", eyes: "👀",
  thinking: "🤔", see_no_evil: "🙈", muscle: "💪", coffee: "☕", lipstick: "💄", recycle: "♻️", art: "🎨", boom: "💥",
  heavy_plus_sign: "➕", heavy_minus_sign: "➖", arrow_right: "➡️", arrow_left: "⬅️", arrow_up: "⬆️", arrow_down: "⬇️",
  red_circle: "🔴", green_circle: "🟢", yellow_circle: "🟡", blue_circle: "🔵", 100: "💯", wave: "👋", rocket_ship: "🚀",
};
const CALLOUTS = {
  NOTE: ["note", "ℹ️", "Note"], TIP: ["tip", "💡", "Tip"], IMPORTANT: ["important", "❗", "Important"],
  WARNING: ["warning", "⚠️", "Warning"], CAUTION: ["caution", "🛑", "Caution"],
};
const slug = (s) => s.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80) || "section";

function textNodes(root, skip = "code, pre, a, .md-math, .md-mermaid") {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) if (!walker.currentNode.parentElement.closest(skip)) out.push(walker.currentNode);
  return out;
}

function replaceInText(root, re, make) {
  for (const node of textNodes(root)) {
    const text = node.textContent;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = [];
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      const made = make(m);
      if (!made) continue;
      if (m.index > last) frag.push(document.createTextNode(text.slice(last, m.index)));
      frag.push(made);
      last = m.index + m[0].length;
    }
    if (!frag.length) continue;
    if (last < text.length) frag.push(document.createTextNode(text.slice(last)));
    node.replaceWith(...frag);
  }
}

/** Positions of task checkboxes in the source, ignoring fenced code (matches the rendered order). */
function taskOffsets(src) {
  const out = [];
  let fence = null;
  let offset = 0;
  for (const line of src.split("\n")) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) fence = fence ? (f[1][0] === fence[0] && f[1].length >= fence.length ? null : fence) : f[1];
    else if (!fence) {
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)\]/.exec(line);
      if (m) out.push(offset + m[1].length);
    }
    offset += line.length + 1;
  }
  return out;
}

function enhance(el, source, { onTaskToggle } = {}) {
  // Callouts: > [!NOTE] ...
  el.querySelectorAll("blockquote").forEach((bq) => {
    const p = bq.firstElementChild;
    const m = p && p.tagName === "P" && /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(p.textContent);
    if (!m) return;
    const [kind, icon, title] = CALLOUTS[m[1].toUpperCase()];
    const first = p.firstChild;
    if (first?.nodeType === 3) first.textContent = first.textContent.replace(/^\s*\[![A-Z]+\]\s*/i, "");
    // drop the line break (and empty text) that followed the [!KIND] marker
    while (p.firstChild && ((p.firstChild.nodeType === 3 && !p.firstChild.textContent.trim()) || p.firstChild.nodeName === "BR")) p.firstChild.remove();
    if (!p.textContent.trim() && !p.querySelector("img")) p.remove();
    bq.classList.add("md-callout", `md-callout-${kind}`);
    bq.prepend(h("div.md-callout-title", h("span", icon), title));
  });

  // Headings: ids + hover anchors (scrolling is handled below; real #hashes would fight the router).
  const used = new Set();
  el.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((hd) => {
    let id = slug(hd.textContent);
    while (used.has(id)) id += "-1";
    used.add(id);
    hd.id = `md-${id}`;
    hd.append(h("a.md-anchor", { href: `#md-${id}`, "aria-label": "Link to this section" }, "#"));
  });

  // Tables scroll sideways instead of stretching the page.
  el.querySelectorAll("table").forEach((t) => { const wrap = h("div.md-table-wrap"); t.before(wrap); wrap.append(t); });

  // Task lists: real checkboxes, clickable when the caller can save the text.
  let current = source; // updated after each saved toggle so later toggles build on it
  const offsets = taskOffsets(source);
  el.querySelectorAll('li > input[type="checkbox"], li > p > input[type="checkbox"]').forEach((box, i) => {
    const li = box.closest("li");
    li.classList.add("task-item");
    li.parentElement.classList.add("task-list");
    box.disabled = !onTaskToggle;
    box.classList.add("md-task");
    if (onTaskToggle && offsets[i] !== undefined) {
      box.addEventListener("change", async () => {
        const at = offsets[i];
        const next = current.slice(0, at) + (box.checked ? "x" : " ") + current.slice(at + 1);
        box.disabled = true;
        try { await onTaskToggle(next); current = next; } catch (err) { box.checked = !box.checked; toast(err.message, "error"); } finally { box.disabled = false; }
      });
    }
  });

  // :emoji: shortcodes and ticket keys.
  replaceInText(el, /:([a-z0-9_+-]{1,30}):/g, (m) => (EMOJI[m[1]] ? document.createTextNode(EMOJI[m[1]]) : null));
  replaceInText(el, /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g, (m) => (projectKeys && !projectKeys.has(m[1])
    ? null : h("a.md-ticket", { href: `#/tickets/${m[0]}` }, m[0])));

  // In-page links (#md-heading, footnotes) scroll instead of changing the route.
  el.addEventListener("click", (e) => {
    const a = e.target.closest("a[href^='#']");
    if (!a || a.getAttribute("href").startsWith("#/")) return;
    const target = el.querySelector(`[id="${CSS.escape(a.getAttribute("href").slice(1))}"]`);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("md-flash");
    setTimeout(() => target.classList.remove("md-flash"), 1200);
  });

  el.querySelectorAll("img").forEach((img) => { img.loading = "lazy"; img.decoding = "async"; });

  // Code blocks: language label + copy button, then syntax highlighting.
  const blocks = [...el.querySelectorAll("pre.md-code")];
  blocks.forEach((pre) => {
    const code = pre.querySelector("code");
    const copy = h("button.md-copy", {
      type: "button",
      onclick: async () => {
        await copyText(code.textContent.replace(/\n$/, ""), "Code copied");
        copy.textContent = "Copied ✓";
        setTimeout(() => { copy.textContent = "Copy"; }, 1500);
      },
    }, "Copy");
    const wrap = h("div.md-codeblock", h("div.md-codebar", h("span", pre.dataset.lang || "text"), copy));
    pre.before(wrap);
    wrap.append(pre);
  });
  if (blocks.some((p) => p.dataset.lang && p.dataset.lang !== "text")) {
    loadScript("highlight.min.js").then(() => {
      blocks.forEach((pre) => {
        const code = pre.querySelector("code");
        const lang = pre.dataset.lang;
        if (lang && window.hljs.getLanguage(lang)) window.hljs.highlightElement(code);
      });
    }).catch(() => {});
  }

  // Math.
  const maths = el.querySelectorAll(".md-math");
  if (maths.length) {
    loadCss("katex.min.css");
    loadScript("katex.min.js").then(() => maths.forEach((m) => {
      try {
        window.katex.render(m.dataset.tex, m, { displayMode: m.dataset.display === "1", throwOnError: false, output: "html", strict: "ignore" });
      } catch { m.classList.add("md-error"); }
    })).catch(() => {});
  }

  // Mermaid diagrams.
  const diagrams = el.querySelectorAll(".md-mermaid");
  if (diagrams.length) renderMermaid(diagrams);
}

let mermaidSeq = 0;
let mermaidTheme = null;
async function renderMermaid(nodes) {
  try {
    await loadScript("mermaid.min.js");
    const theme = isDark() ? "dark" : "default";
    if (mermaidTheme !== theme) {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "inherit" });
      mermaidTheme = theme;
    }
    for (const node of nodes) {
      const src = node.dataset.src || node.querySelector("pre")?.textContent || "";
      try {
        const { svg } = await window.mermaid.render(`md-mermaid-${++mermaidSeq}`, src);
        node.innerHTML = window.DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true }, ADD_TAGS: ["foreignObject"] });
        node.classList.add("rendered");
      } catch (err) {
        clear(node, h("div.md-error", "Diagram error: ", String(err.message || err).split("\n")[0]), h("pre", src));
      }
    }
  } catch { /* library unavailable: the source stays visible */ }
}

/**
 * Render Markdown into a `.markdown` element.
 * opts.onTaskToggle(newSource) makes task-list checkboxes clickable (the caller saves the new text).
 */
export function renderMarkdown(text, opts = {}) {
  const el = h("div.markdown");
  if (!text || !text.trim()) return el;
  if (!window.marked || !window.DOMPurify) {
    el.classList.add("plain");
    el.textContent = text;
    return el;
  }
  setup();
  const html = window.marked.parse(text);
  el.innerHTML = window.DOMPurify.sanitize(html, {
    ADD_TAGS: ["details", "summary", "mark", "section", "sup"],
    ADD_ATTR: ["target", "data-tex", "data-display", "data-src", "data-lang", "data-footnote-ref", "data-footnote-backref"],
    FORBID_TAGS: ["style", "form", "button", "textarea", "select", "iframe", "object", "embed"],
  });
  enhance(el, text, opts);
  return el;
}

// ----------------------------------------------------------------------------- editor
const SNIPPETS = {
  table: "| Column | Column | Column |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n| Cell | Cell | Cell |\n",
  code: "```js\n\n```\n",
  mermaid: "```mermaid\nflowchart LR\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]\n```\n",
  sequence: "```mermaid\nsequenceDiagram\n  participant App\n  participant API\n  App->>API: Request\n  API-->>App: Response\n```\n",
  math: "$$\nE = mc^2\n$$\n",
  note: "> [!NOTE]\n> ",
  tip: "> [!TIP]\n> ",
  warning: "> [!WARNING]\n> ",
  important: "> [!IMPORTANT]\n> ",
  details: "<details>\n<summary>Click to expand</summary>\n\nHidden content\n\n</details>\n",
  hr: "\n---\n",
  task: "- [ ] ",
  footnote: "[^1]\n\n[^1]: Footnote text.",
};

const COMMANDS = [
  ["h1", "Heading 1", "# ", "line"], ["h2", "Heading 2", "## ", "line"], ["h3", "Heading 3", "### ", "line"],
  ["todo", "Checklist", SNIPPETS.task, "line"], ["bullet", "Bulleted list", "- ", "line"], ["numbered", "Numbered list", "1. ", "line"],
  ["quote", "Quote", "> ", "line"], ["table", "Table", SNIPPETS.table], ["code", "Code block", SNIPPETS.code],
  ["mermaid", "Flowchart (Mermaid)", SNIPPETS.mermaid], ["sequence", "Sequence diagram", SNIPPETS.sequence],
  ["math", "Math block", SNIPPETS.math], ["note", "Callout: note", SNIPPETS.note], ["tip", "Callout: tip", SNIPPETS.tip],
  ["warning", "Callout: warning", SNIPPETS.warning], ["important", "Callout: important", SNIPPETS.important],
  ["details", "Collapsible section", SNIPPETS.details], ["divider", "Divider", SNIPPETS.hr], ["footnote", "Footnote", SNIPPETS.footnote],
];

const TOOLBAR = [
  [["B", "Bold (Ctrl/⌘+B)", { wrap: "**", ph: "bold" }, "b"], ["I", "Italic (Ctrl/⌘+I)", { wrap: "_", ph: "italic" }, "i"],
    ["S", "Strikethrough (Ctrl/⌘+Shift+X)", { wrap: "~~", ph: "text" }, "X"], ["H̲", "Highlight", { wrap: "==", ph: "text" }],
    ["<>", "Inline code (Ctrl/⌘+E)", { wrap: "`", ph: "code" }, "e"], ["🔗", "Link (Ctrl/⌘+K)", { link: true }, "k"]],
  [["H2", "Heading", { line: "## " }], ["H3", "Sub-heading", { line: "### " }], ["❝", "Quote", { line: "> " }],
    ["•", "Bulleted list", { line: "- " }], ["1.", "Numbered list", { line: "1. " }], ["☑", "Checklist", { line: "- [ ] " }]],
  [["▦", "Table", { snippet: "table" }], ["{ }", "Code block", { snippet: "code" }], ["◇", "Diagram (Mermaid)", { snippet: "mermaid" }],
    ["∑", "Math (KaTeX)", { snippet: "math" }], ["ℹ", "Callout", { snippet: "note" }], ["▸", "Collapsible section", { snippet: "details" }],
    ["—", "Divider", { snippet: "hr" }]],
];

function cheatSheet() {
  const rows = [
    ["**bold**  _italic_  ~~strike~~  ==highlight==", "Text styles"],
    ["# H1 · ## H2 · ### H3", "Headings"],
    ["- item · 1. item · - [ ] task", "Lists and checklists"],
    ["[text](https://…) · ![alt](https://…/img.png)", "Links and images"],
    ["`code` · ```js … ```", "Code (highlighted, with copy)"],
    ["| a | b |\\n| - | - |", "Tables"],
    ["> [!NOTE] / [!TIP] / [!WARNING] / [!IMPORTANT] / [!CAUTION]", "Callouts"],
    ["$a^2+b^2$ · $$\\int_0^1 x\\,dx$$", "Math (KaTeX)"],
    ["```mermaid … ```", "Diagrams: flowchart, sequenceDiagram, gantt, erDiagram…"],
    ["<details><summary>…</summary> … </details>", "Collapsible section"],
    ["Text[^1] … [^1]: note", "Footnotes"],
    [":rocket: :bug: :tada: :white_check_mark:", "Emoji"],
    ["PAY-12 · @name@company.com", "Ticket links, mentions (comments)"],
    ["/ at the start of a line", "Insert menu"],
  ];
  modal("Markdown help", h("table.table.md-help-table", h("tbody", rows.map(([code, what]) => h("tr", h("td", h("code", code)), h("td", what))))), { wide: true });
}

/**
 * Markdown editor: toolbar, Write / Split / Preview, full screen, "/" insert menu, list helpers.
 * Returns {el, textarea, value, focus(), showWrite()}.
 */
export function markdownEditor({ value = "", placeholder = "", rows = 8, label: aria = "Text", autofocus = false } = {}) {
  const ta = h("textarea.md-input", { rows, placeholder, "aria-label": aria, maxLength: 50000, spellcheck: true }, value);
  const preview = h("div.md-preview");
  const words = h("span.md-count");
  let mode = "write";
  let previewTimer;

  const renderPreview = () => clear(preview, ta.value.trim() ? renderMarkdown(ta.value) : h("p.muted", "Nothing to preview."));
  const updateCount = () => {
    const n = (ta.value.trim().match(/\S+/g) || []).length;
    words.textContent = `${n} word${n === 1 ? "" : "s"}`;
  };

  const modeBtn = (m, text, title) => h("button", { type: "button", title, "aria-pressed": "false", dataset: { mode: m }, onclick: () => setMode(m) }, text);
  const tabs = h("div.md-tabs", modeBtn("write", "Write"), modeBtn("split", "Split", "Write with live preview"), modeBtn("preview", "Preview"));
  function setMode(m) {
    mode = m;
    el.dataset.mode = m;
    tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
    if (m !== "write") renderPreview();
    if (m !== "preview") ta.focus();
  }

  // ---------------------------------------------------------- editing helpers
  const changed = () => { ta.dispatchEvent(new Event("input", { bubbles: true })); };
  function replaceRange(text, start, end, selStart, selEnd) {
    ta.focus();
    ta.setRangeText(text, start, end, "end");
    if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd ?? selStart);
    changed();
  }
  function lineBounds() {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const start = v.lastIndexOf("\n", s - 1) + 1;
    let end = v.indexOf("\n", e - (e > s && v[e - 1] === "\n" ? 1 : 0));
    if (end === -1) end = v.length;
    return [start, end];
  }
  function apply(action) {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const selected = v.slice(s, e);
    if (action.wrap) {
      const w = action.wrap;
      if (selected.startsWith(w) && selected.endsWith(w) && selected.length >= w.length * 2) {
        replaceRange(selected.slice(w.length, -w.length), s, e, s, e - w.length * 2);
      } else {
        const text = selected || action.ph;
        replaceRange(w + text + w, s, e, s + w.length, s + w.length + text.length);
      }
    } else if (action.line) {
      const [a, b] = lineBounds();
      const lines = v.slice(a, b).split("\n");
      const all = lines.every((l) => l.startsWith(action.line));
      const out = lines.map((l, i) => {
        if (all) return l.slice(action.line.length);
        const clean = l.replace(/^(#{1,6} |> |- \[[ xX]\] |[-*+] |\d+\. )/, "");
        return (action.line === "1. " ? `${i + 1}. ` : action.line) + clean;
      }).join("\n");
      replaceRange(out, a, b, a + out.length);
    } else if (action.link) {
      const text = selected || "link text";
      const ins = `[${text}](https://)`;
      replaceRange(ins, s, e, s + text.length + 3, s + text.length + 11);
    } else if (action.snippet) {
      insertBlock(SNIPPETS[action.snippet], s, e);
    }
  }
  function insertBlock(snippet, s, e) {
    const v = ta.value;
    const before = s > 0 && v[s - 1] !== "\n" ? "\n\n" : s > 1 && v[s - 2] !== "\n" ? "\n" : "";
    const text = before + snippet;
    // place the caret on the first editable spot: an empty line inside fences, after "> ", or at the end
    let caret = text.length;
    const fenceGap = text.indexOf("\n\n```");
    if (snippet.startsWith("```") && fenceGap !== -1) caret = fenceGap + 1;
    else if (snippet.endsWith("> ")) caret = text.length;
    replaceRange(text, s, e, s + caret);
  }

  const toolbar = h("div.md-toolbar", { role: "toolbar", "aria-label": "Formatting" },
    TOOLBAR.map((group) => h("div.md-group", group.map(([text, title, action]) => h("button", {
      type: "button", title, "aria-label": title, onmousedown: (ev) => ev.preventDefault(), onclick: () => apply(action),
    }, text)))));

  const fullBtn = h("button.md-icon", { type: "button", title: "Full screen (Esc to leave)", "aria-label": "Full screen", onclick: () => toggleFull() }, "⛶");
  function toggleFull(force) {
    const on = force ?? !el.classList.contains("md-full");
    el.classList.toggle("md-full", on);
    document.body.classList.toggle("md-full-open", on);
    if (on && mode === "write") setMode("split");
    ta.focus();
  }

  // ---------------------------------------------------------- "/" insert menu
  const menu = h("ul.md-slash", { role: "listbox", hidden: true });
  let menuItems = [];
  let menuActive = 0;
  let menuRange = null;
  function openMenu(query, start) {
    const q = query.toLowerCase();
    menuItems = COMMANDS.filter(([key, name]) => key.startsWith(q) || name.toLowerCase().includes(q)).slice(0, 9);
    if (!menuItems.length) return closeMenu();
    menuActive = Math.min(menuActive, menuItems.length - 1);
    menuRange = [start, ta.selectionStart];
    clear(menu, menuItems.map(([key, name], i) => h(`li${i === menuActive ? ".active" : ""}`, {
      onmousedown: (ev) => { ev.preventDefault(); pick(i); },
    }, h("span", name), h("span.muted", `/${key}`))));
    menu.hidden = false;
  }
  function closeMenu() { menu.hidden = true; menuRange = null; menuActive = 0; }
  function pick(i) {
    const [, , snippet, kind] = menuItems[i];
    const [a, b] = menuRange;
    closeMenu();
    if (kind === "line") replaceRange(snippet, a, b, a + snippet.length);
    else insertBlock(snippet, a, b);
  }

  ta.addEventListener("input", () => {
    updateCount();
    if (mode !== "write") { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 180); }
    const s = ta.selectionStart;
    const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
    const m = /^\/([\w-]{0,20})$/.exec(ta.value.slice(lineStart, s));
    if (m) openMenu(m[1], lineStart); else if (!menu.hidden) closeMenu();
  });
  ta.addEventListener("blur", () => setTimeout(closeMenu, 120));

  ta.addEventListener("keydown", (e) => {
    // insert menu
    if (!menu.hidden) {
      if (e.key === "ArrowDown") { menuActive = (menuActive + 1) % menuItems.length; openMenu(ta.value.slice(menuRange[0] + 1, ta.selectionStart), menuRange[0]); e.preventDefault(); return; }
      if (e.key === "ArrowUp") { menuActive = (menuActive - 1 + menuItems.length) % menuItems.length; openMenu(ta.value.slice(menuRange[0] + 1, ta.selectionStart), menuRange[0]); e.preventDefault(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(menuActive); return; }
      if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
    }
    if (e.key === "Escape" && el.classList.contains("md-full")) { e.preventDefault(); toggleFull(false); return; }

    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey) {
      const k = e.key.length === 1 ? (e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase()) : e.key;
      for (const group of TOOLBAR) {
        const hit = group.find((b) => b[3] && b[3] === k);
        if (hit) { e.preventDefault(); apply(hit[2]); return; }
      }
      if (k === "P" && e.shiftKey) { e.preventDefault(); setMode(mode === "preview" ? "write" : "preview"); return; }
    }

    // Tab / Shift+Tab indent the selected lines (lists nest).
    if (e.key === "Tab" && !mod && !e.altKey) {
      const [a, b] = lineBounds();
      const block = ta.value.slice(a, b);
      if (!e.shiftKey && ta.selectionStart === ta.selectionEnd && !/^\s*([-*+]|\d+\.)\s/.test(block)) {
        e.preventDefault();
        replaceRange("  ", ta.selectionStart, ta.selectionEnd);
        return;
      }
      e.preventDefault();
      const out = block.split("\n").map((l) => (e.shiftKey ? l.replace(/^ {1,2}/, "") : `  ${l}`)).join("\n");
      replaceRange(out, a, b, a, a + out.length);
      return;
    }

    // Enter continues lists; Enter on an empty item ends the list.
    if (e.key === "Enter" && !e.shiftKey && !mod && !e.defaultPrevented) {
      const s = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
      const line = ta.value.slice(lineStart, s);
      const m = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)\. |> )/.exec(line);
      if (!m) return;
      e.preventDefault();
      if (line.trim() === m[2].trim()) { replaceRange("", lineStart, s); return; }
      const next = m[3] ? `${m[1]}${Number(m[3]) + 1}. ` : m[1] + m[2].replace(/\[[xX]\]/, "[ ]");
      replaceRange(`\n${next}`, s, ta.selectionEnd);
    }
  });

  // Pasting a URL over selected text makes a link.
  ta.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain")?.trim();
    const { selectionStart: s, selectionEnd: en } = ta;
    if (text && s !== en && /^https?:\/\/\S+$/.test(text)) {
      e.preventDefault();
      replaceRange(`[${ta.value.slice(s, en)}](${text})`, s, en);
    }
  });

  const el = h("div.md-editor", { dataset: { mode: "write" } },
    h("div.md-head", tabs, toolbar,
      h("div.md-side", h("button.md-icon", { type: "button", title: "Markdown help", "aria-label": "Markdown help", onclick: cheatSheet }, "?"), fullBtn)),
    h("div.md-body", h("div.md-write", ta, menu), preview),
    h("div.md-foot", h("span.muted", "Markdown · type / to insert blocks"), words));
  setMode("write");
  updateCount();
  if (autofocus) setTimeout(() => ta.focus(), 0);

  return {
    el, textarea: ta,
    get value() { return ta.value; },
    set value(v) { ta.value = v; updateCount(); setMode("write"); },
    focus: () => ta.focus(),
    showWrite: () => setMode("write"),
    setMode,
  };
}
