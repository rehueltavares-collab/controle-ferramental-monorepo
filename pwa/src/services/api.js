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

function clearStoredToken() {
  localStorage.removeItem("token");
  localStorage.removeItem("access_token");
  localStorage.removeItem("auth_token");
  localStorage.removeItem("jwt");
}

function handleUnauthorized() {
  clearStoredToken();
  window.dispatchEvent(new CustomEvent("auth:expired"));
}

function norm(path) {
  if (!path.startsWith("/")) path = `/${path}`;
  return path;
}

export async function apiGet(path) {
  const p = norm(path);
  const url = `${BASE}${p}`;
  const res = await fetch(url, { headers: { ...authHeaders() } });
  if (res.status === 401) {
    handleUnauthorized();
  }
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
  if (res.status === 401) {
    handleUnauthorized();
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    let detail = "";
    try {
      const j = t ? JSON.parse(t) : null;
      detail = j?.detail || j?.message || "";
    } catch {
      detail = "";
    }
    console.error("apiPost failed", { url, status: res.status });
    throw new Error(detail || `POST ${url} -> ${res.status} ${t}`);
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
// SOLICITACOES
// ===============================
export async function solicitarEletrico({ kit_id, termo_id }) {
  return apiPost(`/solicitacoes/eletrico`, { kit_id, termo_id });
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

export async function definirAdminPin(novo_pin, confirmar_pin) {
  return apiPost(`/auth/admin/set-pin`, { novo_pin, confirmar_pin });
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

export async function adminOperacoesList({
  tipo = "",
  status = "",
  categoria = "",
  query = "",
  dataIni = "",
  dataFim = "",
} = {}) {
  const params = new URLSearchParams();
  if (tipo) params.set("tipo", tipo);
  if (status) params.set("status", status);
  if (categoria) params.set("categoria", categoria);
  if (query) params.set("query", query);
  if (dataIni) params.set("data_ini", dataIni);
  if (dataFim) params.set("data_fim", dataFim);
  return apiGet(`/admin/solicitacoes/operacao?${params.toString()}`);
}

export async function adminOperacaoDetalhe(operacaoId, origem = "") {
  const params = new URLSearchParams();
  if (origem) params.set("origem", origem);
  return apiGet(`/admin/solicitacoes/operacao/${operacaoId}?${params.toString()}`);
}

export async function adminOperacaoConcluirEntrega(operacaoId, adminPin) {
  return apiPost(`/admin/solicitacoes/operacao/${operacaoId}/concluir-entrega`, {
    admin_pin: adminPin,
  });
}

export async function adminOperacaoConferirEntrega(operacaoId, payload) {
  return apiPost(`/admin/solicitacoes/operacao/${operacaoId}/conferir-entrega`, payload);
}

export async function adminOperacaoAprovarSubstituicao(operacaoId, adminPin, substitutoItemId, extra = {}) {
  return apiPost(`/admin/solicitacoes/operacao/${operacaoId}/aprovar-substituicao`, {
    admin_pin: adminPin,
    substituto_item_id: substitutoItemId,
    ...extra,
  });
}

export async function adminOperacaoRecusarSubstituicao(operacaoId, adminPin, motivo = "") {
  return apiPost(`/admin/solicitacoes/operacao/${operacaoId}/recusar-substituicao`, {
    admin_pin: adminPin,
    motivo,
  });
}

export async function adminOperacaoConfirmarDevolucao(operacaoId, adminPin) {
  return apiPost(`/admin/solicitacoes/operacao/${operacaoId}/confirmar-devolucao`, {
    admin_pin: adminPin,
  });
}

export async function adminOperacaoConferirDevolucao(operacaoId, payload) {
  return apiPost(`/admin/solicitacoes/operacao/${operacaoId}/conferir-devolucao`, payload);
}

export async function adminAvulsosDisponiveis({ classeTipo = "", query = "" } = {}) {
  const params = new URLSearchParams();
  if (classeTipo) params.set("classe_tipo", classeTipo);
  if (query) params.set("query", query);
  return apiGet(`/admin/avulsos/disponiveis?${params.toString()}`);
}

export async function adminSubstituicaoCandidatos({ descricaoCanonica = "", descricao = "", kitId = "" } = {}) {
  const params = new URLSearchParams();
  if (descricaoCanonica) params.set("descricao_canonica", descricaoCanonica);
  if (descricao) params.set("descricao", descricao);
  if (kitId) params.set("kit_id", String(kitId));
  return apiGet(`/admin/substituicao/candidatos?${params.toString()}`);
}

export async function adminResetSenha(userId, adminPin) {
  return apiPost(`/admin/credenciais/reset-senha`, {
    user_id: userId,
    admin_pin: adminPin,
  });
}

export async function adminAlterarPinSubresponsavel(subresponsavelId, novoPin, confirmarPin, adminPin) {
  return apiPost(`/admin/credenciais/alterar-pin-subresponsavel`, {
    subresponsavel_id: subresponsavelId,
    novo_pin: novoPin,
    confirmar_pin: confirmarPin,
    admin_pin: adminPin,
  });
}

export async function adminListUsuarios(query = "") {
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  return apiGet(`/admin/usuarios?${params.toString()}`);
}

export async function adminCriarUsuario(payload) {
  return apiPost(`/admin/usuarios`, payload);
}

export async function adminAtivarUsuario(userId) {
  return apiPost(`/admin/usuarios/${userId}/ativar`, {});
}

export async function adminDesativarUsuario(userId) {
  return apiPost(`/admin/usuarios/${userId}/desativar`, {});
}

export async function adminCriarSubresponsavel(payload) {
  return apiPost(`/admin/subresponsaveis`, payload);
}

export async function adminListarPendenciasKits() {
  return apiGet(`/admin/kits/pendencias`);
}

export async function adminResolverPendenciaKit(pendenciaId, payload) {
  return apiPost(`/admin/kits/pendencias/${pendenciaId}/resolver`, payload || {});
}
