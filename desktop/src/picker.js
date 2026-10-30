let sources = [];
let kind = "screen";
let chosen = null;
const grid = document.getElementById("grid");
const shareBtn = document.getElementById("share");

function render() {
  grid.replaceChildren();
  const list = sources.filter((s) => s.kind === kind);
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = kind === "screen" ? "No screens found." : "No windows found. On macOS, allow Screen Recording for Grandesk in System Settings › Privacy & Security.";
    grid.append(p);
  }
  for (const s of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "src";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(s.id === chosen));
    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "";
    if (s.thumb) img.src = s.thumb;
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = s.name;
    b.append(img, name);
    b.addEventListener("click", () => { chosen = s.id; shareBtn.disabled = false; render(); });
    b.addEventListener("dblclick", () => window.desktop.pickSource(s.id));
    grid.append(b);
  }
}

document.querySelectorAll(".tabs button").forEach((t) => t.addEventListener("click", () => {
  kind = t.dataset.kind;
  document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-pressed", String(x === t)));
  render();
}));
shareBtn.addEventListener("click", () => chosen && window.desktop.pickSource(chosen));
document.getElementById("cancel").addEventListener("click", () => window.desktop.pickSource(null));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") window.desktop.pickSource(null); });

window.desktop.pickerSources().then((list) => {
  sources = list;
  if (!sources.some((s) => s.kind === "screen")) kind = "window";
  chosen = sources.find((s) => s.kind === kind)?.id || null;
  shareBtn.disabled = !chosen;
  render();
});
