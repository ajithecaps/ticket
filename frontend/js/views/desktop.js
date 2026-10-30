// "Desktop app" page: offers the installer for the viewer's computer (built from desktop/, served by
// /desktop/downloads) and, inside the desktop app itself, shows the version and update status.
import { api, auth } from "../api.js";
import { icon } from "../icons.js";
import { busy, clear, fmtBytes, h, toast } from "../ui.js";

const OS = {
  mac: { name: "macOS", icon: "monitor" },
  windows: { name: "Windows", icon: "monitor" },
  linux: { name: "Linux", icon: "monitor" },
};
const ARCH = { arm64: "Apple silicon", x64: "Intel", universal: "Universal" };

/** The desktop shell exposes window.desktop; in a normal browser it is undefined. */
export const desktopShell = () => window.desktop || null;

function detectOs() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  if (p.includes("mac")) return "mac";
  if (p.includes("win")) return "windows";
  if (p.includes("linux") || p.includes("x11") || p.includes("cros")) return "linux";
  return null;
}

/** Apple silicon or Intel? Chrome says so directly; elsewhere the GPU name gives it away. */
async function detectMacArch() {
  try {
    const v = await navigator.userAgentData?.getHighEntropyValues?.(["architecture"]);
    if (v?.architecture) return v.architecture === "arm" ? "arm64" : "x64";
  } catch { /* not offered */ }
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
    if (/apple m\d|apple gpu/i.test(gpu)) return "arm64";
    if (/intel|amd|radeon|nvidia/i.test(gpu)) return "x64";
  } catch { /* no WebGL */ }
  return "arm64"; // every Mac sold since 2021
}

const newer = (a, b) => {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

function buildLabel(b) {
  if (b.os === "mac") return `${ARCH[b.arch] || b.arch} (.${b.kind})`;
  if (b.os === "windows") return `Installer for ${b.arch === "arm64" ? "ARM" : "64-bit"} (.exe)`;
  return b.kind === "deb" ? "Ubuntu / Debian (.deb)" : b.kind === "rpm" ? "Fedora / RHEL (.rpm)" : "Any distribution (.AppImage)";
}

async function download(b, btn) {
  await busy(btn, async () => {
    const { url } = await api.post(`/desktop/downloads/${encodeURIComponent(b.file)}/link`);
    const a = h("a", { href: url, download: b.file, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    toast(`Downloading ${b.file}`);
  });
}

const INSTALL = {
  mac: ["Open the downloaded .dmg and drag Grandesk into Applications.",
    "First launch: if macOS says it can't check the app, right-click Grandesk in Applications › Open › Open (or System Settings › Privacy & Security › Open Anyway).",
    "Allow the microphone and camera when your first call asks."],
  windows: ["Run the downloaded setup file and follow the steps.",
    "If SmartScreen appears, choose More info › Run anyway.",
    "Closing the window keeps Grandesk in the tray so calls still ring - quit from the tray icon."],
  linux: ["AppImage: make it executable (chmod +x Grandesk-*.AppImage) and run it.",
    "Debian / Ubuntu: sudo apt install ./Grandesk-*.deb",
    "Calls need PipeWire or PulseAudio, as in any browser."],
};

export async function renderDesktop(main) {
  const shell = desktopShell();
  const data = await api.get("/desktop/downloads");
  const os = detectOs();
  const macArch = os === "mac" ? await detectMacArch() : null;
  const builds = data.builds || [];
  const forOs = (o) => builds.filter((b) => b.os === o);
  const pick = (o) => {
    const list = forOs(o);
    if (o === "mac") return list.find((b) => b.arch === macArch && b.kind === "dmg") || list.find((b) => b.arch === "universal") || list[0];
    if (o === "linux") return list.find((b) => b.kind === "AppImage") || list[0];
    return list[0];
  };
  const best = os && pick(os);

  const head = h("div.page-head",
    h("div", h("h1", "Desktop app"),
      h("p.muted", "Grandesk in its own window - dock and taskbar badges, native notifications, and calls that ring even when your browser is closed.")));

  // ------------------------------------------------------------ inside the desktop app
  if (shell) {
    const outdated = data.version && newer(data.version, shell.version);
    const mine = pick(shell.platform === "darwin" ? "mac" : shell.platform === "win32" ? "windows" : "linux");
    clear(main, head, h("section.card.dl-hero",
      h("img.dl-logo", { src: logoUrl(), alt: "" }),
      h("div.dl-hero-text",
        h("h2", outdated ? `Version ${data.version} is available` : "You're using the desktop app"),
        h("p.muted", outdated ? `You have ${shell.version}. Download the new version and install it over this one.` : `Version ${shell.version} - the newest version.`),
        h("div.dl-actions",
          outdated && mine ? h("button.btn.primary", { type: "button", onclick: (e) => download(mine, e.currentTarget) }, icon("download", { size: 16 }), `Download ${data.version}`) : null,
          h("button.btn", { type: "button", onclick: () => shell.checkForUpdates() }, "Check for updates"),
          h("button.btn", { type: "button", onclick: () => shell.changeServer() }, "Change server")))));
    return;
  }

  // ------------------------------------------------------------ nothing published yet
  if (!builds.length) {
    clear(main, head, h("section.card.dl-empty",
      icon("download", { size: 28 }),
      h("h2", "The desktop app isn't available yet"),
      auth.user?.role === "admin"
        ? h("div.dl-admin",
          h("p.muted", "Build the installers once and drop them on the server - they show up here straight away:"),
          h("pre", "cd desktop && npm install\nTICKETS_SERVER_URL=https://your-server npm run dist\ncp dist/Grandesk-* ../desktop-builds/"),
          h("p.muted.small", "Or run the “Desktop app” GitHub workflow to build macOS, Windows and Linux in one go. See README › Desktop app."))
        : h("p.muted", "Your administrator hasn't published it yet. Keep using Grandesk in the browser in the meantime.")));
    return;
  }

  // ------------------------------------------------------------ downloads
  const hero = h("section.card.dl-hero",
    h("img.dl-logo", { src: logoUrl(), alt: "" }),
    h("div.dl-hero-text",
      h("h2", best ? `Grandesk for ${OS[os].name}` : "Grandesk for desktop"),
      h("p.muted", best ? `Version ${best.version} · ${buildLabel(best)} · ${fmtBytes(best.size)}` : `Version ${data.version} for macOS, Windows and Linux.`),
      h("div.dl-actions",
        best ? h("button.btn.primary.btn-lg", { type: "button", onclick: (e) => download(best, e.currentTarget) }, icon("download", { size: 18 }), `Download for ${OS[os].name}`) : null,
        h("span.muted.small", "Signed in as ", auth.user.email, " - you'll sign in once in the app."))));

  const column = (o) => {
    const list = forOs(o);
    return h(`section.card.dl-os${o === os ? ".mine" : ""}`,
      h("div.dl-os-head", h("strong", OS[o].name), o === os ? h("span.badge.accent", "This computer") : null),
      list.length
        ? h("ul.dl-list", list.map((b) => h("li",
          h("div", h("span", buildLabel(b)), h("span.muted.small", fmtBytes(b.size))),
          h("button.btn.sm", { type: "button", title: `Download ${b.file}`, onclick: (e) => download(b, e.currentTarget) }, icon("download", { size: 14 }), "Download"))))
        : h("p.muted.small", "Not built yet."),
      h("details.dl-install", h("summary", "How to install"), h("ol", INSTALL[o].map((t) => h("li", t)))));
  };

  const features = h("section.dl-features",
    [["message", "Chat that stays on", "Close the window - messages and calls still arrive. Unread counts on the dock or taskbar."],
      ["phone", "Calls and screen sharing", "Pick a screen or a single window to share. Microphone and camera remembered."],
      ["bell", "Native notifications", "Mentions and DMs pop up like any other app; click to jump straight in."],
      ["sparkles", "Always up to date", "The app tells you when a new version is published here."]]
      .map(([ic, title, text]) => h("div.dl-feature", h("span.dl-feature-ic", icon(ic, { size: 18 })), h("div", h("strong", title), h("p.muted.small", text)))));

  const order = ["mac", "windows", "linux"].sort((a, b) => (b === os) - (a === os));
  clear(main, head, hero, features, h("h3.dl-all-title", "All downloads"), h("div.dl-grid", order.map(column)));
}

function logoUrl() {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#6366f1'/><stop offset='1' stop-color='#a855f7'/></linearGradient></defs><rect width='32' height='32' rx='8' fill='url(#g)'/><path d='M23.5 16a7.5 7.5 0 1 1-2.2-5.3M23.5 16h-7' fill='none' stroke='white' stroke-width='2.8' stroke-linecap='round'/></svg>";
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
