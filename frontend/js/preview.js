// In-app file preview for ticket attachments, upcoming-task documents and chat files.
// Images (zoom), PDF, video/audio, Markdown, code & text (highlighted), CSV/Excel (tables),
// Word (.docx). Everything else gets a clear "download" card. Files are fetched with the
// user's token and shown from a local blob URL; HTML/SVG are never rendered as pages.
import { request } from "./api.js";
import { icon } from "./icons.js";
import { loadScript, renderMarkdown } from "./markdown.js";
import { clear, copyText, fmtBytes, h, toast } from "./ui.js";

const MAX_PREVIEW = 40 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_COLS = 60;

const EXT = (name) => (name.split(".").length > 1 ? name.split(".").pop().toLowerCase() : "");
const CODE_LANG = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", php: "php",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", env: "bash", json: "json",
  xml: "xml", html: "xml", htm: "xml", svg: "xml", css: "css", scss: "scss", less: "less", vue: "xml",
  dockerfile: "dockerfile", makefile: "makefile", gradle: "groovy", r: "r", dart: "dart", lua: "lua",
  diff: "diff", patch: "diff", graphql: "graphql", proto: "protobuf",
};
const TEXT_EXT = new Set(["txt", "log", "text", "conf", "cfg", "properties", "gitignore", "editorconfig", "rst", "tex"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "svg"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"]);
const SHEET_EXT = new Set(["xlsx", "xlsm", "xls", "ods", "numbers"]);

/** What kind of preview a file gets, from its name (and content type as a fallback). */
export function fileKind(name = "", type = "") {
  const ext = EXT(name);
  const base = name.toLowerCase();
  if (IMAGE_EXT.has(ext) || (!ext && type.startsWith("image/"))) return "image";
  if (ext === "pdf" || type === "application/pdf") return "pdf";
  if (VIDEO_EXT.has(ext) || type.startsWith("video/")) return "video";
  if (AUDIO_EXT.has(ext) || type.startsWith("audio/")) return "audio";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (SHEET_EXT.has(ext)) return "sheet";
  if (ext === "docx") return "docx";
  if (CODE_LANG[ext] || base === "dockerfile" || base === "makefile") return "code";
  if (TEXT_EXT.has(ext) || type.startsWith("text/")) return "text";
  return "none";
}

const KIND_LABEL = { image: "Image", pdf: "PDF", video: "Video", audio: "Audio", markdown: "Markdown", csv: "Table", sheet: "Spreadsheet", docx: "Word document", code: "Code", text: "Text", none: "File" };
const MIME = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", avif: "image/avif", ico: "image/x-icon", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm",
  mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg", weba: "audio/webm",
};

export const canPreview = (name, type) => fileKind(name, type) !== "none";

// ---------------------------------------------------------------------------- sources
const cache = new Map();
function fetchBlob(path) {
  if (!cache.has(path)) {
    cache.set(path, request("GET", path, { raw: true }).then((r) => r.blob()).catch((err) => { cache.delete(path); throw err; }));
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  return cache.get(path);
}

function source(path, name, size, type, meta) {
  return { name, size, type, meta, fetch: () => fetchBlob(path) };
}

/** Adapters for the app's file records. */
export const files = {
  attachment: (a, meta) => source(`/attachments/${a.id}/download`, a.filename, a.size, a.content_type, meta),
  upcomingDoc: (d, meta) => source(`/upcoming-documents/${d.id}/download`, d.filename, d.size, d.content_type, meta),
  chat: (f, meta) => source(`/chat/files/${f.id}`, f.filename, f.size, f.content_type, meta),
};

/** A blob with the right type for its extension (the server sends some files as octet-stream). */
async function typedBlob(file) {
  const blob = await file.fetch();
  const ext = EXT(file.name);
  const want = MIME[ext];
  return want && blob.type !== want ? new Blob([blob], { type: want }) : blob;
}

export async function downloadFile(file) {
  try {
    const blob = await file.fetch();
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) { toast(err.message, "error"); }
}

// ---------------------------------------------------------------------------- thumbnails
const EXT_COLOR = { pdf: "#e5484d", doc: "#2b6cdf", docx: "#2b6cdf", xls: "#1f9254", xlsx: "#1f9254", csv: "#1f9254", ppt: "#e5682a", pptx: "#e5682a", zip: "#8a6d3b", md: "#6e56cf", json: "#a16207", txt: "#64748b" };

/** Square-ish thumbnail: the image itself for pictures, a coloured type badge otherwise. */
export function fileThumb(file, { size = 44 } = {}) {
  const kind = fileKind(file.name, file.type);
  const ext = EXT(file.name);
  const el = h("span.pv-thumb", { style: { width: `${size}px`, height: `${size}px`, "--c": EXT_COLOR[ext] || (kind === "code" ? "#0e7490" : "#64748b") } });
  if (kind === "image") {
    el.classList.add("img");
    const img = h("img", { alt: "", loading: "lazy" });
    el.append(img);
    file.fetch().then((b) => { img.src = URL.createObjectURL(b); }).catch(() => { el.classList.remove("img"); img.remove(); el.append(icon("image", { size: 18 })); });
  } else {
    el.append(icon(kind === "video" ? "video" : kind === "audio" ? "volume" : kind === "code" ? "code" : "file", { size: Math.round(size * 0.4) }),
      ext ? h("span.pv-thumb-ext", ext.slice(0, 4).toUpperCase()) : null);
  }
  return el;
}

/**
 * A file card used in lists: thumbnail, name, meta, Preview/Download (and optional extra actions).
 * Clicking the card opens the previewer on the whole list.
 */
export function fileCard(list, index, { actions = [] } = {}) {
  const f = list[index];
  const previewable = canPreview(f.name, f.type);
  return h("div.pv-card", {
    role: "button", tabindex: 0, title: previewable ? `Preview ${f.name}` : f.name,
    onclick: (e) => { if (!e.target.closest(".pv-card-actions")) openPreview(list, index); },
    onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); openPreview(list, index); } },
  },
  fileThumb(f),
  h("span.pv-card-text", h("span.pv-card-name", f.name), h("span.pv-card-meta", [fmtBytes(f.size), f.meta].filter(Boolean).join(" · "))),
  h("span.pv-card-actions",
    h("button.icon-btn.sm", { type: "button", title: "Download", "aria-label": `Download ${f.name}`, onclick: () => downloadFile(f) }, icon("download", { size: 15 })),
    actions));
}

// ---------------------------------------------------------------------------- viewer
let current = null;

/** Open the previewer on `list[index]`; ← → move between files. */
export function openPreview(list, index = 0) {
  current?.close();
  let i = Math.max(0, Math.min(index, list.length - 1));
  let zoom = 1;
  let urls = [];
  const title = h("div.pv-title");
  const tools = h("div.pv-tools");
  const body = h("div.pv-body");
  const prev = h("button.pv-nav.prev", { type: "button", "aria-label": "Previous file", onclick: () => go(-1) }, icon("chevron-left", { size: 26 }));
  const next = h("button.pv-nav.next", { type: "button", "aria-label": "Next file", onclick: () => go(1) }, icon("chevron-right", { size: 26 }));
  const root = h("div.pv-backdrop", { role: "dialog", "aria-modal": "true", "aria-label": "File preview" },
    h("header.pv-head", title, tools), h("div.pv-stage", prev, body, next));
  root.addEventListener("mousedown", (e) => { if (e.target === root || e.target.classList.contains("pv-stage")) close(); });
  const onKey = (e) => {
    if (e.target.closest?.("input, textarea, select")) return;
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
    else if ((e.key === "+" || e.key === "=") && body.querySelector(".pv-img")) setZoom(zoom * 1.25);
    else if (e.key === "-" && body.querySelector(".pv-img")) setZoom(zoom / 1.25);
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(root);
  document.body.classList.add("pv-open");

  function close() {
    root.remove();
    document.removeEventListener("keydown", onKey, true);
    document.body.classList.remove("pv-open");
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    if (current?.root === root) current = null;
  }
  function go(step) {
    if (list.length < 2) return;
    i = (i + step + list.length) % list.length;
    show();
  }
  function setZoom(z) {
    zoom = Math.max(0.1, Math.min(8, z));
    const img = body.querySelector(".pv-img");
    if (img) {
      img.style.maxWidth = zoom === 1 ? "" : "none";
      img.style.maxHeight = zoom === 1 ? "" : "none";
      img.style.width = zoom === 1 ? "" : `${img.naturalWidth * zoom}px`;
      body.classList.toggle("zoomed", zoom !== 1);
    }
    const label = tools.querySelector(".pv-zoom-label");
    if (label) label.textContent = zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`;
  }
  const objectUrl = (blob) => { const u = URL.createObjectURL(blob); urls.push(u); return u; };

  async function show() {
    const f = list[i];
    const kind = fileKind(f.name, f.type);
    zoom = 1;
    prev.hidden = next.hidden = list.length < 2;
    clear(title, fileThumb(f, { size: 34 }),
      h("div.pv-title-text", h("strong", f.name),
        h("span", [KIND_LABEL[kind], fmtBytes(f.size), f.meta, list.length > 1 ? `${i + 1} of ${list.length}` : null].filter(Boolean).join(" · "))));
    const tool = (ic, label, run, extra = "") => h(`button.pv-tool${extra}`, { type: "button", title: label, "aria-label": label, onclick: run }, icon(ic, { size: 17 }));
    clear(tools,
      kind === "image" ? [
        tool("zoom-out", "Zoom out (-)", () => setZoom(zoom / 1.25)),
        h("button.pv-zoom-label", { type: "button", title: "Fit to screen", onclick: () => setZoom(1) }, "Fit"),
        tool("zoom-in", "Zoom in (+)", () => setZoom(zoom === 1 ? 1.5 : zoom * 1.25)),
        h("span.pv-sep"),
      ] : null,
      // SVG stays inside <img> (no scripts); opened as its own page it could run them.
      ["image", "pdf", "video", "audio"].includes(kind) && EXT(f.name) !== "svg" ? tool("external", "Open in a new tab", async () => {
        const blob = await typedBlob(f);
        window.open(objectUrl(blob), "_blank", "noopener");
      }) : null,
      tool("download", "Download", () => downloadFile(f)),
      tool("x", "Close (Esc)", close, ".close"));
    clear(body, h("div.pv-loading", h("span.spin"), `Loading ${f.name}…`));
    body.className = `pv-body kind-${kind}`;
    if (f.size > MAX_PREVIEW && kind !== "video" && kind !== "audio") return noPreview(f, "This file is too large to preview here.");
    if (kind === "none") return noPreview(f);
    try {
      const blob = await typedBlob(f);
      if (list[i] !== f) return undefined; // moved on while loading
      await render(kind, f, blob);
    } catch (err) {
      clear(body, h("div.pv-none", icon("alert", { size: 28 }), h("strong", "Couldn't open this file"), h("p.muted", err.message),
        h("button.btn.primary", { type: "button", onclick: () => downloadFile(f) }, icon("download", { size: 15 }), "Download")));
    }
    return undefined;
  }

  function noPreview(f, why) {
    const ext = EXT(f.name).toUpperCase();
    clear(body, h("div.pv-none", fileThumb(f, { size: 84 }), h("strong", f.name),
      h("p.muted", why || (ext ? `There's no preview for .${ext.toLowerCase()} files yet.` : "There's no preview for this file.")),
      h("button.btn.primary", { type: "button", onclick: () => downloadFile(f) }, icon("download", { size: 15 }), `Download (${fmtBytes(f.size)})`)));
  }

  async function render(kind, f, blob) {
    if (kind === "image") {
      const img = h("img.pv-img", { alt: f.name, src: objectUrl(blob), draggable: false, onclick: () => setZoom(zoom === 1 ? 2 : 1) });
      clear(body, img);
      return;
    }
    if (kind === "pdf") {
      clear(body, h("iframe.pv-pdf", { src: `${objectUrl(blob)}#view=FitH`, title: f.name }));
      return;
    }
    if (kind === "video") { clear(body, h("video.pv-media", { src: objectUrl(blob), controls: true, playsInline: true, preload: "metadata" })); return; }
    if (kind === "audio") {
      clear(body, h("div.pv-audio", fileThumb(f, { size: 96 }), h("strong", f.name), h("audio", { src: objectUrl(blob), controls: true, preload: "metadata" })));
      return;
    }
    if (kind === "markdown" || kind === "code" || kind === "text") {
      const truncated = blob.size > MAX_TEXT;
      let text = await (truncated ? blob.slice(0, MAX_TEXT) : blob).text();
      if (kind === "markdown") {
        clear(body, h("div.pv-doc", renderMarkdown(text)), truncated ? h("p.pv-note", "Showing the first 2 MB.") : null);
        return;
      }
      const ext = EXT(f.name);
      const base = f.name.toLowerCase();
      let lang = CODE_LANG[ext] || (base === "dockerfile" ? "dockerfile" : base === "makefile" ? "makefile" : "");
      if (ext === "json") { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep as is */ } }
      const code = h("code", { class: lang ? `language-${lang}` : "" }, text);
      const lines = text.split("\n").length;
      const wrapBtn = h("button.btn.sm", { type: "button", onclick: () => { pre.classList.toggle("wrap"); wrapBtn.textContent = pre.classList.contains("wrap") ? "No wrap" : "Wrap lines"; } }, "Wrap lines");
      const pre = h("pre.pv-code", { style: { "--gutter": `${String(lines).length + 1}ch` } }, h("span.pv-lines", { "aria-hidden": "true" }, Array.from({ length: Math.min(lines, 20000) }, (_, n) => `${n + 1}\n`).join("")), code);
      clear(body, h("div.pv-codewrap",
        h("div.pv-codebar", h("span", lang || "text"), h("span.muted", `${lines} line${lines === 1 ? "" : "s"}${truncated ? " · first 2 MB" : ""}`),
          wrapBtn, h("button.btn.sm", { type: "button", onclick: () => copyText(text, "Copied") }, icon("copy", { size: 14 }), "Copy")),
        pre));
      if (lang && text.length < 400_000) {
        loadScript("highlight.min.js").then(() => { if (window.hljs?.getLanguage(lang)) window.hljs.highlightElement(code); }).catch(() => {});
      }
      return;
    }
    if (kind === "csv" || kind === "sheet") {
      await loadScript("xlsx.full.min.js");
      const buf = await blob.arrayBuffer();
      const wb = kind === "csv"
        ? window.XLSX.read(new TextDecoder().decode(buf), { type: "string", FS: EXT(f.name) === "tsv" ? "\t" : undefined, raw: true })
        : window.XLSX.read(buf, { type: "array", cellDates: true });
      const tabs = h("div.pv-sheet-tabs");
      const tableWrap = h("div.pv-table-wrap");
      const showSheet = (name) => {
        tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.name === name)));
        const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "", blankrows: false });
        const cols = Math.min(MAX_COLS, rows.reduce((m, r) => Math.max(m, r.length), 0));
        const shown = rows.slice(0, MAX_ROWS);
        const colName = (n) => { let s = ""; n += 1; while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
        clear(tableWrap, rows.length ? h("table.pv-table",
          h("thead", h("tr", h("th.rn", ""), Array.from({ length: cols }, (_, c) => h("th", colName(c))))),
          h("tbody", shown.map((r, n) => h("tr", h("th.rn", String(n + 1)), Array.from({ length: cols }, (_, c) => h("td", r[c] == null ? "" : String(r[c]))))))) : h("p.pv-note", "This sheet is empty."),
        rows.length > MAX_ROWS || cols === MAX_COLS ? h("p.pv-note", `Showing the first ${Math.min(rows.length, MAX_ROWS)} rows and ${cols} columns - download for the rest.`) : null);
      };
      wb.SheetNames.forEach((n) => tabs.append(h("button", { type: "button", dataset: { name: n }, onclick: () => showSheet(n) }, n)));
      clear(body, h("div.pv-sheet", tableWrap, wb.SheetNames.length > 1 ? tabs : null));
      showSheet(wb.SheetNames[0]);
      return;
    }
    if (kind === "docx") {
      await loadScript("mammoth.browser.min.js");
      const result = await window.mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() }, {
        convertImage: window.mammoth.images.imgElement((image) => image.read("base64").then((data) => ({ src: `data:${image.contentType};base64,${data}` }))),
      });
      const page = h("div.pv-page.markdown");
      page.innerHTML = window.DOMPurify.sanitize(result.value, { FORBID_TAGS: ["style", "script", "iframe", "form"], ALLOW_DATA_ATTR: false });
      page.querySelectorAll("a[href]").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
      clear(body, h("div.pv-doc", page), h("p.pv-note", "Preview of the document's text, tables and images - layout may differ from Word."));
    }
  }

  current = { root, close };
  show();
  return current;
}
