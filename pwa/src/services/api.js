const BASE = import.meta.env.VITE_API_URL;

function norm(path) {
  if (!path.startsWith("/")) path = `/${path}`;
  // adiciona "/" no final quando não tem "?" e não é "/"
  if (path !== "/" && !path.includes("?") && !path.endsWith("/")) path += "/";
  return path;
}

export async function apiGet(path) {
  const p = norm(path);
  const res = await fetch(`${BASE}${p}`);
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
  return res.json();
}

export async function apiPost(path, body) {
  const p = norm(path);
  const res = await fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`POST ${p} -> ${res.status} ${t}`);
  }
  return res.json();
}

// ===============================
// DADOS BASE (PWA)
// ===============================
export async function listSetores() {
  return apiGet("/setores");
}

export async function listEncarregados(setorId = null) {
  if (setorId == null) return apiGet("/encarregados");
  return apiGet(`/encarregados?setor_id=${encodeURIComponent(setorId)}`);
}

export async function listKits(setorId = null) {
  if (setorId == null) return apiGet("/kits");
  return apiGet(`/kits?setor_id=${encodeURIComponent(setorId)}`);
}

export async function listItens() {
  return apiGet("/itens");
}

export async function listKitItens(kitId) {
  return apiGet(`/kits/${kitId}/itens`);
}

export async function listKitItensDetalhados(kitId) {
  return apiGet(`/kits/${kitId}/itens-detalhados`);
}

// ===============================
// CHECKLIST SEMANAL
// ===============================
export async function criarChecklistSemanal(payload) {
  return apiPost("/checklists-semanais", payload);
}

export async function listChecklistsSemanais() {
  return apiGet("/checklists-semanais");
}

// ===============================
// SUBRESPONSÁVEIS
// ===============================
export async function searchSubresponsaveis(query = "") {
  // não pode adicionar "/" no final depois do "?" (norm já evita)
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
