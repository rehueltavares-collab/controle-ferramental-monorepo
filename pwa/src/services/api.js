const BASE = import.meta.env.VITE_API_URL;

function getToken() {
  return (
    localStorage.getItem("token") ||
    localStorage.getItem("access_token") ||
    localStorage.getItem("auth_token") ||
    localStorage.getItem("jwt")
  );
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function norm(path) {
  if (!path.startsWith("/")) path = `/${path}`;
  return path;
}

export async function apiGet(path) {
  const p = norm(path);
  const url = `${BASE}${p}`;
  const res = await fetch(url, { headers: { ...authHeaders() } });
  if (!res.ok) {
    console.error("apiGet failed", { url, status: res.status });
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  return res.json();
}

export async function apiPost(path, body) {
  const p = norm(path);
  const url = `${BASE}${p}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("apiPost failed", { url, status: res.status });
    throw new Error(`POST ${url} -> ${res.status} ${t}`);
  }
  return res.json();
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

// ===============================
// TERMOS
// ===============================
export async function criarTermo(payload) {
  return apiPost(`/termos/`, payload);
}

export async function termosMinha() {
  return apiGet(`/termos/minha`);
}

// ===============================
// AUTH
// ===============================
export async function login(username, password) {
  return apiPost(`/auth/login`, { username, password });
}

export async function definirSenha(nova_senha) {
  return apiPost(`/auth/definir-senha`, { nova_senha });
}

// ===============================
// MANUAIS
// ===============================
export async function listarManuais(query = "") {
  return apiGet(`/manuais/itens?query=${encodeURIComponent(query)}`);
}

export async function entregarManual(payload) {
  return apiPost(`/manuais/entregar`, payload);
}

// ===============================
// ADMIN
// ===============================
export async function adminPessoas(query = "") {
  return apiGet(`/admin/pessoas?query=${encodeURIComponent(query)}`);
}

export async function adminBusca({ query = "", setorId = "" }) {
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  if (setorId) params.set("setor_id", String(setorId));
  return apiGet(`/admin/busca?${params.toString()}`);
}

export async function adminManualPosse({ query = "", setorId = "", pessoaTipo = "", pessoaId = "" }) {
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  if (setorId) params.set("setor_id", String(setorId));
  if (pessoaTipo) params.set("pessoa_tipo", pessoaTipo);
  if (pessoaId) params.set("pessoa_id", String(pessoaId));
  return apiGet(`/admin/manual-posse?${params.toString()}`);
}

export async function adminTrilhaKit(kitId) {
  return apiGet(`/admin/trilha/kit/${kitId}`);
}

export async function adminTrilhaPatrimonio(patrimonio) {
  return apiGet(`/admin/trilha/patrimonio/${encodeURIComponent(patrimonio)}`);
}
