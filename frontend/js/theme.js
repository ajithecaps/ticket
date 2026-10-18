// Light / dark / system theme. The choice is stored per browser; "system" follows the OS setting.
const KEY = "tickets.theme";
const listeners = new Set();

export function getTheme() {
  try { return localStorage.getItem(KEY) || "system"; } catch { return "system"; }
}

export function applyTheme(theme = getTheme()) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
}

export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* the choice just won't persist */ }
  applyTheme(theme);
  listeners.forEach((fn) => fn(theme));
}

export const onThemeChange = (fn) => listeners.add(fn);
export const isDarkNow = () => document.documentElement.dataset.theme === "dark"
  || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);

// Charts and diagrams pick their colours when drawn, so redraw when the OS theme flips under "system".
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (getTheme() === "system") listeners.forEach((fn) => fn("system"));
});
