// One WebSocket per tab for live chat events. Reconnects with back-off; listeners get every event
// plus synthetic "_open" (connected - refetch anything you might have missed) and "_close".
import { auth } from "./api.js";

const listeners = new Set();
let ws = null;
let wanted = false;
let retry = 0;
let retryTimer = null;
let pingTimer = null;

const emit = (event) => listeners.forEach((fn) => { try { fn(event); } catch (err) { console.error(err); } });

function connect() {
  if (!wanted || !auth.token || ws) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/api/v1/chat/ws?token=${encodeURIComponent(auth.token)}`);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => realtime.send({ type: "ping" }), 25_000);
    emit({ type: "_open" });
  };
  sock.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data.type !== "pong") emit(data);
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    clearInterval(pingTimer);
    emit({ type: "_close" });
    if (wanted) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, Math.min(15_000, 600 * 2 ** retry++));
    }
  };
}

export const realtime = {
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  start() { wanted = true; connect(); },
  stop() {
    wanted = false;
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    const sock = ws;
    ws = null;
    sock?.close();
  },
  send(obj) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
  get connected() { return ws?.readyState === WebSocket.OPEN; },
};

// Coming back to the tab (or the network) reconnects straight away instead of waiting for back-off.
const wake = () => { if (wanted && !ws) { retry = 0; clearTimeout(retryTimer); connect(); } };
document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
window.addEventListener("online", wake);
