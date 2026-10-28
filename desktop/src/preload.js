// The only bridge between the web app and the desktop shell. Pages get small, fixed functions -
// never Node or Electron itself.
const { contextBridge, ipcRenderer } = require("electron");

const info = ipcRenderer.sendSync("app:info");

contextBridge.exposeInMainWorld("desktop", {
  version: info.version,
  platform: info.platform,
  server: info.server,
  /** Unread count on the dock / taskbar; `dot` shows a plain marker when there are only unread messages. */
  setBadge: (count, dot = false) => ipcRenderer.send("app:badge", Number(count) || 0, Boolean(dot)),
  /** Bounce the dock icon / flash the taskbar button (urgent: until the window is focused). */
  attention: (urgent = false) => ipcRenderer.send("app:attention", Boolean(urgent)),
  focus: () => ipcRenderer.send("app:focus"),
  checkForUpdates: () => ipcRenderer.send("app:check-updates"),
  changeServer: () => ipcRenderer.send("app:change-server"),
  // used by the local connect and screen-picker pages
  connect: (url) => ipcRenderer.invoke("app:connect", url),
  retry: () => ipcRenderer.send("app:retry"),
  pickerSources: () => ipcRenderer.invoke("picker:sources"),
  pickSource: (id) => ipcRenderer.send("picker:choose", id),
});
