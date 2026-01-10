const BASE = import.meta.env.VITE_API_URL;
const TOKEN_KEY = "pwa_auth_token";

function norm(path) {
  if (!path.startsWith("/")) path = `/${path}`;
  // mantém sua regra: adiciona "/" no final quando não tem "?" e não é "/"
  if (path !== "/" && !path.includes("?") && !path.endsWith("/")) path += "/";
  return path;
}

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function buildHeaders({ auth } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = getStoredToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function apiRequest(path, { method = "GET", body, auth = true } = {}) {
  const p = norm(path);
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: buildHeaders({ auth }),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${method} ${p} -> ${res.status} ${t}`.trim());
  }

  if (res.status === 204) return null;
  return res.json();
}

export async function apiGet(path, options) {
  return apiRequest(path, { ...options, method: "GET" });
}

export async function apiPost(path, body, options) {
  return apiRequest(path, { ...options, method: "POST", body });
}

// ===============================
// AUTH
// ===============================
export async function login(payload) {
  return apiPost("/auth/login", payload, { auth: false });
}

export async function fetchMe() {
  return apiGet("/me");
}

export async function probeAuthSupport() {
  const p = norm("/me");
  const res = await fetch(`${BASE}${p}`, {
    method: "GET",
    headers: buildHeaders({ auth: false }),
  });

  if (res.status === 404) return false;
  return true;
}

// ===============================
// SUBRESPONSÁVEIS
// ===============================
export async function searchSubresponsaveis(query = "") {
  // aqui NÃO pode adicionar "/" no final depois do "?" (sua norm já evita isso)
  return apiGet(`/subresponsaveis?query=${encodeURIComponent(query)}`);
}

export async function definirPin(subId, pin) {
  return apiPost(`/subresponsaveis/${subId}/definir-pin`, { pin });
}

// ===============================
// MOVIMENTOS
// ===============================
export async function distribuir(payload) {
  return apiPost(`/movimentos/distribuir`, payload);
}

export async function recolher(payload) {
  return apiPost(`/movimentos/recolher`, payload);
}
