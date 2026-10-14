// Thin wrapper over the REST API: attaches the JWT, unwraps errors into readable messages.
const BASE = "/api/v1";
const TOKEN_KEY = "tickets.token";

export const auth = {
  get token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set token(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* storage unavailable: session lasts until reload */ }
  },
  user: null,
};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function errorMessage(body, status) {
  const detail = body && body.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{loc: [...], msg: "..."}]
    return detail.map((d) => {
      const field = (d.loc || []).filter((p) => p !== "body" && p !== "query").join(".");
      return field ? `${field}: ${d.msg}` : d.msg;
    }).join("; ");
  }
  return `Request failed (${status})`;
}

function qs(params) {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => sp.append(key, v));
    else sp.append(key, value);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function request(method, path, { params, json, form, raw } = {}) {
  const headers = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    body = form; // FormData or URLSearchParams; the browser sets Content-Type
  }

  const res = await fetch(BASE + path + qs(params), { method, headers, body });
  if (res.status === 401 && path !== "/auth/login") {
    onUnauthorized();
    throw new ApiError(401, "Your session has expired. Please log in again.");
  }
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, errorMessage(await res.json().catch(() => null), res.status));
    return res;
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, errorMessage(data, res.status));
  return data;
}

export const api = {
  get: (path, params) => request("GET", path, { params }),
  post: (path, json) => request("POST", path, { json }),
  patch: (path, json) => request("PATCH", path, { json }),
  del: (path) => request("DELETE", path),
  upload: (path, form) => request("POST", path, { form }),

  async login(email, password) {
    const form = new URLSearchParams({ username: email, password });
    const data = await request("POST", "/auth/login", { form });
    auth.token = data.access_token;
    auth.user = data.user;
    return data.user;
  },

  async download(attachment) {
    const res = await request("GET", `/attachments/${attachment.id}/download`, { raw: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: attachment.filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
