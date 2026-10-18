// Audio / video calls over WebRTC: 1:1 or group (full mesh, up to ~8 people). The server only relays
// signalling through the chat WebSocket; audio and video go directly between browsers.
//
// Clarity: 48 kHz mono Opus with echo cancellation, noise suppression and auto gain (switchable),
// higher audio bitrate, HD/Full-HD camera presets, screen sharing tuned for sharp text, live
// speaking indicators, device pickers (mic, camera, speaker) and automatic ICE restarts.
import { api, auth } from "./api.js";
import { icon } from "./icons.js";
import { realtime } from "./realtime.js";
import { prefs, sounds } from "./sounds.js";
import { avatar, clear, h, toast } from "./ui.js";

const QUALITY = {
  sd: { label: "Data saver (360p)", width: 640, height: 360, fps: 24, bitrate: 500_000 },
  hd: { label: "HD (720p)", width: 1280, height: 720, fps: 30, bitrate: 1_800_000 },
  fhd: { label: "Full HD (1080p)", width: 1920, height: 1080, fps: 30, bitrate: 3_500_000 },
};
const AUDIO_BITRATE = 64_000;
// In-call reactions: shown floating up from the sender's tile for everyone in the call.
const CALL_REACTIONS = ["👍", "❤️", "😂", "🎉", "👏", "😮", "🔥", "🙌", "💯", "🚀", "😢", "🤔"];
const SHOWER = /🎉|🔥|❤️|🚀|💯|👏/u;
const RING_TIMEOUT_MS = 45_000;

const listeners = new Set();
const changed = () => listeners.forEach((fn) => { try { fn(); } catch (err) { console.error(err); } });

// Calls happening in conversations you can see: channelId -> call
export const activeCalls = new Map();
export function onCallsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let rtcConfig = null;
let users = () => new Map();
let state = null; // the call you're in
let ringing = new Map(); // callId -> ring card
let unsub = null;
let joiningId = null; // call being joined: its signals are held until we're ready
let pending = [];

const me = () => auth.user;
const userName = (id) => (id === me()?.id ? "You" : users().get(id)?.name || "Someone");
const userObj = (id) => (id === me()?.id ? me() : users().get(id) || { id, name: "Someone", email: String(id) });

export function callsSupported() {
  return Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia);
}

function unsupportedMessage() {
  if (!window.isSecureContext) {
    return "Calls need a secure address: open the app over https:// (or on localhost). Browsers block the microphone and camera on plain http.";
  }
  return "This browser does not support calls. Use a current Chrome, Edge, Firefox or Safari.";
}

/** Start listening for call events. `getUsers` returns the chat's id -> user map. */
export function initCalls(getUsers) {
  users = getUsers;
  unsub?.();
  unsub = realtime.on(onEvent);
  refreshActive();
  window.addEventListener("beforeunload", hangUpOnUnload);
}

export function stopCalls() {
  unsub?.();
  unsub = null;
  if (state) leave({ silent: true });
  ringing.forEach((r) => r.close(false));
  ringing.clear();
  activeCalls.clear();
  window.removeEventListener("beforeunload", hangUpOnUnload);
}

async function refreshActive() {
  try {
    const list = await api.get("/chat/calls/active");
    activeCalls.clear();
    list.forEach((c) => activeCalls.set(c.channel_id, c));
    changed();
  } catch { /* not fatal */ }
}

function hangUpOnUnload() {
  if (!state) return;
  try {
    fetch(`/api/v1/chat/calls/${state.call.id}/leave`, { method: "POST", keepalive: true, headers: { Authorization: `Bearer ${auth.token}` } });
  } catch { /* closing anyway */ }
}

// ============================================================================ events
function onEvent(ev) {
  switch (ev.type) {
    case "_open":
      refreshActive();
      if (state) state.peers.forEach((p) => p.restartIfBroken());
      break;
    case "call.ring":
      activeCalls.set(ev.call.channel_id, { ...ev.call, channel_label: ev.channel_label });
      changed();
      if (!state || state.call.id !== ev.call.id) showRing(ev);
      break;
    case "call.update":
      activeCalls.set(ev.call.channel_id, { ...(activeCalls.get(ev.call.channel_id) || {}), ...ev.call });
      changed();
      if (state?.call.id === ev.call.id) {
        (ev.invited || []).forEach((id) => { if (id !== me().id) state.pending.set(id, Date.now() + RING_TIMEOUT_MS); });
        syncParticipants(ev.call, ev);
      }
      if (ev.call.participant_ids.includes(me().id)) ringing.get(ev.call.id)?.close(false);
      break;
    case "call.ended":
      activeCalls.delete(ev.call.channel_id);
      changed();
      ringing.get(ev.call.id)?.close(true);
      if (state?.call.id === ev.call.id) {
        const d = ev.call.duration_seconds;
        cleanup();
        sounds.end();
        toast(d != null ? `Call ended · ${fmtDuration(d)}` : "Call ended");
      }
      break;
    case "call.declined":
      if (state?.call.id === ev.call_id && ev.user?.id !== me().id) {
        toast(`${ev.user.name} declined the call`);
        state.pending.delete(ev.user.id);
        renderTiles();
      }
      if (ev.user?.id === me().id) ringing.get(ev.call_id)?.close(false);
      break;
    case "call.signal":
      if (state?.call.id === ev.call_id) onSignal(ev.from, ev.data);
      else if (joiningId === ev.call_id) pending.push([ev.from, ev.data]);
      break;
    default:
  }
}

// ============================================================================ ringing
function showRing(ev) {
  if (ringing.has(ev.call.id)) return;
  const { call } = ev;
  const caller = ev.from;
  const dm = ev.channel_kind === "dm";
  const where = ev.added
    ? `Added you to ${call.video ? "a video" : "an audio"} call${ev.channel_kind === "invite" ? "" : ` in ${ev.channel_label}`}`
    : dm ? (call.video ? "Video call" : "Audio call") : `${call.video ? "Video" : "Audio"} call in ${ev.channel_label}`;
  const close = (missed) => {
    sounds.stopRing();
    clearTimeout(timer);
    card.classList.add("out");
    setTimeout(() => card.remove(), 250);
    ringing.delete(call.id);
    notification?.close();
    if (missed) toast(`Missed call from ${caller.name}`);
  };
  const accept = async (video) => {
    close(false);
    await join(call.id, { video, label: dm ? caller.name : ev.channel_label, channelId: call.channel_id });
  };
  const decline = async () => {
    close(false);
    try { await api.post(`/chat/calls/${call.id}/decline`); } catch { /* the call may be over */ }
  };
  const card = h("div.call-ring", { role: "alertdialog", "aria-label": `Incoming call from ${caller.name}` },
    h("div.ring-avatar", avatar(caller, "lg"), h("span.ring-wave"), h("span.ring-wave.w2")),
    h("div.ring-text", h("strong", caller.name), h("span", where), state ? h("span.muted.small", "Accepting will end your current call") : null),
    h("div.ring-actions",
      h("button.call-btn.decline", { type: "button", title: "Decline", "aria-label": "Decline", onclick: decline }, icon("phone", { size: 20, cls: "hang" })),
      h("button.call-btn.accept", { type: "button", title: "Answer with audio", "aria-label": "Answer with audio", onclick: () => accept(false) }, icon("phone", { size: 20 })),
      h("button.call-btn.accept", { type: "button", title: "Answer with video", "aria-label": "Answer with video", onclick: () => accept(true) }, icon("video", { size: 20 }))));
  document.body.append(card);
  ringing.set(call.id, { close, card });
  sounds.ring();
  let notification = null;
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    try {
      notification = new Notification(`${caller.name} is calling`, { body: where, tag: `call-${call.id}`, requireInteraction: true });
      notification.onclick = () => { window.focus(); notification.close(); };
    } catch { /* not allowed from the page */ }
  }
  const timer = setTimeout(() => close(true), RING_TIMEOUT_MS);
}

// ============================================================================ starting / joining
/** Start a call in a conversation (joins the running one if there is one). */
export async function startCall(channelId, { video = false, label = "Call", dm = false } = {}) {
  if (!callsSupported()) { toast(unsupportedMessage(), "error"); return; }
  if (state) {
    if (state.call.channel_id === channelId) { expand(); return; }
    toast("You're already in a call - hang up first", "error");
    return;
  }
  const media = await getMedia(video);
  if (!media) return;
  try {
    joiningId = activeCalls.get(channelId)?.id ?? null;
    pending = [];
    const call = await api.post(`/chat/channels/${channelId}/calls`, { video });
    joiningId = call.id;
    await enter(call, media, { label, video, outgoing: dm && call.participant_ids.length <= 1 });
  } catch (err) {
    joiningId = null;
    media.getTracks().forEach((t) => t.stop());
    toast(err.message, "error");
  }
}

export async function join(callId, { video = false, label = "Call", channelId } = {}) {
  if (!callsSupported()) { toast(unsupportedMessage(), "error"); return; }
  if (state) {
    if (state.call.id === callId) { expand(); return; }
    await leave({ silent: true });
  }
  const media = await getMedia(video);
  if (!media) return;
  try {
    joiningId = callId;
    pending = [];
    const call = await api.post(`/chat/calls/${callId}/join`);
    await enter(call, media, { label, video, channelId });
  } catch (err) {
    joiningId = null;
    media.getTracks().forEach((t) => t.stop());
    toast(err.message, "error");
  }
}

export const currentCall = () => state?.call || null;

function audioConstraints(deviceId) {
  const clean = prefs.get("noiseSuppression") !== false;
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: clean,
    autoGainControl: clean,
    channelCount: 1,
    sampleRate: 48_000,
    sampleSize: 16,
  };
}

function videoConstraints(deviceId) {
  const q = QUALITY[prefs.get("quality") || "hd"] || QUALITY.hd;
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps, max: 30 },
    facingMode: deviceId ? undefined : "user",
  };
}

async function getMedia(video) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints(prefs.get("micId")),
      video: video ? videoConstraints(prefs.get("camId")) : false,
    });
  } catch (err) {
    if (video && (err.name === "NotFoundError" || err.name === "NotReadableError" || err.name === "OverconstrainedError")) {
      toast("Camera unavailable - joining with audio only", "error");
      return getMedia(false);
    }
    if (prefs.get("micId") && err.name === "OverconstrainedError") { prefs.set("micId", ""); return getMedia(video); }
    toast(err.name === "NotAllowedError" ? "Allow microphone (and camera) access in the browser to make calls" : `Could not start the microphone: ${err.message}`, "error");
    return null;
  }
}

async function enter(call, media, { label, video, outgoing = false, channelId }) {
  if (!rtcConfig) {
    try { rtcConfig = await api.get("/chat/rtc-config"); } catch { rtcConfig = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] }; }
  }
  state = {
    call, label, channelId: channelId ?? call.channel_id,
    local: media, screen: null, peers: new Map(), remoteState: new Map(),
    mic: true, cam: Boolean(video && media.getVideoTracks().length),
    startedAt: call.answered_at ? Date.now() : null,
    outgoing, minimized: false, layout: "grid", pinned: null, speaking: new Map(),
    pending: new Map(), // people rung into the call who haven't answered yet: id -> give-up time
  };
  buildUi();
  watchLevel(me().id, media);
  if (outgoing) {
    sounds.ringback();
    state.ringTimer = setTimeout(() => {
      if (state && state.peers.size === 0) { toast("No answer"); leave(); }
    }, RING_TIMEOUT_MS);
  } else sounds.join();
  syncParticipants(call);
  const held = pending;
  pending = [];
  joiningId = null;
  held.forEach(([from, data]) => onSignal(from, data));
  activeCalls.set(call.channel_id, call);
  changed();
}

// ============================================================================ peers
function syncParticipants(call, ev = {}) {
  if (!state) return;
  state.call = call;
  const others = call.participant_ids.filter((id) => id !== me().id);
  if (others.length && state.outgoing) {
    state.outgoing = false;
    sounds.stopRingback();
    clearTimeout(state.ringTimer);
  }
  if (others.length && !state.startedAt) state.startedAt = Date.now();
  for (const id of others) {
    state.pending.delete(id);
    if (!state.peers.has(id)) addPeer(id);
  }
  for (const [id, peer] of state.peers) {
    if (!others.includes(id)) {
      peer.close();
      state.peers.delete(id);
      sounds.leave();
    }
  }
  if (ev.joined && ev.joined !== me().id) sounds.join();
  renderTiles();
}

function addPeer(id) {
  const peer = new Peer(id);
  state.peers.set(id, peer);
  return peer;
}

function signal(to, data) {
  if (!state) return;
  realtime.send({ type: "call.signal", call_id: state.call.id, to, data });
}

function onSignal(from, data) {
  if (!state) return;
  if (data.state) {
    const before = state.remoteState.get(from);
    state.remoteState.set(from, data.state);
    if (data.state.hand && !before?.hand) { toast(`✋ ${userName(from)} raised a hand`); sounds.join(); }
    renderTiles();
    return;
  }
  if (data.reaction) {
    if (CALL_REACTIONS.includes(data.reaction)) showReaction(from, data.reaction);
    return;
  }
  const peer = state.peers.get(from) || addPeer(from);
  peer.handle(data).catch((err) => console.warn("signal failed", err));
}

class Peer {
  constructor(id) {
    this.id = id;
    this.polite = me().id > id; // perfect negotiation: one side yields on collisions
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.stream = new MediaStream();
    this.pc = new RTCPeerConnection({ iceServers: rtcConfig.iceServers, bundlePolicy: "max-bundle", iceCandidatePoolSize: 2 });
    const pc = this.pc;
    state.local.getAudioTracks().forEach((t) => pc.addTrack(t, state.local));
    const v = currentVideoTrack();
    if (v) pc.addTrack(v, state.local);
    pc.ontrack = ({ track }) => {
      this.stream.addTrack(track);
      track.onunmute = () => renderTiles();
      track.onmute = () => renderTiles();
      track.onended = () => { this.stream.removeTrack(track); renderTiles(); };
      if (track.kind === "audio") watchLevel(id, this.stream);
      renderTiles();
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) signal(id, { candidate: candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        signal(id, { description: pc.localDescription.toJSON() });
      } catch (err) {
        console.warn(err);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") { this.tune(); sendState(); }
      if (pc.connectionState === "failed") pc.restartIce();
      renderTiles();
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "disconnected") {
        clearTimeout(this.iceTimer);
        this.iceTimer = setTimeout(() => { if (pc.iceConnectionState === "disconnected") pc.restartIce(); }, 3000);
      }
    };
  }

  async handle({ description, candidate }) {
    const pc = this.pc;
    if (description) {
      const collision = description.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === "offer") {
        await pc.setLocalDescription();
        signal(this.id, { description: pc.localDescription.toJSON() });
      }
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); } catch (err) { if (!this.ignoreOffer) console.warn(err); }
    }
  }

  /** Higher Opus bitrate for voice clarity; camera keeps its frame rate, screens keep their detail. */
  async tune() {
    const q = QUALITY[prefs.get("quality") || "hd"] || QUALITY.hd;
    for (const sender of this.pc.getSenders()) {
      if (!sender.track) continue;
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        if (sender.track.kind === "audio") {
          p.encodings[0].maxBitrate = AUDIO_BITRATE;
          p.encodings[0].priority = "high";
          p.encodings[0].networkPriority = "high";
        } else {
          const screen = state.screen && sender.track === state.screen.getVideoTracks()[0];
          p.encodings[0].maxBitrate = screen ? 2_500_000 : q.bitrate;
          p.degradationPreference = screen ? "maintain-resolution" : "balanced";
        }
        await sender.setParameters(p);
      } catch { /* not every browser lets us tune this */ }
    }
  }

  async setVideo(track) {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "video" || (s.track === null && s._video));
    if (sender) {
      await sender.replaceTrack(track);
      sender._video = true;
    } else if (track) {
      const s = this.pc.addTrack(track, state.local);
      s._video = true;
    }
    this.tune();
  }

  async setAudio(track) {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "audio");
    if (sender) await sender.replaceTrack(track);
    this.tune();
  }

  restartIfBroken() {
    if (["failed", "disconnected"].includes(this.pc.iceConnectionState)) this.pc.restartIce();
  }

  close() {
    clearTimeout(this.iceTimer);
    try { this.pc.close(); } catch { /* already closed */ }
    stopLevel(this.id);
  }
}

function currentVideoTrack() {
  if (state.screen) return state.screen.getVideoTracks()[0] || null;
  return state.cam ? state.local.getVideoTracks()[0] || null : null;
}

function sendState() {
  if (!state) return;
  const data = { state: { mic: state.mic, cam: state.cam, screen: Boolean(state.screen), hand: Boolean(state.hand) } };
  for (const id of state.peers.keys()) signal(id, data);
}

// ============================================================================ controls
async function toggleMic() {
  state.mic = !state.mic;
  state.local.getAudioTracks().forEach((t) => { t.enabled = state.mic; });
  sendState();
  renderControls();
  renderTiles();
}

async function toggleCam() {
  if (state.cam) {
    state.cam = false;
    state.local.getVideoTracks().forEach((t) => { t.stop(); state.local.removeTrack(t); });
    if (!state.screen) for (const p of state.peers.values()) await p.setVideo(null);
  } else {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(prefs.get("camId")) });
      const track = s.getVideoTracks()[0];
      track.contentHint = "motion";
      state.local.getVideoTracks().forEach((t) => { t.stop(); state.local.removeTrack(t); });
      state.local.addTrack(track);
      state.cam = true;
      if (!state.screen) for (const p of state.peers.values()) await p.setVideo(track);
    } catch (err) {
      toast(err.name === "NotAllowedError" ? "Allow camera access in the browser" : `Camera unavailable: ${err.message}`, "error");
      return;
    }
  }
  sendState();
  renderControls();
  renderTiles();
}

async function toggleScreen() {
  if (state.screen) return stopScreen();
  if (!navigator.mediaDevices.getDisplayMedia) { toast("Screen sharing isn't supported in this browser", "error"); return undefined; }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const track = s.getVideoTracks()[0];
    track.contentHint = "detail"; // sharp text over smooth motion
    track.onended = () => stopScreen();
    state.screen = s;
    for (const p of state.peers.values()) await p.setVideo(track);
    state.pinned = me().id;
    state.layout = "spotlight";
  } catch (err) {
    if (err.name !== "NotAllowedError") toast(`Could not share the screen: ${err.message}`, "error");
    return undefined;
  }
  sendState();
  renderControls();
  renderTiles();
  return undefined;
}

async function stopScreen() {
  if (!state?.screen) return;
  state.screen.getTracks().forEach((t) => t.stop());
  state.screen = null;
  state.screenView = null;
  const cam = state.cam ? state.local.getVideoTracks()[0] : null;
  for (const p of state.peers.values()) await p.setVideo(cam || null);
  if (state.pinned === me().id) { state.pinned = null; state.layout = "grid"; }
  sendState();
  renderControls();
  renderTiles();
}

async function switchMic(deviceId) {
  prefs.set("micId", deviceId);
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId) });
    const track = s.getAudioTracks()[0];
    track.enabled = state.mic;
    state.local.getAudioTracks().forEach((t) => { t.stop(); state.local.removeTrack(t); });
    state.local.addTrack(track);
    for (const p of state.peers.values()) await p.setAudio(track);
    watchLevel(me().id, state.local);
    toast("Microphone switched");
  } catch (err) { toast(`Could not use that microphone: ${err.message}`, "error"); }
}

async function switchCam(deviceId) {
  prefs.set("camId", deviceId);
  if (!state.cam) return;
  state.cam = false;
  state.local.getVideoTracks().forEach((t) => { t.stop(); state.local.removeTrack(t); });
  await toggleCam();
}

function switchSpeaker(deviceId) {
  prefs.set("speakerId", deviceId);
  state?.ui?.root.querySelectorAll("video, audio").forEach((el) => { if (el.setSinkId) el.setSinkId(deviceId).catch(() => {}); });
}

async function applyAudioProcessing(on) {
  prefs.set("noiseSuppression", on);
  for (const t of state.local.getAudioTracks()) {
    try { await t.applyConstraints({ ...audioConstraints(prefs.get("micId")), deviceId: undefined }); } catch { /* restart mic below */ }
  }
  toast(on ? "Noise suppression on - best for voice" : "Original sound - best for music");
}

async function applyQuality(key) {
  prefs.set("quality", key);
  const track = state.local.getVideoTracks()[0];
  if (track) { try { await track.applyConstraints(videoConstraints(prefs.get("camId"))); } catch { /* keep current */ } }
  for (const p of state.peers.values()) p.tune();
  toast(`Video quality: ${QUALITY[key].label}`);
}

export async function leave({ silent = false } = {}) {
  if (!state) return;
  const id = state.call.id;
  cleanup();
  if (!silent) sounds.end();
  try { await api.post(`/chat/calls/${id}/leave`); } catch { /* server hangs up stale calls itself */ }
}

function cleanup() {
  if (!state) return;
  sounds.stopRingback();
  clearTimeout(state.ringTimer);
  clearInterval(state.clock);
  state.peers.forEach((p) => p.close());
  state.local.getTracks().forEach((t) => t.stop());
  state.screen?.getTracks().forEach((t) => t.stop());
  stopLevel(me().id);
  state.ui?.root.remove();
  document.removeEventListener("keydown", state.ui?.onKey);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  state = null;
  changed();
}

// ============================================================================ speaking levels
const meters = new Map();
let meterCtx = null;
let meterTimer = null;

function watchLevel(id, stream) {
  stopLevel(id);
  if (!stream.getAudioTracks().length) return;
  try {
    meterCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (meterCtx.state === "suspended") meterCtx.resume().catch(() => {});
    const src = meterCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const an = meterCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    meters.set(id, { src, an, buf: new Uint8Array(an.fftSize), level: 0 });
  } catch { return; }
  if (!meterTimer) {
    meterTimer = setInterval(() => {
      if (!state) return;
      for (const [uid, m] of meters) {
        m.an.getByteTimeDomainData(m.buf);
        let sum = 0;
        for (const v of m.buf) sum += (v - 128) ** 2;
        const rms = Math.sqrt(sum / m.buf.length) / 128;
        m.level = m.level * 0.6 + rms * 0.4;
        const muted = uid === me().id ? !state.mic : state.remoteState.get(uid)?.mic === false;
        const tile = state.ui?.root.querySelector(`.call-tile[data-id="${uid}"]`);
        if (tile) {
          tile.classList.toggle("speaking", !muted && m.level > 0.035);
          tile.style.setProperty("--level", String(Math.min(1, m.level * 8)));
        }
      }
    }, 120);
  }
}

function stopLevel(id) {
  const m = meters.get(id);
  if (!m) return;
  try { m.src.disconnect(); } catch { /* gone */ }
  meters.delete(id);
  if (!meters.size) { clearInterval(meterTimer); meterTimer = null; }
}

// ============================================================================ UI
function buildUi() {
  const root = h("div.call-ui", { role: "dialog", "aria-label": "Call" });
  const head = h("div.call-head");
  const stage = h("div.call-stage");
  const controls = h("div.call-controls");
  root.append(head, stage, controls);
  document.body.append(root);
  const onKey = (e) => {
    if (!state || e.target.closest?.("input, textarea, [contenteditable]")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); toggleMic(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") { e.preventDefault(); toggleCam(); }
  };
  document.addEventListener("keydown", onKey);
  state.ui = { root, head, stage, controls, onKey, videos: new Map() };
  state.clock = setInterval(() => {
    renderHead();
    if ([...state.pending.values()].some((t) => t < Date.now())) renderTiles();
  }, 1000);
  makeDraggable(root, head);
  renderHead();
  renderControls();
  renderTiles();
}

function makeDraggable(root, handle) {
  let start = null;
  handle.addEventListener("pointerdown", (e) => {
    if (!root.classList.contains("mini") || e.target.closest("button")) return;
    const r = root.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!start) return;
    const left = Math.max(8, Math.min(innerWidth - root.offsetWidth - 8, start.left + e.clientX - start.x));
    const top = Math.max(8, Math.min(innerHeight - root.offsetHeight - 8, start.top + e.clientY - start.y));
    Object.assign(root.style, { left: `${left}px`, top: `${top}px`, right: "auto", bottom: "auto" });
  });
  handle.addEventListener("pointerup", () => { start = null; });
}

function expand() {
  if (!state) return;
  state.minimized = false;
  state.ui.root.classList.remove("mini");
  Object.assign(state.ui.root.style, { left: "", top: "", right: "", bottom: "" });
  renderControls();
  renderTiles();
}

function minimize() {
  state.minimized = true;
  state.ui.root.classList.add("mini");
  renderControls();
  renderTiles();
}

function renderHead() {
  if (!state?.ui) return;
  const n = state.call.participant_ids.length;
  const status = state.outgoing ? "Ringing…" : state.startedAt ? fmtDuration(Math.floor((Date.now() - state.startedAt) / 1000)) : "Waiting for others…";
  const quality = connectionQuality();
  clear(state.ui.head,
    h("div.call-head-title",
      h("span.call-live", icon(state.call.video ? "video" : "phone", { size: 14 })),
      h("strong", state.label),
      h("span.call-status", status),
      n > 1 ? h("span.call-people", icon("users", { size: 13 }), String(n)) : null,
      quality ? h(`span.call-net.${quality}`, { title: `Connection: ${quality}` }, h("i"), h("i"), h("i")) : null),
    h("div.call-head-actions",
      state.minimized
        ? h("button.icon-btn", { type: "button", title: "Expand", "aria-label": "Expand call", onclick: expand }, icon("maximize", { size: 16 }))
        : h("button.icon-btn", { type: "button", title: "Minimize", "aria-label": "Minimize call", onclick: minimize }, icon("minimize", { size: 16 }))));
}

function connectionQuality() {
  if (!state.peers.size) return null;
  const states = [...state.peers.values()].map((p) => p.pc.connectionState);
  if (states.some((s) => s === "failed" || s === "disconnected")) return "poor";
  if (states.some((s) => s === "connecting" || s === "new")) return "fair";
  return "good";
}

function ctl(ic, label, run, { on = true, danger = false, cls = "" } = {}) {
  return h(`button.call-ctl${on ? "" : ".off"}${danger ? ".danger" : ""}${cls ? "." + cls : ""}`, {
    type: "button", title: label, "aria-label": label, "aria-pressed": danger ? undefined : String(on), onclick: run,
  }, icon(ic, { size: 20, cls: danger ? "hang" : "" }), h("span.call-ctl-label", label.split(" (")[0]));
}

function renderControls() {
  if (!state?.ui) return;
  const mini = state.minimized;
  clear(state.ui.controls,
    ctl(state.mic ? "mic" : "mic-off", state.mic ? "Mute (Ctrl+D)" : "Unmute (Ctrl+D)", toggleMic, { on: state.mic }),
    ctl(state.cam ? "video" : "video-off", state.cam ? "Stop video (Ctrl+E)" : "Start video (Ctrl+E)", toggleCam, { on: state.cam }),
    mini ? null : ctl("screen-share", state.screen ? "Stop sharing" : "Share screen", toggleScreen, { on: !state.screen, cls: state.screen ? "sharing" : "" }),
    ctl("smile", "React", (e) => reactMenu(e.currentTarget)),
    mini ? null : ctl("hand", state.hand ? "Lower hand" : "Raise hand", toggleHand, { on: !state.hand, cls: state.hand ? "hand-up" : "" }),
    mini ? null : ctl("user-plus", "Add people", (e) => addPeopleMenu(e.currentTarget)),
    mini ? null : ctl("grid", state.layout === "grid" ? "Spotlight" : "Grid", () => { state.layout = state.layout === "grid" ? "spotlight" : "grid"; renderControls(); renderTiles(); }),
    mini ? null : ctl("settings", "Settings", (e) => settingsMenu(e.currentTarget)),
    mini ? null : ctl("maximize", document.fullscreenElement ? "Exit full screen" : "Full screen", toggleFullscreen),
    ctl("phone", "Leave", () => leave(), { danger: true }));
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else state.ui.root.requestFullscreen?.().catch(() => {});
  setTimeout(renderControls, 200);
}

function tileFor(id, stream, { local = false } = {}) {
  const ui = state.ui;
  const rs = local ? { mic: state.mic, cam: state.cam, screen: Boolean(state.screen), hand: Boolean(state.hand) } : state.remoteState.get(id) || {};
  const videoTrack = stream?.getVideoTracks().find((t) => t.readyState === "live" && !t.muted);
  const showVideo = Boolean(videoTrack) && (local ? (state.cam || state.screen) : rs.cam !== false || rs.screen);
  let video = ui.videos.get(id);
  if (!video) {
    video = h("video", { autoplay: true, playsInline: true, muted: local });
    video.muted = local;
    ui.videos.set(id, video);
    const sink = prefs.get("speakerId");
    if (sink && video.setSinkId) video.setSinkId(sink).catch(() => {});
  }
  if (video.srcObject !== stream) video.srcObject = stream || null;
  video.play?.().catch(() => {});
  const u = userObj(id);
  const peer = state.peers.get(id);
  const conn = peer?.pc.connectionState;
  const mirrored = local && !state.screen;
  const tile = h(`div.call-tile${showVideo ? ".has-video" : ""}${mirrored ? ".mirror" : ""}${state.pinned === id ? ".pinned" : ""}${rs.screen ? ".screen" : ""}`, {
    dataset: { id },
    ondblclick: () => { state.pinned = state.pinned === id ? null : id; state.layout = state.pinned ? "spotlight" : "grid"; renderControls(); renderTiles(); },
    title: "Double-click to spotlight",
  },
  video,
  showVideo ? null : h("div.call-tile-avatar", avatar(u, "lg"), h("span.call-ring-level")),
  h("div.call-tile-name", rs.mic === false ? icon("mic-off", { size: 13, cls: "muted-ic" }) : null,
    h("span", local ? `${u.name} (you)` : u.name), rs.screen ? h("span.tile-tag", "Screen") : null),
  rs.hand ? h("div.call-hand", { title: "Hand raised" }, "✋") : null,
  !local && conn && conn !== "connected" ? h("div.call-tile-state", conn === "failed" ? "Reconnecting…" : "Connecting…") : null);
  if (!showVideo) video.classList.add("hidden-video"); else video.classList.remove("hidden-video");
  return tile;
}

function renderTiles() {
  if (!state?.ui) return;
  renderHead();
  const tiles = [];
  for (const [id, peer] of state.peers) tiles.push(tileFor(id, peer.stream));
  if (state.screen && !state.screenView) state.screenView = new MediaStream(state.screen.getVideoTracks());
  const localStream = state.screen ? state.screenView : state.local;
  if (state.ui.localStreamKey !== (state.screen ? "screen" : "cam")) { state.ui.videos.delete(me().id); state.ui.localStreamKey = state.screen ? "screen" : "cam"; }
  const self = tileFor(me().id, localStream, { local: true });
  const now = Date.now();
  for (const [id, until] of state.pending) {
    if (until < now) { state.pending.delete(id); toast(`${userName(id)} didn't answer`); }
  }
  const ringingTiles = [...state.pending.keys()].map((id) => h("div.call-tile.ringing", { dataset: { id } },
    h("div.call-tile-avatar", avatar(userObj(id), "lg"), h("span.ring-wave"), h("span.ring-wave.w2")),
    h("div.call-tile-name", h("span", userObj(id).name)),
    h("div.call-tile-state", "Ringing…")));
  const stage = state.ui.stage;
  const count = tiles.length + 1 + (state.minimized ? 0 : ringingTiles.length);
  stage.className = `call-stage layout-${state.minimized ? "mini" : state.layout} n${Math.min(count, 9)}`;
  if (!tiles.length && !ringingTiles.length) {
    clear(stage, self, h("div.call-waiting", state.outgoing ? h("span", "Calling ", h("strong", state.label), "…") : h("span", "Waiting for others to join…")));
    return;
  }
  if (state.minimized) {
    clear(stage, tiles, self); // extra tiles are hidden by CSS but stay in the page so their audio keeps playing
    return;
  }
  if (state.layout === "spotlight") {
    const pinnedId = state.pinned ?? [...state.peers.keys()][0];
    const all = [...tiles, self];
    const main = all.find((t) => Number(t.dataset.id) === pinnedId) || tiles[0] || self;
    clear(stage, h("div.call-main", main), h("div.call-strip", all.filter((t) => t !== main), ringingTiles));
    return;
  }
  clear(stage, tiles, self, ringingTiles);
}

function toggleHand() {
  state.hand = !state.hand;
  sendState();
  renderControls();
  renderTiles();
}

function reactMenu(anchor) {
  const old = state.ui.root.querySelector(".call-react-bar");
  if (old) { old.remove(); return; }
  const bar = h("div.call-react-bar", { role: "toolbar", "aria-label": "Send a reaction" },
    CALL_REACTIONS.map((e) => h("button.call-react", { type: "button", title: `Send ${e}`, onclick: () => sendReaction(e) }, e)));
  state.ui.root.append(bar);
  const r = anchor.getBoundingClientRect();
  const root = state.ui.root.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left - root.left + r.width / 2 - bar.offsetWidth / 2, root.width - bar.offsetWidth - 8));
  bar.style.left = `${left}px`;
  bar.style.bottom = `${root.bottom - r.top + 10}px`;
  const close = (ev) => { if (!bar.contains(ev.target) && !anchor.contains(ev.target)) { bar.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

let lastReaction = 0;
function sendReaction(e) {
  const now = Date.now();
  if (now - lastReaction < 350) return; // a little rate limit so nobody floods the call
  lastReaction = now;
  showReaction(me().id, e);
  for (const id of state.peers.keys()) signal(id, { reaction: e });
}

/** Float the emoji up from the sender's tile (big, wobbling) and shower the call for party ones. */
function showReaction(uid, e) {
  if (!state?.ui) return;
  const root = state.ui.root;
  const box = root.getBoundingClientRect();
  const tile = root.querySelector(`.call-tile[data-id="${uid}"]`);
  const t = tile ? tile.getBoundingClientRect() : { left: box.left + box.width / 2 - 40, width: 80, bottom: box.bottom - 120 };
  const motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fx = h("div.call-fx", {
    style: { left: `${t.left - box.left + t.width / 2 + (Math.random() - 0.5) * Math.min(120, t.width / 2)}px`, top: `${t.bottom - box.top - 70}px`, "--sway": `${(Math.random() - 0.5) * 60}px` },
  }, h("span.call-fx-e", e), h("span.call-fx-name", uid === me().id ? "You" : userName(uid).split(" ")[0]));
  root.append(fx);
  setTimeout(() => fx.remove(), 3200);
  if (motion && SHOWER.test(e) && prefs.get("effects") !== false) {
    const layer = h("div.call-shower");
    for (let i = 0; i < 18; i++) {
      layer.append(h("span", {
        style: { left: `${Math.random() * 96}%`, fontSize: `${20 + Math.random() * 26}px`, "--d": `${1.8 + Math.random() * 1.4}s`, "--delay": `${Math.random() * 0.5}s`, "--x": `${(Math.random() - 0.5) * 140}px`, "--r": `${(Math.random() - 0.5) * 500}deg` },
      }, e));
    }
    state.ui.stage.append(layer);
    setTimeout(() => layer.remove(), 3800);
  }
  if (uid !== me().id) sounds.message(true);
}

function addPeopleMenu(anchor) {
  document.querySelector(".call-settings")?.remove();
  const inCall = new Set([me().id, ...state.call.participant_ids, ...state.pending.keys()]);
  const chosen = new Set();
  const search = h("input.call-search", { type: "search", placeholder: "Search people…", "aria-label": "Search people" });
  const list = h("ul.call-people-list", { role: "listbox" });
  const ring = h("button.call-ring-btn", { type: "button", disabled: true }, icon("phone", { size: 15 }), h("span", "Ring"));
  const max = rtcConfig?.maxPeople || 8;
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const people = [...users().values()].filter((u) => !inCall.has(u.id) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)));
    clear(list, people.slice(0, 60).map((u) => h(`li${chosen.has(u.id) ? ".on" : ""}`, {
      role: "option", "aria-selected": String(chosen.has(u.id)),
      onclick: () => {
        if (chosen.has(u.id)) chosen.delete(u.id);
        else if (state.call.participant_ids.length + state.pending.size + chosen.size >= max) { toast(`Calls are limited to ${max} people`, "error"); return; }
        else chosen.add(u.id);
        paint();
      },
    }, avatar(u, "sm"), h("span.cp-name", u.name, h("span", u.designation || u.email)),
    u.online ? h("span.cp-online", "Online") : null, h("span.cp-check", icon("check", { size: 12 })))),
    people.length ? null : h("li.cp-none", q ? "No one found" : "Everyone is already in the call"));
    ring.disabled = !chosen.size;
    ring.querySelector("span").textContent = chosen.size ? `Ring ${chosen.size} ${chosen.size === 1 ? "person" : "people"}` : "Ring";
  };
  search.addEventListener("input", paint);
  ring.addEventListener("click", async () => {
    ring.disabled = true;
    try {
      const ids = [...chosen];
      const call = await api.post(`/chat/calls/${state.call.id}/invite`, { user_ids: ids });
      ids.forEach((id) => state.pending.set(id, Date.now() + RING_TIMEOUT_MS));
      panel.remove();
      syncParticipants(call);
      toast(`Ringing ${ids.map((id) => userObj(id).name.split(" ")[0]).join(", ")}…`);
    } catch (err) {
      toast(err.message, "error");
      ring.disabled = false;
    }
  });
  const panel = h("div.call-settings.call-add",
    h("div.call-set-head", h("strong", "Add people to the call"), h("button.icon-btn.sm", { type: "button", "aria-label": "Close", onclick: () => panel.remove() }, icon("x", { size: 14 }))),
    h("p.muted.small.call-set-tip", "They'll get a ring right away - even if they're not in this conversation."),
    search, list, ring);
  state.ui.root.append(panel);
  const r = anchor.getBoundingClientRect();
  const root = state.ui.root.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(r.left - root.left - 140, root.width - 330))}px`;
  panel.style.bottom = `${root.bottom - r.top + 8}px`;
  paint();
  setTimeout(() => search.focus(), 0);
}

async function settingsMenu(anchor) {
  document.querySelector(".call-settings")?.remove();
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* permission not granted */ }
  const pick = (kind, current, onChange, label) => {
    const list = devices.filter((d) => d.kind === kind);
    if (!list.length) return null;
    const sel = h("select", { onchange: (e) => onChange(e.target.value) },
      list.map((d, i) => h("option", { value: d.deviceId, selected: d.deviceId === current }, d.label || `${label} ${i + 1}`)));
    return h("label.call-set-row", h("span", label), sel);
  };
  const micTrack = state.local.getAudioTracks()[0];
  const camTrack = state.local.getVideoTracks()[0];
  const panel = h("div.call-settings",
    h("div.call-set-head", h("strong", "Call settings"), h("button.icon-btn.sm", { type: "button", "aria-label": "Close", onclick: () => panel.remove() }, icon("x", { size: 14 }))),
    pick("audioinput", micTrack?.getSettings().deviceId || prefs.get("micId"), switchMic, "Microphone"),
    pick("videoinput", camTrack?.getSettings().deviceId || prefs.get("camId"), switchCam, "Camera"),
    "setSinkId" in HTMLMediaElement.prototype ? pick("audiooutput", prefs.get("speakerId"), switchSpeaker, "Speaker") : null,
    h("label.call-set-row", h("span", "Video quality"),
      h("select", { onchange: (e) => applyQuality(e.target.value) },
        Object.entries(QUALITY).map(([k, q]) => h("option", { value: k, selected: (prefs.get("quality") || "hd") === k }, q.label)))),
    h("label.call-set-check", h("input", { type: "checkbox", checked: prefs.get("noiseSuppression") !== false, onchange: (e) => applyAudioProcessing(e.target.checked) }),
      h("span", h("strong", "Noise suppression"), h("span.muted.small", "Removes keyboard and background noise. Turn off for music."))),
    h("p.muted.small.call-set-tip", "Tip: use headphones for the clearest sound, and a wired connection for the steadiest video."));
  state.ui.root.append(panel);
  const r = anchor.getBoundingClientRect();
  const root = state.ui.root.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(r.left - root.left - 140, root.width - 330))}px`;
  panel.style.bottom = `${root.bottom - r.top + 8}px`;
}

export function fmtDuration(s) {
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}
