// Tickets desktop app: a thin, secure shell around the web app on your server, plus the things a
// browser tab can't do well - dock/taskbar badge, staying alive in the tray, screen-share picker,
// native notifications that bring the window back, and update checks.
const {
  app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, dialog, ipcMain, nativeImage, nativeTheme, net,
  session, shell, systemPreferences,
} = require("electron");
const fs = require("fs");
const path = require("path");

const APP_ID = "tech.grandway.tickets";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const ASSETS = path.join(__dirname, "assets");
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
// What the server's pages may use. Everything else (USB, MIDI, geolocation…) is refused.
const ALLOWED_PERMISSIONS = new Set([
  "media", "notifications", "fullscreen", "clipboard-read", "clipboard-sanitized-write", "display-capture", "speaker-selection",
]);

if (!app.requestSingleInstanceLock()) app.quit();
if (isWin) app.setAppUserModelId(APP_ID);

// ----------------------------------------------------------------------------- settings
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings = {};
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), "utf8")); } catch { settings = {}; }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (err) { console.error("Could not save settings", err); }
}

/** The address baked in at build time (TICKETS_SERVER_URL), if any. */
function bakedServer() {
  const file = app.isPackaged ? path.join(process.resourcesPath, "server.json") : path.join(__dirname, "..", "build", "server.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")).serverUrl || null; } catch { return null; }
}
const serverUrl = () => settings.serverUrl || bakedServer();
const serverOrigin = () => { try { return new URL(serverUrl()).origin; } catch { return null; } };
function isTrusted(url) {
  const origin = serverOrigin();
  if (!origin || !url) return false;
  try { return new URL(url.startsWith("blob:") ? url.slice(5) : url).origin === origin; } catch { return false; }
}
const isLocalPage = (url) => typeof url === "string" && url.startsWith("file://");

function normalizeServer(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new Error("Enter your server address");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const u = new URL(raw);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

// ----------------------------------------------------------------------------- window
let win = null;
let tray = null;
let quitting = false;
let trayHintShown = false;

function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1360,
    height: b.height || 880,
    x: b.x,
    y: b.y,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: "Tickets",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1218" : "#ffffff",
    autoHideMenuBar: !isMac,
    icon: isMac ? undefined : path.join(ASSETS, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false, // keep calls and chat sounds running while minimised
    },
  });
  if (settings.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());

  const remember = () => {
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    settings.maximized = win.isMaximized();
    if (!settings.maximized) settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on("resized", remember);
  win.on("moved", remember);
  win.on("focus", () => win.flashFrame(false));

  // Closing keeps the app running (so calls ring and messages arrive) - quit from the menu or tray.
  win.on("close", (e) => {
    if (quitting) return;
    remember();
    if (isMac) { e.preventDefault(); win.hide(); return; }
    if (isWin && tray) {
      e.preventDefault();
      win.hide();
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({ title: "Tickets is still running", body: "You'll still get messages and calls. Quit from the tray icon." }).show();
      }
    }
  });

  wireContents(win.webContents);
  openHome();
}

function openHome(hash = "") {
  const url = serverUrl();
  if (url) win.loadURL(`${url}/${hash}`);
  else win.loadFile(path.join(__dirname, "connect.html"));
}

function showConnect(error) {
  win.loadFile(path.join(__dirname, "connect.html"), {
    query: { server: serverUrl() || "", error: error || "" },
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function wireContents(wc) {
  wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted, e.g. a redirect */ || isLocalPage(url)) return;
    showConnect(`Can't reach ${serverUrl()} (${description}). Check your connection or the server address.`);
  });
  wc.on("did-finish-load", () => { if (isTrusted(wc.getURL())) scheduleUpdateCheck(); });

  // Stay on the server; everything else opens in the normal browser.
  wc.on("will-navigate", (e, url) => {
    if (isTrusted(url) || isLocalPage(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isTrusted(url)) {
      // file previews ("open in new tab"), tickets opened in a new tab…
      return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: "#ffffff" } };
    }
    openExternal(url);
    return { action: "deny" };
  });
  wc.on("did-create-window", (child) => wireContents(child.webContents));
  wc.on("context-menu", (_e, p) => contextMenu(wc, p).popup());
}

function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (["http:", "https:", "mailto:"].includes(protocol)) shell.openExternal(url);
  } catch { /* not a URL */ }
}

function contextMenu(wc, p) {
  const items = [];
  if (p.misspelledWord) {
    p.dictionarySuggestions.slice(0, 5).forEach((s) => items.push({ label: s, click: () => wc.replaceMisspelling(s) }));
    items.push({ label: "Add to dictionary", click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: "separator" });
  }
  if (p.linkURL && !p.linkURL.startsWith("javascript:")) {
    items.push(
      { label: "Open link in browser", click: () => openExternal(p.linkURL) },
      { label: "Copy link", click: () => require("electron").clipboard.writeText(p.linkURL) },
      { type: "separator" });
  }
  if (p.mediaType === "image" && p.srcURL) {
    items.push(
      { label: "Copy image", click: () => wc.copyImageAt(p.x, p.y) },
      { label: "Save image as…", click: () => wc.downloadURL(p.srcURL) },
      { type: "separator" });
  }
  const f = p.editFlags;
  if (p.isEditable) items.push({ role: "undo", enabled: f.canUndo }, { role: "redo", enabled: f.canRedo }, { type: "separator" }, { role: "cut", enabled: f.canCut });
  if (p.isEditable || p.selectionText) items.push({ role: "copy", enabled: f.canCopy });
  if (p.isEditable) items.push({ role: "paste", enabled: f.canPaste }, { role: "pasteAndMatchStyle", enabled: f.canPaste });
  items.push({ role: "selectAll" });
  if (!app.isPackaged) items.push({ type: "separator" }, { label: "Inspect element", click: () => wc.inspectElement(p.x, p.y) });
  return Menu.buildFromTemplate(items);
}

// ----------------------------------------------------------------------------- permissions, calls, screen share
function wireSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    const ok = ALLOWED_PERMISSIONS.has(permission) && isTrusted(details.requestingUrl || wc.getURL());
    if (!ok) return callback(false);
    if (permission === "media" && isMac) {
      // macOS asks once per device; without this the call silently gets no microphone/camera.
      const wanted = (details.mediaTypes || []).map((t) => (t === "video" ? "camera" : "microphone"));
      for (const device of wanted) {
        if (systemPreferences.getMediaAccessStatus(device) !== "granted" && !(await systemPreferences.askForMediaAccess(device))) {
          return callback(false);
        }
      }
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && isTrusted(origin));

  // getDisplayMedia(): macOS 15+ shows its own picker; elsewhere we show ours.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isTrusted(request.securityOrigin || request.frame?.url)) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 } });
      const id = await pickSource(sources);
      const source = sources.find((s) => s.id === id);
      if (!source) return callback({});
      callback(isWin && request.audioRequested ? { video: source, audio: "loopback" } : { video: source });
    } catch (err) {
      console.error("Screen share failed", err);
      callback({});
    }
  }, { useSystemPicker: true });

  ses.on("will-download", (_e, item) => {
    item.once("done", (_ev, state) => {
      if (state === "completed" && isMac) app.dock.downloadFinished(item.getSavePath());
    });
  });
}

let pickerWin = null;
function pickSource(sources) {
  return new Promise((resolve) => {
    if (pickerWin) pickerWin.close();
    pickerWin = new BrowserWindow({
      parent: win, modal: true, width: 760, height: 560, resizable: false, minimizable: false, maximizable: false,
      title: "Share your screen", autoHideMenuBar: true, show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#161a22" : "#ffffff",
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
    });
    const list = sources.map((s) => ({
      id: s.id, name: s.name, kind: s.id.startsWith("screen:") ? "screen" : "window", thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
    }));
    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      ipcMain.removeHandler("picker:sources");
      ipcMain.removeAllListeners("picker:choose");
      resolve(id);
      if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
      pickerWin = null;
    };
    ipcMain.removeHandler("picker:sources");
    ipcMain.handle("picker:sources", () => list);
    ipcMain.on("picker:choose", (_e, id) => finish(id || null));
    pickerWin.on("closed", () => finish(null));
    pickerWin.once("ready-to-show", () => pickerWin.show());
    pickerWin.loadFile(path.join(__dirname, "picker.html"));
  });
}

// ----------------------------------------------------------------------------- badge & attention
let overlayDot = null;
/** A small red dot for the Windows taskbar button, drawn in code so no extra asset is needed. */
function redDot() {
  if (overlayDot) return overlayDot;
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, size / 2 - 1 - d)) * 255;
      const i = (y * size + x) * 4; // BGRA, premultiplied
      buf[i] = Math.round(0x4d * a / 255); buf[i + 1] = Math.round(0x48 * a / 255); buf[i + 2] = Math.round(0xe5 * a / 255); buf[i + 3] = Math.round(a);
    }
  }
  overlayDot = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
  return overlayDot;
}

function setBadge(count, dot) {
  const n = Math.max(0, Number(count) || 0);
  const label = n ? (n > 99 ? "99+" : String(n)) : dot ? "•" : "";
  if (isMac) app.dock.setBadge(label);
  else if (isWin) win?.setOverlayIcon(label ? redDot() : null, label ? `${label} unread` : "");
  else app.setBadgeCount(n);
  tray?.setToolTip(label ? `Tickets - ${n ? `${label} unread` : "new messages"}` : "Tickets");
}

function requestAttention(urgent) {
  if (!win || (win.isFocused() && win.isVisible())) return;
  if (isMac) app.dock.bounce(urgent ? "critical" : "informational");
  else win.flashFrame(true);
}

function createTray() {
  if (isMac) return; // the dock does this job on macOS
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, isWin ? "tray.png" : "tray-linux.png")));
    tray.setToolTip("Tickets");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Tickets", click: showWindow },
      { type: "separator" },
      { label: "Quit Tickets", click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on("click", showWindow);
  } catch (err) {
    console.error("No system tray available", err);
    tray = null;
  }
}

// ----------------------------------------------------------------------------- updates
const newer = (a, b) => {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
let updateTimer = null;
let updateNotified = null;

async function latestVersion() {
  const res = await net.fetch(`${serverUrl()}/api/v1/desktop/info`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Server answered ${res.status}`);
  return (await res.json()).version;
}

function scheduleUpdateCheck() {
  if (updateTimer) return;
  updateTimer = setTimeout(async function tick() {
    try {
      const latest = await latestVersion();
      if (latest && newer(latest, app.getVersion()) && updateNotified !== latest && Notification.isSupported()) {
        updateNotified = latest;
        const n = new Notification({ title: "A new version of Tickets is available", body: `Version ${latest} is ready. Click to download it.` });
        n.on("click", () => { showWindow(); openHome("#/desktop"); });
        n.show();
      }
    } catch { /* offline - try again later */ }
    updateTimer = setTimeout(tick, UPDATE_EVERY_MS);
  }, 5000);
}

async function checkForUpdatesNow() {
  try {
    const latest = await latestVersion();
    if (latest && newer(latest, app.getVersion())) {
      const { response } = await dialog.showMessageBox(win, {
        type: "info", buttons: ["Download", "Later"], defaultId: 0,
        message: `Tickets ${latest} is available`, detail: `You have version ${app.getVersion()}.`,
      });
      if (response === 0) { showWindow(); openHome("#/desktop"); }
    } else {
      dialog.showMessageBox(win, { type: "info", message: "You're up to date", detail: `Tickets ${app.getVersion()} is the newest version.` });
    }
  } catch (err) {
    dialog.showMessageBox(win, { type: "warning", message: "Could not check for updates", detail: err.message });
  }
}

// ----------------------------------------------------------------------------- menu
function buildMenu() {
  const serverItems = [
    { label: "Check for updates…", click: checkForUpdatesNow },
    { label: "Change server…", click: () => { showWindow(); showConnect(); } },
  ];
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [{ role: "about" }, ...serverItems, { type: "separator" }, { role: "services" }, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }],
    }] : [{
      label: "File",
      submenu: [...serverItems, { type: "separator" }, { label: "Quit", accelerator: "Ctrl+Q", click: () => { quitting = true; app.quit(); } }],
    }]),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Back", accelerator: isMac ? "Cmd+[" : "Alt+Left", click: () => win?.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: isMac ? "Cmd+]" : "Alt+Right", click: () => win?.webContents.navigationHistory.goForward() },
        { type: "separator" },
        { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Open in browser", click: () => serverUrl() && openExternal(win?.webContents.getURL() || serverUrl()) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ----------------------------------------------------------------------------- IPC from the pages
function fromServer(e) { return isTrusted(e.senderFrame?.url); }
function fromLocal(e) { return isLocalPage(e.senderFrame?.url); }

ipcMain.on("app:info", (e) => {
  e.returnValue = { version: app.getVersion(), platform: process.platform, server: serverUrl() };
});
ipcMain.on("app:badge", (e, count, dot) => { if (fromServer(e)) setBadge(count, dot); });
ipcMain.on("app:attention", (e, urgent) => { if (fromServer(e)) requestAttention(Boolean(urgent)); });
ipcMain.on("app:focus", (e) => { if (fromServer(e)) showWindow(); });
ipcMain.on("app:check-updates", (e) => { if (fromServer(e)) checkForUpdatesNow(); });
ipcMain.on("app:change-server", (e) => { if (fromServer(e) || fromLocal(e)) showConnect(); });
ipcMain.on("app:retry", (e) => { if (fromLocal(e)) openHome(); });
ipcMain.handle("app:connect", async (e, input) => {
  if (!fromLocal(e)) throw new Error("Not allowed");
  let url;
  try { url = normalizeServer(input); } catch (err) { return { ok: false, error: err.message || "That doesn't look like an address" }; }
  try {
    const res = await net.fetch(`${url}/api/v1/desktop/info`, { cache: "no-store" });
    if (!res.ok) throw new Error();
    await res.json();
  } catch {
    return { ok: false, error: `No Tickets server answered at ${url}. Check the address (it's the one you open in your browser).` };
  }
  settings.serverUrl = url;
  saveSettings();
  openHome();
  return { ok: true };
});

// ----------------------------------------------------------------------------- lifecycle
app.on("second-instance", showWindow);
app.on("activate", () => (win ? showWindow() : createWindow()));
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { if (!isMac) app.quit(); });
app.on("web-contents-created", (_e, wc) => {
  // No page may attach a <webview> (it would escape the rules above).
  wc.on("will-attach-webview", (e) => e.preventDefault());
});

app.whenReady().then(() => {
  loadSettings();
  wireSession();
  buildMenu();
  createTray();
  createWindow();
});
