// pwa/src/App.jsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiGet,
  apiPost,
  searchSubresponsaveis,
  distribuir as apiDistribuir,
  recolher as apiRecolher,
  criarTermo,
  solicitarEletrico,
  termosMinha,
  login,
  definirSenha,
  definirAdminPin,
  listarManuais,
  entregarManual,
  adminBusca,
  adminManualPosse,
  adminTrilhaKit,
  adminTrilhaPatrimonio,
  adminOperacoesList,
  adminOperacaoDetalhe,
  adminOperacaoConcluirEntrega,
  adminOperacaoConferirEntrega,
  adminOperacaoAprovarSubstituicao,
  adminOperacaoConfirmarDevolucao,
  adminOperacaoConferirDevolucao,
  adminAvulsosDisponiveis,
  adminSubstituicaoCandidatos,
  adminResetSenha,
  adminAlterarPinSubresponsavel,
  adminListUsuarios,
  adminCriarUsuario,
  adminAtivarUsuario,
  adminDesativarUsuario,
  adminCriarSubresponsavel,
  adminListarPendenciasKits,
  adminResolverPendenciaKit,
} from "./services/api";

/**
 * =========================================================
 * Helpers
 * =========================================================
 */

const norm = (s) =>
  (s ?? "")
    .toString()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

function nowISO() {
  return new Date().toISOString();
}

const LS_TRANSIT = "kitsEmTransicao_v2";
const LS_PENDING_OPS = "pendingOps_v1";

function getTransitSet() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_TRANSIT) || "[]");
    return new Set(arr.map((id) => Number(id)));
  } catch {
    return new Set();
  }
}

function addTransit(kitId) {
  const s = getTransitSet();
  s.add(Number(kitId));
  localStorage.setItem(LS_TRANSIT, JSON.stringify([...s]));
}

function removeTransit(kitId) {
  const s = getTransitSet();
  s.delete(Number(kitId));
  localStorage.setItem(LS_TRANSIT, JSON.stringify([...s]));
}

function isTransit(kitId) {
  return getTransitSet().has(Number(kitId));
}

function getPendingOps() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_PENDING_OPS) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function setPendingOpsStorage(list) {
  localStorage.setItem(LS_PENDING_OPS, JSON.stringify(list));
}

function buildPendingKey(op) {
  const type = String(op?.type ?? "").trim().toUpperCase();
  const kitId = op?.payload?.kit_id ?? "";
  const itemId = op?.payload?.item_id ?? "";
  const pat = (op?.payload?.patrimonio ?? "").toString().trim();
  return `${type}|${kitId}|${itemId}|${pat}`;
}

function buildPendingId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildRecolherKey(kitId, patrimonio) {
  const k = kitId ?? "";
  const p = (patrimonio ?? "").toString().trim();
  return `${k}|${p}`;
}

function safeArray(res) {
  // Backend pode retornar [] puro ou {value: []}
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.value)) return res.value;
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDateTime(value) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function withRetry(fn, tries = 2, delayMs = 500) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}

function isGpsValid(geo) {
  const lat = Number(geo?.latitude ?? 0);
  const lng = Number(geo?.longitude ?? 0);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

function getStoredToken() {
  return (
    localStorage.getItem("token") ||
    localStorage.getItem("access_token") ||
    localStorage.getItem("auth_token") ||
    localStorage.getItem("jwt")
  );
}

/**
 * =========================================================
 * Subresponsável Autocomplete (com confirmação via PIN)
 * =========================================================
 *
 * Fluxo:
 * 1) Usuário digita -> busca no backend (debounce)
 * 2) Usuário clica em uma opção -> preenche campo e guarda subresponsavel_id
 * 3) Usuário clica "Confirmar" -> pede PIN (prompt), chama /movimentos/distribuir
 *
 * Observação: confirmamos distribuição no backend (movimentos).
 * =========================================================
 */

function SubresponsavelPicker({
  kitId,
  patrimonio,
  descricao,
  kitLabel,
  encarregadoId,
  geo,
  valueText,
  selectedId,
  onPick,
  onConfirmSuccess,
  disabled,
}) {
  const [typing, setTyping] = useState(valueText ?? "");
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [confirming, setConfirming] = useState(false);

  const [termoOpen, setTermoOpen] = useState(false);
  const [assinaturaNome, setAssinaturaNome] = useState("");
  const [termoMsg, setTermoMsg] = useState("");
  const [termoSubmitting, setTermoSubmitting] = useState(false);
  const [reuseTermo, setReuseTermo] = useState(null);
  const [reuseChecking, setReuseChecking] = useState(false);
  const [forceNewTermo, setForceNewTermo] = useState(false);
  const [subtermoOpen, setSubtermoOpen] = useState(false);
  const [subtermoMsg, setSubtermoMsg] = useState("");

  const lastQueryRef = useRef("");
  const debounceRef = useRef(null);


  useEffect(() => {
    setTyping(valueText ?? "");
  }, [valueText]);

  useEffect(() => {
    const q = (typing ?? "").trim();
    setMsg("");

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!q) {
      setOptions([]);
      setOpen(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        setLoading(true);
        lastQueryRef.current = q;

        const res = await searchSubresponsaveis(q);
        const list = safeArray(res);

        if (lastQueryRef.current !== q) return;

        setOptions(list);
        setOpen(true);
      } catch (e) {
        setOptions([]);
        setOpen(false);
        setMsg(e?.message ?? "Falha ao buscar subresponsaveis");
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [typing]);

  function handlePick(opt) {
    const label = `${opt.nome}`;
    setTyping(label);
    setOpen(false);
    setOptions([]);
    onPick({ id: opt.id, nome: opt.nome });
  }

  function buildTermoTexto() {
    const kitRef = (kitLabel ?? "").trim() || `KIT ${kitId}`;
    const itemRef = `${patrimonio}${descricao ? ` - ${descricao}` : ""}`;
    const subRef = (valueText ?? "").trim();
    const parts = [
      "TERMO DE RESPONSABILIDADE - RETIRADA E CUSTODIA DE FERRAMENTAS/KIT",
      "Declaro que recebi da empresa o(s) item(ns)/kit(s) identificado(s) no sistema (patrimonio, descricao e/ou ID), comprometendo-me a:",
      "1) Zelar, guardar e utilizar corretamente os bens, mantendo-os sob minha custodia enquanto estiverem sob minha responsabilidade.",
      "2) Nao ceder, transferir ou subdividir a posse sem registro no sistema, quando aplicavel (incluindo distribuicao por PIN e subresponsaveis).",
      "3) Comunicar imediatamente ocorrencia de extravio, dano, roubo/furto, sinistro ou qualquer irregularidade, permitindo a apuracao interna.",
      "4) Reconheco que, havendo comprovacao de conduta dolosa ou culposa e do nexo com o prejuizo, podera haver responsabilizacao civil e/ou medidas cabiveis, com eventual ressarcimento na forma da lei, observadas as regras trabalhistas aplicaveis e o devido processo de apuracao.",
      "5) Autorizo o registro, para fins de seguranca, auditoria e rastreabilidade, de data/hora, identificacao do usuario, IP, user-agent e, quando disponivel, geolocalizacao, limitado a finalidade de controle patrimonial e prevencao de perdas.",
      "",
      `KIT: ${kitRef}`,
      `ITEM: ${itemRef}`,
      subRef ? `SUBRESPONSAVEL: ${subRef}` : "",
      `DATA/HORA: ${new Date().toLocaleString()}`,
    ].filter(Boolean);
    return parts.join("\n");
  }

  function buildSubtermoTexto() {
    const kitRef = (kitLabel ?? "").trim() || `KIT ${kitId}`;
    const itemRef = `${patrimonio}${descricao ? ` - ${descricao}` : ""}`;
    const subRef = (valueText ?? "").trim();
    const parts = [
      "SUBTERMO DE DISTRIBUICAO - RECEBIMENTO DE FERRAMENTA",
      "Declaro o recebimento do item/kit descrito no sistema e assumo a custodia.",
      "",
      `KIT: ${kitRef}`,
      `ITEM: ${itemRef}`,
      subRef ? `SUBRESPONSAVEL: ${subRef}` : "",
      `DATA/HORA: ${new Date().toLocaleString()}`,
    ].filter(Boolean);
    return parts.join("\n");
  }

  async function doDistribuir() {
    setMsg("");

    if (!kitId || !patrimonio || !encarregadoId) {
      setMsg("Selecione kit e encarregado antes.");
      return;
    }

    if (!selectedId) {
      setMsg("Selecione um subresponsavel na lista.");
      return;
    }

    if (!isGpsValid(geo)) {
      setMsg("GPS indisponivel/invalido. Nao da pra confirmar distribuicao sem localizacao.");
      return;
    }

    const pin = window.prompt("PIN do subresponsavel (6 digitos):");
    if (pin == null) return;
    const pinTrim = String(pin).trim();

    if (!/^\d{6}$/.test(pinTrim)) {
      setMsg("PIN invalido. Precisa ter 6 digitos numericos.");
      return;
    }

    setConfirming(true);
    try {
      const payload = {
        kit_id: Number(kitId),
        patrimonio: String(patrimonio),
        encarregado_id: Number(encarregadoId),
        subresponsavel_id: Number(selectedId),
        pin: pinTrim,
        lat: Number(geo.latitude ?? 0),
        lng: Number(geo.longitude ?? 0),
        accuracy_m: Number(geo.accuracy_m ?? 0),
        gps_timestamp: geo.gps_timestamp ?? new Date().toISOString(),
        observacao: "PWA",
      };

      await apiDistribuir(payload);

      setMsg("OK Distribuicao confirmada.");
      onConfirmSuccess?.();
    } catch (e) {
      const t = e?.message ?? String(e);
      setMsg(t.includes("detail") ? t : t);
    } finally {
      setConfirming(false);
    }
  }

  function findRecentTermo(list) {
    const kitIdNum = Number(kitId);
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    let best = null;

    for (const t of list) {
      if (t?.tipo !== "RETIRADA") continue;
      if (t?.referencia_tipo !== "KIT") continue;
      if (Number(t?.referencia_id) !== kitIdNum) continue;
      if (!t?.criado_em) continue;

      const ts = Date.parse(t.criado_em);
      if (!Number.isFinite(ts)) continue;
      if (ts < cutoff) continue;

      if (!best) {
        best = t;
      } else if (Date.parse(best.criado_em) < ts) {
        best = t;
      }
    }

    return best;
  }

  async function reuseTermoAndDistribuir() {
    setTermoSubmitting(true);
    setTermoMsg("");
    try {
      setTermoOpen(false);
      setSubtermoMsg("");
      setSubtermoOpen(true);
    } catch (e) {
      const t = e?.message ?? String(e);
      setTermoMsg(t.includes("detail") ? t : t);
      setTermoOpen(true);
    } finally {
      setTermoSubmitting(false);
      setReuseTermo(null);
      setForceNewTermo(false);
    }
  }

  function confirmDistribuir() {
    setMsg("");

    if (!kitId || !patrimonio || !encarregadoId) {
      setMsg("Selecione kit e encarregado antes.");
      return;
    }

    if (!selectedId) {
      setMsg("Selecione um subresponsavel na lista.");
      return;
    }

    if (!isGpsValid(geo)) {
      setMsg("GPS indisponivel/invalido. Nao da pra confirmar distribuicao sem localizacao.");
      return;
    }

    setAssinaturaNome((valueText ?? "").trim());
    setTermoMsg("");
    setReuseTermo(null);
    setForceNewTermo(false);

    setReuseChecking(true);
    termosMinha()
      .then((res) => {
        const list = safeArray(res);
        const recent = findRecentTermo(list);
        if (recent) {
          setReuseTermo(recent);
        }
      })
      .catch(() => {
        setTermoMsg("Falha ao consultar termos anteriores. Assine um novo termo.");
      })
      .finally(() => {
        setReuseChecking(false);
        setTermoOpen(true);
      });
  }

  async function submitTermo() {
    const nome = (assinaturaNome ?? "").trim();
    if (!nome) {
      setTermoMsg("Informe o nome para assinatura.");
      return;
    }

    setTermoSubmitting(true);
    setTermoMsg("");

    try {
      const termoPayload = {
        tipo: "RETIRADA",
        referencia_tipo: "KIT",
        referencia_id: Number(kitId),
        texto_termo: buildTermoTexto(),
        assinatura_nome: nome,
        latitude: isGpsValid(geo) ? Number(geo.latitude ?? 0) : null,
        longitude: isGpsValid(geo) ? Number(geo.longitude ?? 0) : null,
      };

      await criarTermo(termoPayload);
      setTermoOpen(false);
      setReuseTermo(null);
      setForceNewTermo(false);
      setSubtermoMsg("");
      setSubtermoOpen(true);
    } catch (e) {
      const t = e?.message ?? String(e);
      setTermoMsg(t.includes("detail") ? t : t);
    } finally {
      setTermoSubmitting(false);
    }
  }

  async function submitSubtermo() {
    setSubtermoMsg("");
    try {
      setSubtermoOpen(false);
      await doDistribuir();
    } catch (e) {
      const t = e?.message ?? String(e);
      setSubtermoMsg(t.includes("detail") ? t : t);
      setSubtermoOpen(true);
    }
  }

  return (
    <div style={{ position: "relative", width: 340, display: "flex", gap: 8, alignItems: "center" }}>
      <div style={{ flex: 1, position: "relative" }}>
        <input
          style={{ width: "100%", padding: 8 }}
          placeholder="Subresponsavel (digite para buscar)"
          value={typing}
          disabled={disabled}
          onChange={(e) => {
            setTyping(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (options.length) setOpen(true);
          }}
          onBlur={() => {
            setTimeout(() => setOpen(false), 150);
          }}
        />

        {open && options.length > 0 ? (
          <div
            style={{
              position: "absolute",
              top: 40,
              left: 0,
              width: "100%",
              background: "#fff",
              color: "#111",
              border: "1px solid #ccc",
              borderRadius: 8,
              overflow: "hidden",
              zIndex: 9999,
              boxShadow: "0 10px 30px rgba(0,0,0,.25)",
              maxHeight: 260,
              overflowY: "auto",
            }}
          >
            {options.map((opt) => (
              <div
                key={opt.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handlePick(opt)}
                style={{
                  padding: "8px 10px",
                  cursor: "pointer",
                  borderTop: "1px solid #eee",
                  fontSize: 13,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                }}
                title={opt.secao ?? ""}
              >
                <span style={{ fontWeight: 700 }}>{opt.nome}</span>
                <span style={{ opacity: 0.7 }}>{opt.secao ?? ""}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
          {loading ? "Buscando..." : null}
          {msg ? (
            <span style={{ marginLeft: 8, color: msg.startsWith("OK") ? "#0b7a38" : "#b00020" }}>{msg}</span>
          ) : null}
        </div>
      </div>

      <button
        onClick={confirmDistribuir}
        disabled={disabled || confirming}
        style={{
          padding: "8px 12px",
          cursor: disabled ? "not-allowed" : "pointer",
          border: "1px solid #111",
          fontWeight: 800,
          opacity: disabled ? 0.5 : 1,
          borderRadius: 10,
          background: "#111",
          color: "#fff",
          height: 38,
          whiteSpace: "nowrap",
        }}
        title={
          !isGpsValid(geo)
            ? "GPS invalido - backend nao aceita distribuicao sem localizacao"
            : "Assinar termo e confirmar distribuicao"
        }
      >
        {confirming ? "Confirmando..." : "Confirmar"}
      </button>

      {termoOpen ? (
        <div
          onClick={() => {
            if (!termoSubmitting) setTermoOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 99999,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 96vw)",
              background: "#fff",
              color: "#111",
              borderRadius: 12,
              padding: 16,
              boxShadow: "0 20px 60px rgba(0,0,0,.35)",
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Termo de Responsabilidade</div>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 10 }}>
              A retirada so confirma depois que o termo for gravado.
            </div>

            <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
              <div style={{ fontSize: 12 }}>
                <b>Kit:</b> {kitLabel || `KIT ${kitId}`}
              </div>
              <div style={{ fontSize: 12 }}>
                <b>Item:</b> {patrimonio}
                {descricao ? ` - ${descricao}` : ""}
              </div>
            </div>

            {reuseChecking ? (
              <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                Consultando termos anteriores.
              </div>
            ) : null}

            {reuseTermo && !forceNewTermo ? (
              <div
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 10,
                  background: "#fafafa",
                }}
              >
                <div style={{ fontSize: 12, marginBottom: 8 }}>
                  Existe termo RETIRADA para este kit nas ultimas 12h (
                  {new Date(reuseTermo.criado_em).toLocaleString()}).
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    onClick={reuseTermoAndDistribuir}
                    disabled={termoSubmitting || reuseChecking}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 8,
                      border: "1px solid #111",
                      background: "#111",
                      color: "#fff",
                      cursor: termoSubmitting || reuseChecking ? "not-allowed" : "pointer",
                      fontWeight: 800,
                    }}
                  >
                    Reutilizar termo
                  </button>
                  <button
                    onClick={() => setForceNewTermo(true)}
                    disabled={termoSubmitting || reuseChecking}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 8,
                      border: "1px solid #aaa",
                      cursor: termoSubmitting || reuseChecking ? "not-allowed" : "pointer",
                    }}
                  >
                    Assinar novo
                  </button>
                </div>
              </div>
            ) : null}

            <label style={{ fontSize: 12, opacity: 0.85 }}>Assinatura (nome completo)</label>
            <input
              style={{ width: "100%", padding: 10, marginTop: 4, marginBottom: 8 }}
              value={assinaturaNome}
              onChange={(e) => setAssinaturaNome(e.target.value)}
              placeholder="Ex: NOME COMPLETO"
            />

            <label style={{ fontSize: 12, opacity: 0.85 }}>Texto do termo</label>
            <textarea
              readOnly
              value={buildTermoTexto()}
              style={{ width: "100%", minHeight: 140, padding: 10, marginTop: 4, fontSize: 12 }}
            />

            {termoMsg ? (
              <div style={{ marginTop: 8, fontSize: 12, color: "#b00020" }}>{termoMsg}</div>
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
              <button
                onClick={() => setTermoOpen(false)}
                disabled={termoSubmitting}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #aaa",
                  cursor: termoSubmitting ? "not-allowed" : "pointer",
                }}
              >
                Cancelar
              </button>
              <button
                onClick={submitTermo}
                disabled={termoSubmitting}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                  cursor: termoSubmitting ? "not-allowed" : "pointer",
                  fontWeight: 800,
                }}
              >
                {termoSubmitting ? "Salvando termo..." : "Assinar e confirmar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {subtermoOpen ? (
        <div
          onClick={() => {
            if (!confirming) setSubtermoOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 99999,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 96vw)",
              background: "#fff",
              color: "#111",
              borderRadius: 12,
              padding: 16,
              boxShadow: "0 20px 60px rgba(0,0,0,.35)",
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>
              Subtermo do Subresponsável
            </div>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 10 }}>
              Confirme o recebimento antes de digitar o PIN.
            </div>

            <label style={{ fontSize: 12, opacity: 0.85 }}>Texto do subtermo</label>
            <textarea
              readOnly
              value={buildSubtermoTexto()}
              style={{ width: "100%", minHeight: 160, padding: 10, marginTop: 4, fontSize: 12 }}
            />

            {subtermoMsg ? (
              <div style={{ marginTop: 8, fontSize: 12, color: "#b00020" }}>{subtermoMsg}</div>
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
              <button
                onClick={() => setSubtermoOpen(false)}
                disabled={confirming}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #aaa",
                  cursor: confirming ? "not-allowed" : "pointer",
                }}
              >
                Cancelar
              </button>
              <button
                onClick={submitSubtermo}
                disabled={confirming}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                  cursor: confirming ? "not-allowed" : "pointer",
                  fontWeight: 800,
                }}
              >
                {confirming ? "Confirmando..." : "Confirmar e digitar PIN"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


/**
 * =========================================================
 * UI helpers (cards)
 * =========================================================
 */
function CardShell({ title, subtitle, right, children }) {
  return (
    <section
      style={{
        background: "#fff",
        borderRadius: 16,
        padding: 16,
        boxShadow: "0 10px 35px rgba(0,0,0,.1)",
        border: "1px solid #eee",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minWidth: 280,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 2 }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 12, opacity: 0.75 }}>{subtitle}</div> : null}
        </div>
        {right ? <div>{right}</div> : null}
      </header>
      {children}
    </section>
  );
}

function Pill({ label, value }) {
  return (
    <div
      style={{
        borderRadius: 999,
        padding: "6px 10px",
        background: "#111",
        color: "#fff",
        fontSize: 12,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span style={{ opacity: 0.85 }}>{label}</span>
      <b>{value ?? 0}</b>
    </div>
  );
}

function SolicitacoesCard({
  items,
  statusMap,
  selectedKitId,
  statusOverview,
  statusOverviewErr,
}) {
  const pendentes = useMemo(() => {
    if (!selectedKitId) return [];
    return (items ?? []).filter((x) => {
      const st = statusMap?.[x.kit_item_id]?.status ?? null;
      return st == null;
    });
  }, [items, statusMap, selectedKitId]);

  return (
    <CardShell
      title="Checklist semanal / Status"
      subtitle="Painel situacional: leitura apenas, sem CTAs."
      right={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Pill label="Presente" value={statusOverview?.present ?? "-"} />
          <Pill label="Distribuído" value={statusOverview?.distributed ?? "-"} />
          <Pill label="Pend. Substituição" value={statusOverview?.pending_substituicao ?? "-"} />
          <Pill label="Transição (local)" value={getTransitSet().size} />
        </div>
      }
    >
      {statusOverviewErr ? (
        <div style={{ padding: 10, border: "1px solid #f3c9c9", borderRadius: 12, fontSize: 12 }}>
          {statusOverviewErr}
        </div>
      ) : null}

      <div style={{ fontSize: 12, opacity: 0.8 }}>
        Pendências locais (kit precisa estar íntegro para liberar o termo):
      </div>

      <div style={{ border: "1px solid #eee", borderRadius: 12 }}>
        {!selectedKitId ? (
          <div style={{ padding: 12, fontSize: 12, opacity: 0.75 }}>Selecione um kit para analisar pendências.</div>
        ) : pendentes.length === 0 ? (
          <div style={{ padding: 12, fontSize: 12, opacity: 0.7 }}>Nenhuma pendência detectada. Kit íntegro.</div>
        ) : (
          pendentes.map((x, idx) => (
            <div
              key={x.kit_item_id}
              style={{
                padding: "10px 12px",
                borderTop: idx === 0 ? "none" : "1px solid #f1f1f1",
              }}
            >
              <div style={{ fontWeight: 800 }}>{x.patrimonio}</div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>{x.descricao}</div>
            </div>
          ))
        )}
      </div>
    </CardShell>
  );
}

function DetalhesKitCard({
  items,
  statusMap,
  geo,
  selectedKitId,
  kitLabel,
  selectedEncarregadoId,
  onPickSubresponsavel,
  onConfirmDistribuicao,
  onReagrupar,
  onSolicitarSubstituicao,
  onSolicitarDevolucao,
  onDistribuir,
  pendingDevolucaoKits,
  pendingSubstituicoes,
  readOnly = false,
}) {
  const renderStatus = (st) => {
    if (st?.status === "DISTRIBUIDO") {
      return (
        <span style={{ fontSize: 12, opacity: 0.85 }}>
          Distribuído • confirmação:{" "}
          <b style={{ color: st.distribuicao_confirmada ? "#0b7a38" : "#b00020" }}>
            {st.distribuicao_confirmada ? "OK" : "PENDENTE"}
          </b>
          {st.sync_pending ? (
            <span style={{ marginLeft: 6, fontWeight: 700, color: "#b00020" }}>Pend. Sync</span>
          ) : null}
        </span>
      );
    }
    if (st?.status === "DISTRIBUINDO") {
      return (
        <span style={{ fontSize: 12, opacity: 0.85 }}>
          Distribuição pendente de PIN.
          {st.sync_pending ? (
            <span style={{ marginLeft: 6, fontWeight: 700, color: "#b00020" }}>Pend. Sync</span>
          ) : null}
        </span>
      );
    }
    if (st?.status === "PRESENTE") {
      return (
        <span style={{ fontSize: 12, opacity: 0.85 }}>
          Presente sob sua responsabilidade.
          {st.sync_pending ? (
            <span style={{ marginLeft: 6, fontWeight: 700, color: "#b00020" }}>Pend. Sync</span>
          ) : null}
        </span>
      );
    }
    return <span style={{ fontSize: 12, opacity: 0.85 }}>Pendente</span>;
  };

  const kitIdKey = selectedKitId ? String(selectedKitId) : "";
  const kitHasPendingDevolucao =
    kitIdKey && pendingDevolucaoKits?.has(kitIdKey);

  const kitHasPendingSubstituicao = (items ?? []).some((it) => {
    const itemId = it?.item_id ?? it?.id ?? null;
    return itemId != null && pendingSubstituicoes?.has(String(itemId));
  });

  const itensDistribuidos = (items ?? []).filter((x) => {
    const kitItemKey = x.kit_item_id ?? x.id ?? null;
    const st = kitItemKey != null ? statusMap?.[kitItemKey]?.status : null;
    return st === "DISTRIBUIDO" || st === "DISTRIBUINDO";
  });

  let devolucaoBlockedReason = "";
  if (kitHasPendingDevolucao) {
    devolucaoBlockedReason = "Devolução solicitada (aguardando admin).";
  } else if (kitHasPendingSubstituicao) {
    devolucaoBlockedReason = "Substituição pendente neste kit.";
  } else if (itensDistribuidos.length) {
    const items = itensDistribuidos.map((it) => it.patrimonio).filter(Boolean);
    devolucaoBlockedReason = items.length
      ? `Reagrupe antes de solicitar devolução: ${items.join(", ")}.`
      : "Reagrupe os itens distribuídos antes de solicitar devolução.";
  }

  const canSolicitarDevolucao =
    !kitHasPendingDevolucao && !kitHasPendingSubstituicao && itensDistribuidos.length === 0;

  const headerRight = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>
        Kit: <b>{kitLabel || selectedKitId || "-"}</b>
      </div>
      {onSolicitarDevolucao && !readOnly ? (
        canSolicitarDevolucao ? (
          <button
            type="button"
            onClick={onSolicitarDevolucao}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid #b00020",
              background: "#b00020",
              color: "#fff",
              fontWeight: 900,
              cursor: "pointer",
            }}
          >
            Solicitar devolução
          </button>
        ) : (
          <div style={{ fontSize: 12, opacity: 0.75, textAlign: "right", maxWidth: 260 }}>
            {devolucaoBlockedReason}
          </div>
        )
      ) : null}
    </div>
  );

  return (
    <CardShell
      title="Detalhes do kit"
      subtitle="Distribuição • Reagrupar • Solicitação de substituição."
      right={headerRight}
    >
      {!selectedKitId ? (
        <div style={{ padding: 10, fontSize: 12, opacity: 0.75 }}>Selecione um kit para operar.</div>
      ) : !items || items.length === 0 ? (
        <div style={{ padding: 10, fontSize: 12, opacity: 0.75 }}>Kit sem itens ou falha ao carregar.</div>
      ) : (
        <div style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
          {items.map((x, idx) => {
            const kitItemKey = x.kit_item_id ?? x.id ?? `${x.patrimonio ?? ""}-${idx}`;
            const st = statusMap?.[kitItemKey] ?? {
              status: null,
              subresponsavel_text: "",
              subresponsavel_id: null,
              distribuicao_confirmada: false,
              sync_pending: false,
            };
            const isDistribuindo = st.status === "DISTRIBUINDO";
            const isDistribuidoOk = st.status === "DISTRIBUIDO" && st.distribuicao_confirmada;
            const itemId = x.item_id ?? x.id ?? null;
            const hasPendingSubst =
              itemId != null && pendingSubstituicoes?.has(String(itemId));
            const isSyncPending = Boolean(st.sync_pending);
            const kitActionId =
              x.kit_id ?? selectedKitId ?? posseSelecionada?.data?.id ?? null;
            const hasPendingDev =
              kitActionId && pendingDevolucaoKits.has(String(kitActionId));
            const isKitTransit = kitActionId && isTransit(kitActionId);

            return (
              <div
                key={kitItemKey}
                style={{
                  padding: 12,
                  borderTop: idx === 0 ? "none" : "1px solid #f1f1f1",
                  display: "grid",
                  gridTemplateColumns: "1fr",
                  gap: 10,
                }}
              >
                <div>
                  <div style={{ fontWeight: 900, fontSize: 14 }}>{x.patrimonio}</div>
                  <div style={{ fontSize: 12, opacity: 0.9 }}>{x.descricao}</div>
                  <div style={{ marginTop: 4 }}>{renderStatus(st)}</div>
                </div>

                {!readOnly && (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      justifyContent: "flex-end",
                      alignItems: "center",
                    }}
                  >
                    {hasPendingDev || isKitTransit ? (
                      <div style={{ fontSize: 12, color: "#ffcf33", fontWeight: 700 }}>
                        {hasPendingDev
                          ? "Devolução pendente — ações bloqueadas."
                          : "Kit em transição — ações bloqueadas."}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onSolicitarSubstituicao?.(x)}
                      disabled={
                        !selectedKitId ||
                        hasPendingSubst ||
                        isSyncPending ||
                        hasPendingDev ||
                        isKitTransit
                      }
                      style={{
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid #111",
                        background: "#fff",
                        cursor: "pointer",
                        fontWeight: 900,
                      }}
                    >
                      {hasPendingSubst
                        ? "Substituição pendente"
                        : isSyncPending
                          ? "Pend. Sync"
                          : "Solicitar substituição"}
                    </button>

                    {isDistribuidoOk ? (
                      <button
                        type="button"
                        onClick={() => onReagrupar?.(x)}
                        disabled={isSyncPending}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: "1px solid #111",
                          background: "#111",
                          color: "#fff",
                          cursor: isSyncPending ? "not-allowed" : "pointer",
                          fontWeight: 900,
                          opacity: isSyncPending ? 0.7 : 1,
                        }}
                        title="Reagrupar item distribuído ao kit"
                      >
                        Reagrupar
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onDistribuir?.(kitItemKey)}
                        disabled={
                          !selectedKitId ||
                          !selectedEncarregadoId ||
                          isSyncPending ||
                          isDistribuindo ||
                          hasPendingSubst ||
                          hasPendingDev ||
                          isKitTransit
                        }
                        style={{
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: "1px solid #111",
                          background: "#111",
                          color: "#fff",
                          cursor: "pointer",
                          fontWeight: 900,
                          opacity: isSyncPending ? 0.7 : 1,
                        }}
                        title="Preparar distribuição (seleciona subresponsável + PIN)"
                      >
                        {isDistribuindo ? "Aguardando PIN" : "Distribuir"}
                      </button>
                    )}
                  </div>
                )}

                {!readOnly &&
                (isDistribuindo ||
                  (st.status === "DISTRIBUIDO" && !st.distribuicao_confirmada)) &&
                !isSyncPending ? (
                  <div style={{ marginTop: 4 }}>
                    <SubresponsavelPicker
                      kitId={selectedKitId}
                      patrimonio={x.patrimonio}
                      descricao={x.descricao}
                      kitLabel={kitLabel}
                      encarregadoId={selectedEncarregadoId}
                      geo={geo}
                      valueText={st.subresponsavel_text}
                      selectedId={st.subresponsavel_id}
                      disabled={!selectedKitId || !selectedEncarregadoId}
                        onPick={({ id, nome }) => onPickSubresponsavel?.(kitItemKey, { id, nome }, false)}
                        onConfirmSuccess={() => onConfirmDistribuicao?.(kitItemKey)}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    )}
    </CardShell>
  );
}

/**
 * =========================================================
 * App
 * =========================================================
 */
export default function App() {
  const apiBase = import.meta.env.VITE_API_URL;
  const [route, setRoute] = useState(() =>
    window.location.pathname.startsWith("/app") ? "app" : "login"
  );

  function goTo(path) {
    window.history.pushState({}, "", path);
    setRoute(path.startsWith("/app") ? "app" : "login");
  }

  const [currentUser, setCurrentUser] = useState(null);
  const [currentUserErr, setCurrentUserErr] = useState("");
  const [currentUserLoading, setCurrentUserLoading] = useState(false);


  const [authToken, setAuthToken] = useState(() => getStoredToken() || "");
  const [authUser, setAuthUser] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authErr, setAuthErr] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authNotice, setAuthNotice] = useState("");

  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [mustSetAdminPin, setMustSetAdminPin] = useState(false);
  const [adminPin, setAdminPin] = useState("");
  const [adminPinConfirm, setAdminPinConfirm] = useState("");
  const [adminPinErr, setAdminPinErr] = useState("");
  const [adminPinLoading, setAdminPinLoading] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newPassErr, setNewPassErr] = useState("");
  const [newPassLoading, setNewPassLoading] = useState(false);

  const [statusOverview, setStatusOverview] = useState(null);
  const [statusOverviewErr, setStatusOverviewErr] = useState("");

  const refreshStatusOverview = useCallback(async () => {
    if (!authToken) return;
    try {
      setStatusOverviewErr("");
      const encId = currentUser?.encarregado_id;
      const qs = encId ? `?encarregado_id=${encId}` : "";
      const j = await apiGet(`/status/overview${qs}`);
      setStatusOverview(j);
    } catch (e) {
      console.warn("Falha ao carregar /status/overview:", e);
      setStatusOverviewErr(e?.message ?? "Falha ao carregar status/overview");
    }
  }, [authToken, currentUser]);





  /**
   * Dados mestres
   */
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [setores, setSetores] = useState([]);
  const [encarregados, setEncarregados] = useState([]);
  const [kits, setKits] = useState([]);
  const [kitsDisponiveisApi, setKitsDisponiveisApi] = useState([]);
  const [kitsPendentes, setKitsPendentes] = useState(new Set());

  /**
   * Seleções
   */
  const [selectedKitId, setSelectedKitId] = useState("");
  const [selectedEncarregadoId, setSelectedEncarregadoId] = useState("");

  /**
   * Itens do kit (detalhados) e busca
   */
  const [kitItens, setKitItens] = useState([]); // [{kit_item_id, kit_id, item_id, quantidade, patrimonio, descricao}]
  const [q, setQ] = useState("");

  const [modo, setModo] = useState("eletrico");
  const [manualItens, setManualItens] = useState([]);
  const [manualQuery, setManualQuery] = useState("");
  const [manualLoading, setManualLoading] = useState(false);
  const [manualErr, setManualErr] = useState("");
  const [manualSel, setManualSel] = useState(null);
  const [manualQty, setManualQty] = useState(1);
  const [manualTermoOpen, setManualTermoOpen] = useState(false);
  const [manualTermoMsg, setManualTermoMsg] = useState("");
  const [manualTermoSubmitting, setManualTermoSubmitting] = useState(false);
  const [manualAssinatura, setManualAssinatura] = useState("");
  const [checklistTermoOpen, setChecklistTermoOpen] = useState(false);
  const [checklistAssinatura, setChecklistAssinatura] = useState("");
  const [checklistTermoMsg, setChecklistTermoMsg] = useState("");
  const [checklistTermoSubmitting, setChecklistTermoSubmitting] = useState(false);
  const [substModalItem, setSubstModalItem] = useState(null);
  const [substSubmitting, setSubstSubmitting] = useState(false);
  const [substObservacao, setSubstObservacao] = useState("");
  const [previewSelecionado, setPreviewSelecionado] = useState(null);
  const [posseSelecionada, setPosseSelecionada] = useState(null);
  const [tabMeus, setTabMeus] = useState("kits");
  const [selectedAvulsoId, setSelectedAvulsoId] = useState("");
  const [meusAvulsos, setMeusAvulsos] = useState([]);
  const [meusPosseKits, setMeusPosseKits] = useState([]);
  const [posseKitItens, setPosseKitItens] = useState([]);
  const [posseStatusMap, setPosseStatusMap] = useState({});

  /**
   * =========================================================
   * Avulsos e derivados do estado atual
   * =========================================================
   */
  /**
   * statusMap[kit_item_id] = {
   *   status: "PRESENTE" | "DISTRIBUIDO" | null,
   *   subresponsavel_text: string,
   *   subresponsavel_id: number|null,
   *   distribuicao_confirmada: boolean
   * }
   */
  const [statusMap, setStatusMap] = useState({});
  const [avulsos, setAvulsos] = useState([]); // por enquanto vazio; vai preencher quando inventário real estiver integrado
  const [avulsosDisponiveisApi, setAvulsosDisponiveisApi] = useState([]);
  const [uiMsg, setUiMsg] = useState("");

  const distributedItems = useMemo(() => {
    return (kitItens ?? []).filter((x) => {
      const st = statusMap?.[x.kit_item_id]?.status;
      return st === "DISTRIBUIDO" || st === "DISTRIBUINDO";
    });
  }, [kitItens, statusMap]);

  const kitLabel = useMemo(() => {
    const k = kits.find((x) => String(x.id) === String(selectedKitId));
    if (!k) return "";
    const setor = setores.find((s) => s.id === k.setor_id)?.nome ?? `Setor ${k.setor_id}`;
    const parts = [k.nome, setor];
    if (k.tipo) parts.push(k.tipo);
    return parts.filter(Boolean).join(" • ");
  }, [kits, setores, selectedKitId]);

  const formatKitLabel = (kit) => {
    if (!kit) return "-";
    const setor = setores.find((s) => s.id === kit.setor_id)?.nome ?? `Setor ${kit.setor_id}`;
    const parts = [kit.nome, setor];
    if (kit.tipo) parts.push(kit.tipo);
    return parts.filter(Boolean).join(" • ");
  };

  const meusKits = meusPosseKits ?? [];
  const meusAvulsosReais = meusAvulsos ?? [];
  const kitsDisponiveis = kitsDisponiveisApi ?? [];
  const avulsosDisponiveis = avulsosDisponiveisApi ?? [];
  const [pendingDevolucaoKits, setPendingDevolucaoKits] = useState(() => new Set());
  const [pendingDevolucaoAvulsos, setPendingDevolucaoAvulsos] = useState(() => new Set());
  const [pendingSubstituicoes, setPendingSubstituicoes] = useState(() => new Set());
  const [pendingOps, setPendingOps] = useState(() => getPendingOps());
  /**
   * GPS / Geolocalização
   */
  const [geo, setGeo] = useState({
    ok: false,
    latitude: 0,
    longitude: 0,
    accuracy_m: 0,
    gps_timestamp: null,
  });
  const meusKitsId = new Set((meusKits ?? []).map((k) => String(k.id)));
  const meusAvulsosId = new Set((meusAvulsosReais ?? []).map((a) => String(a.id)));
  const meusAvulsosPat = new Set(
    (meusAvulsosReais ?? [])
      .map((a) => String(a.patrimonio ?? "").trim())
      .filter(Boolean)
  );
  const kitsDisponiveisFiltrados = (kitsDisponiveis ?? []).filter((k) => {
    const id = String(k.id);
    if (meusKitsId.has(id)) return false;
    if (isTransit(k.id)) return false;
    if (kitsPendentes.has(id)) return false;
    return true;
  });
  const avulsosDisponiveisFiltrados = (avulsosDisponiveis ?? []).filter((a) => {
    const idOk = !meusAvulsosId.has(String(a.id));
    const pat = String(a.patrimonio ?? "").trim();
    const patOk = pat ? !meusAvulsosPat.has(pat) : true;
    return idOk && patOk;
  });

  const meusListStyle = {
    borderTop: "1px solid rgba(255,255,255,0.08)",
    paddingTop: 12,
    paddingRight: 8,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  };

  const isKitPosseSelecionada = (kit) =>
    posseSelecionada?.tipo === "kit" && String(posseSelecionada?.data?.id) === String(kit?.id);
  const isAvulsoPosseSelecionada = (avulso) =>
    posseSelecionada?.tipo === "avulso" && String(posseSelecionada?.data?.id) === String(avulso?.id);

  useEffect(() => {
    if (!selectedKitId) {
      setPreviewSelecionado((prev) => (prev?.tipo === "kit" ? null : prev));
      return;
    }
    const kit = kits.find((x) => String(x.id) === String(selectedKitId));
    if (!kit) return;
    setPreviewSelecionado((prev) => {
      if (prev?.tipo === "kit" && String(prev.data?.id) === String(kit.id)) return prev;
      return { tipo: "kit", data: kit };
    });
  }, [selectedKitId, kits]);

  useEffect(() => {
    if (!selectedKitId) return;
    const isNowInPosse = meusKitsId.has(String(selectedKitId));
    if (!isNowInPosse) return;
    setSelectedKitId("");
    setPreviewSelecionado((prev) => {
      if (prev?.tipo !== "kit") return prev;
      if (String(prev?.data?.id) !== String(selectedKitId)) return prev;
      return null;
    });
  }, [meusKitsId, selectedKitId]);

  useEffect(() => {
    setPendingDevolucaoKits((prev) => {
      if (!prev.size) return prev;
      if (!meusKits?.length) return prev;
      const atual = new Set((meusKits ?? []).map((k) => String(k.id)));
      const next = new Set();
      for (const id of prev) {
        if (atual.has(String(id))) {
          next.add(String(id));
        }
      }
      return next;
    });
  }, [meusKits]);

  useEffect(() => {
    if (!meusKits?.length) return;
    // Se o kit já entrou em posse, remove transição local
    for (const k of meusKits) {
      removeTransit(k.id);
    }
    // Se nada selecionado, pré-seleciona o primeiro kit para mostrar detalhes
    if (!posseSelecionada && tabMeus === "kits") {
      setPosseSelecionada({ tipo: "kit", data: meusKits[0] });
    }
  }, [meusKits, posseSelecionada, tabMeus]);

  useEffect(() => {
    if (!posseSelecionada) return;
    if (posseSelecionada.tipo === "kit") {
      const id = String(posseSelecionada?.data?.id ?? "");
      if (!id) return;
      const stillHas = meusKitsId.has(id);
      if (!stillHas) {
        setUiMsg("Posse encerrada. Removendo detalhes...");
        setPosseSelecionada(null);
      }
      return;
    }
    if (posseSelecionada.tipo === "avulso") {
      const id = String(posseSelecionada?.data?.id ?? "");
      if (!id) return;
      const stillHas = meusAvulsosId.has(id);
      if (!stillHas) {
        setUiMsg("Posse encerrada. Removendo detalhes...");
        setPosseSelecionada(null);
      }
    }
  }, [meusKitsId, meusAvulsosId, posseSelecionada]);

  useEffect(() => {
    setPendingDevolucaoAvulsos((prev) => {
      if (!prev.size) return prev;
      if (!meusAvulsosReais?.length) return prev;
      const atual = new Set((meusAvulsosReais ?? []).map((a) => String(a.id)));
      const next = new Set();
      for (const id of prev) {
        if (atual.has(String(id))) {
          next.add(String(id));
        }
      }
      return next;
    });
  }, [meusAvulsosReais]);

  function toast(msg) {
    setUiMsg(msg);
    setTimeout(() => setUiMsg(""), 4500);
  }

  const addPendingKit = (id) => {
    if (!id) return;
    setPendingDevolucaoKits((prev) => {
      const next = new Set(prev);
      next.add(String(id));
      return next;
    });
  };

  const addPendingAvulso = (id) => {
    if (!id) return;
    setPendingDevolucaoAvulsos((prev) => {
      const next = new Set(prev);
      next.add(String(id));
      return next;
    });
  };

  const addPendingSubstituicao = (id) => {
    if (!id) return;
    setPendingSubstituicoes((prev) => {
      const next = new Set(prev);
      next.add(String(id));
      return next;
    });
  };

  const updatePendingOps = useCallback((updater) => {
    setPendingOps((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      setPendingOpsStorage(next);
      return next;
    });
  }, []);

  const enqueuePendingOp = useCallback(
    (op) => {
      if (!op) return;
      updatePendingOps((prev) => {
        const key = buildPendingKey(op);
        if (prev.some((p) => p.key === key)) return prev;
        const next = [
          ...prev,
          {
            ...op,
            id: op.id ?? buildPendingId(),
            key,
            created_at: nowISO(),
          },
        ];
        return next;
      });
    },
    [updatePendingOps]
  );

  const pendingRecolherKeys = useMemo(() => {
    const set = new Set();
    for (const op of pendingOps) {
      if (String(op?.type ?? "").toUpperCase() !== "RECOLHER") continue;
      const key = buildRecolherKey(op?.payload?.kit_id, op?.payload?.patrimonio);
      if (key) set.add(key);
    }
    return set;
  }, [pendingOps]);

  const refreshPendingOps = useCallback(async () => {
    if (!authToken) return;
    try {
      const pendingRes = await apiGet("/solicitacoes/operacao/minhas?status=PENDENTE");
      let list = [];
      if (pendingRes && Array.isArray(pendingRes.items)) {
        list = pendingRes.items;
      } else if (Array.isArray(pendingRes)) {
        list = pendingRes;
      } else if (pendingRes && Array.isArray(pendingRes.value)) {
        list = pendingRes.value;
      } else {
        // resposta inesperada: não mexe nos sets atuais
        return;
      }

      const nextKits = new Set();
      const nextAvulsos = new Set();
      const nextSubst = new Set();

      for (const row of list) {
        const tipo = String(row?.tipo ?? "").trim().toUpperCase();
        if (tipo === "DEVOLUCAO_KIT" && row?.kit_id != null) {
          nextKits.add(String(row.kit_id));
        } else if (tipo === "DEVOLUCAO_AVULSO" && row?.item_id != null) {
          nextAvulsos.add(String(row.item_id));
        } else if (tipo === "SUBSTITUICAO_ITEM" && row?.item_id != null) {
          nextSubst.add(String(row.item_id));
        }
      }

      setPendingDevolucaoKits(nextKits);
      setPendingDevolucaoAvulsos(nextAvulsos);
      setPendingSubstituicoes(nextSubst);
    } catch (e) {
      console.warn("Falha ao carregar pendencias:", e);
    }
  }, [authToken]);

  const processPendingOps = useCallback(async () => {
    if (!authToken) return;
    if (!pendingOps.length) return;
    if (!navigator.onLine) return;

    let next = pendingOps;
    let processed = false;

    for (const op of pendingOps) {
      const type = String(op?.type ?? "").toUpperCase();
      if (type !== "RECOLHER") continue;

      const payload = { ...(op?.payload || {}) };
      if (payload.lat == null || payload.lng == null) {
        if (!isGpsValid(geo)) continue;
        payload.lat = Number(geo.latitude ?? 0);
        payload.lng = Number(geo.longitude ?? 0);
      }

      try {
        await apiRecolher(payload);
        next = next.filter((p) => p.id !== op.id);
        processed = true;
        if (op?.meta?.kit_item_id != null) {
          setItemSyncPending(op.meta.kit_item_id, false);
        }
      } catch (e) {
        console.warn("pending op error:", e);
      }
    }

    if (processed) {
      updatePendingOps(next);
      refreshStatusOverview();
      refreshPendingOps();
    }
  }, [
    authToken,
    geo,
    pendingOps,
    refreshPendingOps,
    refreshStatusOverview,
    updatePendingOps,
  ]);


  // Admin panel state
  const [adminQuery, setAdminQuery] = useState("");
  const [adminSetorId, setAdminSetorId] = useState("");
  const [adminResults, setAdminResults] = useState(null);
  const [adminManualPosseRows, setAdminManualPosseRows] = useState([]);
  const [adminTrail, setAdminTrail] = useState(null);
  const [adminTrailTitle, setAdminTrailTitle] = useState("");
  const [adminTrailShowTech, setAdminTrailShowTech] = useState(false);
  const [adminTermsShowHistory, setAdminTermsShowHistory] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminErr, setAdminErr] = useState("");
  const [adminOpenQueues, setAdminOpenQueues] = useState(true);
  const [adminOpenBusca, setAdminOpenBusca] = useState(false);
  const [adminOpenCred, setAdminOpenCred] = useState(false);
  const [adminOpenUsers, setAdminOpenUsers] = useState(false);
  const [adminOpenTrilha, setAdminOpenTrilha] = useState(false);
  const [adminQueuesLoading, setAdminQueuesLoading] = useState(false);
  const [adminQueuesErr, setAdminQueuesErr] = useState("");
  const [adminQueueSolicitacoes, setAdminQueueSolicitacoes] = useState([]);
  const [adminQueueSubstituicoes, setAdminQueueSubstituicoes] = useState([]);
  const [adminQueueDevolucoes, setAdminQueueDevolucoes] = useState([]);
  const [adminOpDetail, setAdminOpDetail] = useState(null);
  const [adminOpDetailOpen, setAdminOpDetailOpen] = useState(false);
  const [adminOpDetailLoading, setAdminOpDetailLoading] = useState(false);
  const [adminOpActionLoading, setAdminOpActionLoading] = useState(false);
  const [adminSubstitutoId, setAdminSubstitutoId] = useState("");
  const [adminSubstitutosDisponiveis, setAdminSubstitutosDisponiveis] = useState([]);
  const [adminSubstitutosLoading, setAdminSubstitutosLoading] = useState(false);
  const [adminSubstitutosKits, setAdminSubstitutosKits] = useState([]);
  const [adminEntregaItens, setAdminEntregaItens] = useState([]);
  const [adminEntregaPinAdmin, setAdminEntregaPinAdmin] = useState("");
  const [adminDevolucaoItens, setAdminDevolucaoItens] = useState([]);
  const [adminDevolucaoPinAdmin, setAdminDevolucaoPinAdmin] = useState("");
  const [adminTermoOpen, setAdminTermoOpen] = useState(false);
  const [adminTermoTexto, setAdminTermoTexto] = useState("");
  const [adminTermoMeta, setAdminTermoMeta] = useState(null);
  const [adminResetUserId, setAdminResetUserId] = useState("");
  const [adminResetPin, setAdminResetPin] = useState("");
  const [adminResetMsg, setAdminResetMsg] = useState("");
  const [adminSubPinId, setAdminSubPinId] = useState("");
  const [adminSubPin, setAdminSubPin] = useState("");
  const [adminSubPinConfirm, setAdminSubPinConfirm] = useState("");
  const [adminSubPinAdminPin, setAdminSubPinAdminPin] = useState("");
  const [adminCredLoading, setAdminCredLoading] = useState(false);
  const [adminUsuariosQuery, setAdminUsuariosQuery] = useState("");
  const [adminUsuarios, setAdminUsuarios] = useState([]);
  const [adminUsuariosLoading, setAdminUsuariosLoading] = useState(false);
  const [adminUsuariosErr, setAdminUsuariosErr] = useState("");
  const [adminNovoUsuario, setAdminNovoUsuario] = useState({
    nome_completo: "",
    username: "",
    perfil: "ENCARREGADO",
    subresponsavel_id: "",
    encarregado_id: "",
    ativo: true,
  });
  const [adminNovoSubresp, setAdminNovoSubresp] = useState({
    nome: "",
    secao: "",
    ativo: true,
  });
  const [adminPendenciasKits, setAdminPendenciasKits] = useState([]);
  const [adminPendenciasLoading, setAdminPendenciasLoading] = useState(false);

  const adminTrailChecklists = safeArray(adminTrail?.checklists);

  const adminTrailTerms = safeArray(adminTrail?.termos).sort((a, b) => {
    const da = new Date(a?.criado_em || a?.created_at || a?.data_hora || 0).getTime();
    const db = new Date(b?.criado_em || b?.created_at || b?.data_hora || 0).getTime();
    return db - da;
  });

  function handleAvulsoSelectChange(id) {
    setSelectedAvulsoId(id);
    if (!id) {
      setPreviewSelecionado(null);
      return null;
    }
    const encontrado = (avulsosDisponiveisFiltrados ?? []).find(
      (a) => String(a.id) === String(id)
    );
    if (!encontrado) {
      setPreviewSelecionado(null);
      return null;
    }
    setPreviewSelecionado({ tipo: "avulso", data: encontrado });
    return encontrado;
  }

  function handleSolicitarAvulsoComTermo(event) {
    event?.preventDefault();
    event?.stopPropagation();
    const item = previewSelecionado?.data;
    if (!item) {
      toast("Selecione um avulso para abrir o termo.");
      return;
    }
    openManualTermo(item);
  }

  const adminTrailLastTerm = adminTrailTerms[0] ?? null;
  const adminTrailOldTerms = adminTrailTerms.slice(1);

  const adminTrailMovements = safeArray(adminTrail?.movimentos);

  const adminTrailLastUpdate =
    adminTrailChecklists?.[0]?.data_hora ??
    adminTrailLastTerm?.criado_em ??
    adminTrailMovements?.[0]?.data_hora ??
    adminTrailMovements?.[0]?.created_at ??
    null;
  const adminDescricaoCanonica = (adminOpDetail?.contexto?.item_original?.descricao_canonica || "").trim();
  const adminSubstBloqueada = adminOpDetail?.tipo === "SUBSTITUICAO" && !adminDescricaoCanonica;

  const loadAdminQueues = useCallback(async () => {
    setAdminQueuesLoading(true);
    setAdminQueuesErr("");
    try {
      const [solRes, subRes, devRes] = await Promise.all([
        adminOperacoesList({ tipo: "SOLICITACAO", status: "PENDENTE" }),
        adminOperacoesList({ tipo: "SUBSTITUICAO", status: "PENDENTE" }),
        adminOperacoesList({ tipo: "DEVOLUCAO", status: "PENDENTE" }),
      ]);
      setAdminQueueSolicitacoes(safeArray(solRes?.items));
      setAdminQueueSubstituicoes(safeArray(subRes?.items));
      setAdminQueueDevolucoes(safeArray(devRes?.items));
    } catch (e) {
      setAdminQueuesErr(e?.message ?? "Falha ao carregar filas do admin.");
      setAdminQueueSolicitacoes([]);
      setAdminQueueSubstituicoes([]);
      setAdminQueueDevolucoes([]);
    } finally {
      setAdminQueuesLoading(false);
    }
  }, []);

  const openAdminOpDetail = useCallback(async (item) => {
    if (!item?.id) return;
    setAdminOpDetailLoading(true);
    setAdminOpDetail(null);
    setAdminSubstitutoId("");
    setAdminSubstitutosDisponiveis([]);
    setAdminSubstitutosKits([]);
    setAdminEntregaItens([]);
    setAdminEntregaPinAdmin("");
    setAdminDevolucaoItens([]);
    setAdminDevolucaoPinAdmin("");
    setAdminOpDetailOpen(true);
    try {
      const res = await adminOperacaoDetalhe(item.id, item.origem);
      setAdminOpDetail(res);
      if (res?.tipo === "SUBSTITUICAO") {
        const canon = res?.contexto?.item_original?.descricao_canonica;
        if (canon) {
          setAdminSubstitutosLoading(true);
          try {
            const listRes = await adminSubstituicaoCandidatos({
              descricaoCanonica: canon,
              kitId: res?.contexto?.kit?.id,
            });
            setAdminSubstitutosDisponiveis(safeArray(listRes?.avulsos));
            setAdminSubstitutosKits(safeArray(listRes?.kits));
          } catch {
            setAdminSubstitutosDisponiveis([]);
            setAdminSubstitutosKits([]);
          } finally {
            setAdminSubstitutosLoading(false);
          }
        }
      }
      if (res?.tipo === "SOLICITACAO" && Array.isArray(res?.contexto?.itens)) {
        const itens = res.contexto.itens.map((it) => ({
          solicitacao_item_id: it.solicitacao_item_id || it.id,
          patrimonio: it.patrimonio,
          descricao: it.descricao,
          status: "PRESENTE",
          acao: "PENDENCIA",
          motivo: "",
          observacao: "",
        }));
        setAdminEntregaItens(itens);
      }
      if (res?.tipo === "DEVOLUCAO" && Array.isArray(res?.contexto?.itens)) {
        const itens = res.contexto.itens.map((it) => ({
          item_id: it.item_id,
          patrimonio: it.patrimonio,
          descricao: it.descricao,
          status: "PRESENTE",
          motivo: "",
          anexo_path: "",
        }));
        setAdminDevolucaoItens(itens);
      }
    } catch (e) {
      setAdminOpDetail(null);
      setAdminQueuesErr(e?.message ?? "Falha ao carregar detalhe da operação.");
    } finally {
      setAdminOpDetailLoading(false);
    }
  }, []);

  async function concluirEntregaAdmin() {
    const id = adminOpDetail?.id;
    if (!id) return;
    const pin = window.prompt("PIN admin (4 dígitos):");
    if (pin == null) return;
    setAdminOpActionLoading(true);
    try {
      await adminOperacaoConcluirEntrega(id, String(pin).trim());
      setAdminOpDetailOpen(false);
      await loadAdminQueues();
      await reloadMeusKits();
      await reloadMeusAvulsos();
    } catch (e) {
      toast(e?.message ?? "Falha ao concluir entrega.");
    } finally {
      setAdminOpActionLoading(false);
    }
  }

  async function confirmarDevolucaoAdmin() {
    const id = adminOpDetail?.id;
    if (!id) return;
    const pin = window.prompt("PIN admin (4 dígitos):");
    if (pin == null) return;
    setAdminOpActionLoading(true);
    try {
      await adminOperacaoConfirmarDevolucao(id, String(pin).trim());
      setAdminOpDetailOpen(false);
      await loadAdminQueues();
    } catch (e) {
      toast(e?.message ?? "Falha ao confirmar devolução.");
    } finally {
      setAdminOpActionLoading(false);
    }
  }

  async function aprovarSubstituicaoAdmin() {
    const id = adminOpDetail?.id;
    if (!id) return;
    const pin = window.prompt("PIN admin (4 dígitos):");
    if (pin == null) return;
    const subId = Number(adminSubstitutoId);
    if (!subId) {
      toast("Informe o ID do item substituto.");
      return;
    }
    setAdminOpActionLoading(true);
    try {
      await adminOperacaoAprovarSubstituicao(id, String(pin).trim(), subId);
      setAdminOpDetailOpen(false);
      await loadAdminQueues();
    } catch (e) {
      toast(e?.message ?? "Falha ao aprovar substituição.");
    } finally {
      setAdminOpActionLoading(false);
    }
  }

  function updateAdminEntregaItem(id, patch) {
    setAdminEntregaItens((prev) =>
      prev.map((it) => (it.solicitacao_item_id === id ? { ...it, ...patch } : it))
    );
  }

  function updateAdminDevolucaoItem(id, patch) {
    setAdminDevolucaoItens((prev) =>
      prev.map((it) => (it.item_id === id ? { ...it, ...patch } : it))
    );
  }

  async function confirmarEntregaAdmin() {
    const id = adminOpDetail?.id;
    if (!id) return;
    if (!adminEntregaPinAdmin.trim()) {
      toast("Informe o PIN do admin.");
      return;
    }
    setAdminOpActionLoading(true);
    try {
      await adminOperacaoConferirEntrega(id, {
        admin_pin: adminEntregaPinAdmin.trim(),
        itens: adminEntregaItens,
      });
      setAdminOpDetailOpen(false);
      await loadAdminQueues();
      await loadMasters();
      await reloadMeusKits();
      await reloadMeusAvulsos();
    } catch (e) {
      toast(e?.message ?? "Falha ao concluir entrega.");
    } finally {
      setAdminOpActionLoading(false);
    }
  }

  async function confirmarDevolucaoDetalhada() {
    const id = adminOpDetail?.id;
    if (!id) return;
    if (!adminDevolucaoPinAdmin.trim()) {
      toast("Informe o PIN do admin.");
      return;
    }
    setAdminOpActionLoading(true);
    try {
      await adminOperacaoConferirDevolucao(id, {
        admin_pin: adminDevolucaoPinAdmin.trim(),
        itens: adminDevolucaoItens,
      });
      setAdminOpDetailOpen(false);
      await loadAdminQueues();
      await loadAdminPendencias();
      await loadMasters();
    } catch (e) {
      toast(e?.message ?? "Falha ao confirmar devolução.");
    } finally {
      setAdminOpActionLoading(false);
    }
  }

  function openAdminTermo(mov) {
    const texto = mov?.termo_texto || "";
    setAdminTermoTexto(texto);
    setAdminTermoMeta({
      tipo: mov?.termo_tipo || "—",
      assinante: mov?.termo_assinatura_nome || "—",
      criado_em: mov?.termo_criado_em || null,
    });
    setAdminTermoOpen(true);
  }

  async function handleAdminResetSenha() {
    const userId = Number(adminResetUserId);
    if (!userId) {
      toast("Informe o ID do usuário.");
      return;
    }
    const pin = (adminResetPin || "").trim();
    if (!pin) {
      toast("Informe o PIN admin.");
      return;
    }
    setAdminCredLoading(true);
    setAdminResetMsg("");
    try {
      await adminResetSenha(userId, pin);
      setAdminResetMsg("Senha resetada para Perfil@2026.");
      setAdminResetUserId("");
      setAdminResetPin("");
    } catch (e) {
      setAdminResetMsg(e?.message ?? "Falha ao resetar senha.");
    } finally {
      setAdminCredLoading(false);
    }
  }

  async function handleAdminAlterarPinSubresp() {
    const subId = Number(adminSubPinId);
    if (!subId) {
      toast("Informe o ID do subresponsável.");
      return;
    }
    const pin = (adminSubPin || "").trim();
    const pin2 = (adminSubPinConfirm || "").trim();
    const adminPin = (adminSubPinAdminPin || "").trim();
    if (!/^\d{6}$/.test(pin)) {
      toast("Novo PIN deve ter 6 dígitos.");
      return;
    }
    if (pin !== pin2) {
      toast("PINs não conferem.");
      return;
    }
    if (!adminPin) {
      toast("Informe o PIN admin.");
      return;
    }
    setAdminCredLoading(true);
    setAdminResetMsg("");
    try {
      await adminAlterarPinSubresponsavel(subId, pin, pin2, adminPin);
      setAdminResetMsg("PIN do subresponsável atualizado.");
      setAdminSubPinId("");
      setAdminSubPin("");
      setAdminSubPinConfirm("");
      setAdminSubPinAdminPin("");
    } catch (e) {
      setAdminResetMsg(e?.message ?? "Falha ao alterar PIN do subresponsável.");
    } finally {
      setAdminCredLoading(false);
    }
  }

  const loadAdminUsuarios = useCallback(async () => {
    setAdminUsuariosLoading(true);
    setAdminUsuariosErr("");
    try {
      const res = await adminListUsuarios(adminUsuariosQuery);
      setAdminUsuarios(safeArray(res?.items));
    } catch (e) {
      setAdminUsuariosErr(e?.message ?? "Falha ao carregar usuários.");
      setAdminUsuarios([]);
    } finally {
      setAdminUsuariosLoading(false);
    }
  }, [adminUsuariosQuery]);

  async function handleCriarUsuarioAdmin() {
    const payload = {
      ...adminNovoUsuario,
      subresponsavel_id: adminNovoUsuario.subresponsavel_id
        ? Number(adminNovoUsuario.subresponsavel_id)
        : null,
      encarregado_id: adminNovoUsuario.encarregado_id ? Number(adminNovoUsuario.encarregado_id) : null,
    };
    if (!payload.nome_completo || !payload.username) {
      toast("Informe nome e username.");
      return;
    }
    setAdminUsuariosLoading(true);
    setAdminUsuariosErr("");
    try {
      await adminCriarUsuario(payload);
      setAdminNovoUsuario({
        nome_completo: "",
        username: "",
        perfil: "ENCARREGADO",
        subresponsavel_id: "",
        encarregado_id: "",
        ativo: true,
      });
      await loadAdminUsuarios();
    } catch (e) {
      setAdminUsuariosErr(e?.message ?? "Falha ao criar usuário.");
    } finally {
      setAdminUsuariosLoading(false);
    }
  }

  async function handleToggleUsuarioAtivo(user) {
    if (!user?.id) return;
    setAdminUsuariosLoading(true);
    try {
      if (Number(user.ativo) === 1) {
        await adminDesativarUsuario(user.id);
      } else {
        await adminAtivarUsuario(user.id);
      }
      await loadAdminUsuarios();
    } catch (e) {
      setAdminUsuariosErr(e?.message ?? "Falha ao atualizar usuário.");
    } finally {
      setAdminUsuariosLoading(false);
    }
  }

  async function handleCriarSubresponsavelAdmin() {
    const payload = {
      ...adminNovoSubresp,
      ativo: Boolean(adminNovoSubresp.ativo),
    };
    if (!payload.nome) {
      toast("Informe o nome do subresponsável.");
      return;
    }
    setAdminUsuariosLoading(true);
    setAdminUsuariosErr("");
    try {
      await adminCriarSubresponsavel(payload);
      setAdminNovoSubresp({ nome: "", secao: "", ativo: true });
    } catch (e) {
      setAdminUsuariosErr(e?.message ?? "Falha ao criar subresponsável.");
    } finally {
      setAdminUsuariosLoading(false);
    }
  }

  const loadAdminPendencias = useCallback(async () => {
    setAdminPendenciasLoading(true);
    try {
      const res = await adminListarPendenciasKits();
      setAdminPendenciasKits(safeArray(res?.items));
    } catch (e) {
      setAdminPendenciasKits([]);
    } finally {
      setAdminPendenciasLoading(false);
    }
  }, []);

  async function resolverPendenciaKit(pendenciaId) {
    if (!pendenciaId) return;
    setAdminPendenciasLoading(true);
    try {
      await adminResolverPendenciaKit(pendenciaId);
      await loadAdminPendencias();
      await loadMasters();
    } catch (e) {
      toast(e?.message ?? "Falha ao resolver pendência.");
    } finally {
      setAdminPendenciasLoading(false);
    }
  }

  useEffect(() => {
    const onPop = () => {
      setRoute(window.location.pathname.startsWith("/app") ? "app" : "login");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (authToken && route === "login") {
      goTo("/app");
    }
    if (!authToken && route === "app") {
      goTo("/login");
    }
  }, [authToken, route]);

  useEffect(() => {
    if (!authToken) {
      setCurrentUser(null);
      setCurrentUserErr("");
      setCurrentUserLoading(false);
      setSelectedEncarregadoId("");
      setPendingDevolucaoKits(new Set());
      setPendingDevolucaoAvulsos(new Set());
      setPendingSubstituicoes(new Set());
      return;
    }

    setCurrentUserLoading(true);
    setCurrentUserErr("");
    apiGet("/auth/me")
      .then((res) => {
        setCurrentUser(res);
        setMustChangePassword(Boolean(res?.must_change_password));
        setMustSetAdminPin(Boolean(res?.must_set_admin_pin));
      })
      .catch((e) => {
        setCurrentUserErr(e?.message ?? "Falha ao carregar perfil.");
        handleLogout();
      })
      .finally(() => {
        setCurrentUserLoading(false);
      });
  }, [authToken]);

  useEffect(() => {
    if (!authToken) return;
    refreshStatusOverview();
    refreshPendingOps();
  }, [authToken, refreshStatusOverview, refreshPendingOps]);

  useEffect(() => {
    if (!authToken) return;
    processPendingOps();
  }, [authToken, processPendingOps]);

  useEffect(() => {
    const encId = currentUser?.encarregado_id;
    if (encId) {
      setSelectedEncarregadoId(String(encId));
    } else {
      setSelectedEncarregadoId("");
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    refreshStatusOverview();
  }, [currentUser, refreshStatusOverview]);

  const reloadMeusAvulsos = useCallback(() => {
    if (!apiBase || !selectedEncarregadoId) {
      setMeusAvulsos([]);
      return Promise.resolve();
    }

    return fetch(`${apiBase}/avulsos/minha?encarregado_id=${selectedEncarregadoId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setMeusAvulsos)
      .catch(() => {
        setMeusAvulsos([]);
      });
  }, [apiBase, selectedEncarregadoId]);

  useEffect(() => {
    reloadMeusAvulsos().finally(() => {
      refreshPendingOps();
    });
  }, [reloadMeusAvulsos, refreshPendingOps]);

  const reloadMeusKits = useCallback(() => {
    const encId = selectedEncarregadoId || currentUser?.encarregado_id;
    if (!apiBase || !encId) {
      setMeusPosseKits([]);
      return Promise.resolve();
    }

    return fetch(`${apiBase}/posses/kits/minha?encarregado_id=${encId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setMeusPosseKits)
      .catch(() => {
        setMeusPosseKits([]);
      });
  }, [apiBase, selectedEncarregadoId, currentUser]);

  const reloadDisponiveis = useCallback(() => {
    if (!apiBase) {
      setKitsDisponiveisApi([]);
      setAvulsosDisponiveisApi([]);
      return Promise.resolve();
    }

    return Promise.all([
      fetch(`${apiBase}/posses/kits/disponiveis`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((res) => setKitsDisponiveisApi(safeArray(res)))
        .catch(() => setKitsDisponiveisApi([])),
      fetch(`${apiBase}/posses/avulsos/disponiveis`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((res) => {
          const list = safeArray(res);
          setAvulsos(list);
          setAvulsosDisponiveisApi(list);
        })
        .catch(() => {
          setAvulsos([]);
          setAvulsosDisponiveisApi([]);
        }),
    ]);
  }, [apiBase]);

  useEffect(() => {
    reloadMeusKits();
  }, [reloadMeusKits]);

  useEffect(() => {
    reloadDisponiveis();
  }, [reloadDisponiveis]);

  useEffect(() => {
    if (!authToken) return;

    const t = setInterval(() => {
      refreshStatusOverview();
      refreshPendingOps();
      processPendingOps();
      reloadMeusKits();
      reloadMeusAvulsos();
      reloadDisponiveis();
    }, 15000);

    const onFocus = () => {
      refreshStatusOverview();
      refreshPendingOps();
      processPendingOps();
      reloadMeusKits();
      reloadMeusAvulsos();
      reloadDisponiveis();
    };
    const onOnline = () => {
      processPendingOps();
      reloadMeusKits();
      reloadMeusAvulsos();
      reloadDisponiveis();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);

    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [
    authToken,
    processPendingOps,
    refreshStatusOverview,
    refreshPendingOps,
    reloadMeusKits,
    reloadMeusAvulsos,
    reloadDisponiveis,
  ]);

  useEffect(() => {
    const hasEletrico = Boolean(currentUser?.encarregado_id);
    if (modo === "eletrico" && !hasEletrico) {
      setModo("manual");
    }
  }, [modo, currentUser]);

  /**
   * Submit
   */
  const [submitting, setSubmitting] = useState(false);
  const [lastSubmit, setLastSubmit] = useState("");

  /**
   * =========================================================
   * Carga inicial (robusta)
   * =========================================================
   */
  async function loadMasters() {
    setLoading(true);
    setErr("");

    try {
      const [setoresRes, encRes, kitsRes, kitsDisponiveisRes, kitsPendRes] = await Promise.all([
        withRetry(() => apiGet("/setores/"), 2, 300),
        withRetry(() => apiGet("/encarregados/"), 2, 300),
        withRetry(() => apiGet("/kits/"), 2, 300),
        withRetry(() => apiGet("/posses/kits/disponiveis"), 2, 300),
        withRetry(() => apiGet("/kits/pendencias"), 2, 300),
      ]);

      setSetores(safeArray(setoresRes));
      setEncarregados(safeArray(encRes));
      setKits(safeArray(kitsRes));
      setKitsDisponiveisApi(safeArray(kitsDisponiveisRes));
      const pend = safeArray(kitsPendRes?.kits);
      setKitsPendentes(new Set(pend.map((id) => String(id))));
    } catch (e) {
      console.error("loadMasters error:", e);
      setErr(e?.message ?? "Falha ao buscar (rede instável). Tente recarregar.");
      // NÃO zera estados aqui; mantém o que tiver (se tiver)
    } finally {
      setLoading(false);
    }
  }

  async function runAdminBusca() {
    setAdminLoading(true);
    setAdminErr("");
    setAdminTrail(null);
    setAdminTrailTitle("");
    setAdminOpenBusca(true);
    setAdminOpenTrilha(true);
    try {
      const res = await adminBusca({
        query: adminQuery.trim(),
        setorId: adminSetorId,
      });
      setAdminResults(res);

      const posseRes = await adminManualPosse({
        query: adminQuery.trim(),
        setorId: adminSetorId,
      });
      setAdminManualPosseRows(safeArray(posseRes?.posse));
    } catch (e) {
      setAdminErr(e?.message ?? "Falha ao buscar dados do admin.");
      setAdminResults(null);
      setAdminManualPosseRows([]);
    } finally {
      setAdminLoading(false);
    }
  }

  async function openTrailKit(kit) {
    setAdminLoading(true);
    setAdminErr("");
    setAdminOpenTrilha(true);
    try {
      const res = await adminTrilhaKit(kit.id);
      setAdminTrail(res);
      setAdminTrailTitle(`Trilha do Kit #${kit.id} - ${kit.nome}`);
    } catch (e) {
      setAdminErr(e?.message ?? "Falha ao carregar trilha do kit.");
      setAdminTrail(null);
      setAdminTrailTitle("");
    } finally {
      setAdminLoading(false);
    }
  }

  async function openTrailPatrimonio(item) {
    setAdminLoading(true);
    setAdminErr("");
    setAdminOpenTrilha(true);
    try {
      const res = await adminTrilhaPatrimonio(item.patrimonio);
      setAdminTrail(res);
      setAdminTrailTitle(`Trilha do Patrimonio ${item.patrimonio}`);
    } catch (e) {
      setAdminErr(e?.message ?? "Falha ao carregar trilha do patrimonio.");
      setAdminTrail(null);
      setAdminTrailTitle("");
    } finally {
      setAdminLoading(false);
    }
  }

  async function handleLogin(e) {
    e?.preventDefault?.();
    setAuthErr("");
    setAuthNotice("");

    const user = authUser.trim();
    const pass = authPass;
    if (!user || !pass) {
      setAuthErr("Informe usuario e senha.");
      return;
    }

    setAuthLoading(true);
    try {
      const res = await login(user, pass);
      const tok = res?.access_token;
      const mustChange = Boolean(res?.must_change_password);
      const mustSetPin = Boolean(res?.must_set_admin_pin);
      if (!tok) {
        setAuthErr("Token nao retornado pelo login.");
        return;
      }
      localStorage.setItem("access_token", tok);
      setAuthToken(tok);
      setMustChangePassword(mustChange);
      setMustSetAdminPin(mustSetPin);
      if (mustChange) {
        setAuthNotice("Senha temporaria detectada. Defina sua senha para continuar.");
      } else if (mustSetPin) {
        setAuthNotice("Admin sem PIN. Defina o PIN para continuar.");
      }
      setAuthPass("");
      goTo("/app");
    } catch (e2) {
      const msg = e2?.message ?? "";
      if (msg.includes("401")) {
        setAuthErr("Credenciais inválidas. Verifique usuário e senha.");
      } else if (msg.includes("403")) {
        setAuthErr("Acesso restrito. Seu perfil não tem permissão para esta área.");
      } else {
        setAuthErr(msg || "Falha no login.");
      }
    } finally {
      setAuthLoading(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem("token");
    localStorage.removeItem("access_token");
    localStorage.removeItem("auth_token");
    localStorage.removeItem("jwt");
    setAuthToken("");
    setCurrentUser(null);
    setAuthUser("");
    setAuthPass("");
    setAuthErr("");
    setAuthNotice("");
    setMustSetAdminPin(false);
    goTo("/login");
  }

  async function submitNewPassword() {
    setNewPassErr("");

    const p1 = (newPassword || "").trim();
    const p2 = (confirmPassword || "").trim();

    if (!p1 || !p2) {
      setNewPassErr("Informe e confirme a nova senha.");
      return;
    }
    if (p1 !== p2) {
      setNewPassErr("As senhas nao conferem.");
      return;
    }
    if (p1.length > 8) {
      setNewPassErr("Senha deve ter no maximo 8 caracteres.");
      return;
    }
    if (!/^[a-zA-Z0-9]+$/.test(p1)) {
      setNewPassErr("Senha deve ser alfanumerica.");
      return;
    }

    setNewPassLoading(true);
    try {
      const res = await definirSenha(p1);
      const tok = res?.access_token;
      if (tok) {
        localStorage.setItem("access_token", tok);
        setAuthToken(tok);
      }
      setMustChangePassword(false);
      setNewPassword("");
      setConfirmPassword("");
    } catch (e) {
      setNewPassErr(e?.message ?? "Falha ao definir senha.");
    } finally {
      setNewPassLoading(false);
    }
  }

  useEffect(() => {
    loadMasters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (modo !== "manual") return;

    let alive = true;
    setManualLoading(true);
    setManualErr("");

    listarManuais(manualQuery)
      .then((res) => {
        if (!alive) return;
        setManualItens(safeArray(res));
      })
      .catch((e) => {
        if (!alive) return;
        setManualErr(e?.message ?? "Falha ao buscar itens manuais.");
        setManualItens([]);
      })
      .finally(() => {
        if (!alive) return;
        setManualLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [modo, manualQuery]);

  /**
   * =========================================================
   * GPS (best effort)
   * =========================================================
   */
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setGeo((g) => ({ ...g, ok: false }));
      return;
    }

    // tenta obter uma vez; se quiser, dá pra evoluir para watchPosition
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude ?? 0;
        const lng = pos.coords.longitude ?? 0;
        const acc = pos.coords.accuracy ?? 0;

        setGeo({
          ok: true,
          latitude: lat,
          longitude: lng,
          accuracy_m: acc,
          gps_timestamp: new Date().toISOString(),
        });
      },
      (e) => {
        console.warn("GPS error:", e);
        setGeo((g) => ({ ...g, ok: false }));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  }, []);

  /**
   * =========================================================
   * Carrega itens do kit quando muda kit
   * =========================================================
   */
  useEffect(() => {
    (async () => {
      if (!selectedKitId) {
        setKitItens([]);
        setStatusMap({});
        return;
      }

      setErr("");

      try {
        const res = await withRetry(() => apiGet(`/kits/${selectedKitId}/itens-detalhados/`), 2, 300);
        const list = safeArray(res);

        setKitItens(list);

        // inicializa statusMap por kit_item_id usando status do backend
        const next = {};
        for (const it of list) {
          const statusItem = String(it?.status_item ?? "").trim().toUpperCase();
          const isDistrib = statusItem === "DISTRIBUIDO";
          const lastSubId = it?.ultimo_movimento?.subresponsavel_id ?? null;
          const syncKey = buildRecolherKey(it?.kit_id, it?.patrimonio);
          const syncPending = pendingRecolherKeys.has(syncKey);
          next[it.kit_item_id] = {
            status: syncPending ? "PRESENTE" : isDistrib ? "DISTRIBUIDO" : "PRESENTE",
            subresponsavel_text: "",
            subresponsavel_id: lastSubId,
            distribuicao_confirmada: isDistrib,
            sync_pending: syncPending,
          };
        }
        setStatusMap(next);
      } catch (e) {
        console.error("load kit itens error:", e);
        setErr(e?.message ?? "Falha ao carregar itens do kit");
        setKitItens([]);
        setStatusMap({});
      }
    })();
  }, [pendingRecolherKeys, selectedKitId]);

  useEffect(() => {
    let alive = true;
    if (posseSelecionada?.tipo !== "kit" || !posseSelecionada?.data?.id) {
      setPosseKitItens([]);
      setPosseStatusMap({});
      return () => {
        alive = false;
      };
    }

    (async () => {
      const kitId = posseSelecionada.data.id;
      try {
        const res = await withRetry(() => apiGet(`/kits/${kitId}/itens-detalhados/`), 2, 300);
        if (!alive) return;
        const list = safeArray(res);
        setPosseKitItens(list);

        const next = {};
        for (const it of list) {
          const statusItem = String(it?.status_item ?? "").trim().toUpperCase();
          const isDistrib = statusItem === "DISTRIBUIDO";
          const lastSubId = it?.ultimo_movimento?.subresponsavel_id ?? null;
          const syncKey = buildRecolherKey(it?.kit_id, it?.patrimonio);
          const syncPending = pendingRecolherKeys.has(syncKey);
          next[it.kit_item_id] = {
            status: syncPending ? "PRESENTE" : isDistrib ? "DISTRIBUIDO" : "PRESENTE",
            subresponsavel_text: "",
            subresponsavel_id: lastSubId,
            distribuicao_confirmada: isDistrib,
            sync_pending: syncPending,
          };
        }
        setPosseStatusMap(next);
      } catch (e) {
        console.error("load posse kit itens error:", e);
        if (!alive) return;
        setPosseKitItens([]);
        setPosseStatusMap({});
      }
    })();

    return () => {
      alive = false;
    };
  }, [pendingRecolherKeys, posseSelecionada?.data?.id]);

  /**
   * =========================================================
   * Filtragem por busca (somente itens do kit)
   * =========================================================
   */
  const filtered = useMemo(() => {
    const nq = norm(q);
    if (!nq) return kitItens;

    return kitItens.filter((x) => {
      const a = norm(x.patrimonio);
      const b = norm(x.descricao);
      return a.includes(nq) || b.includes(nq);
    });
  }, [kitItens, q]);

  /**
   * =========================================================
   * Contadores
   * =========================================================
   */
  const totals = useMemo(() => {
    const total = kitItens.length;
    let presente = 0;
    let distribuido = 0;
    let pendente = 0;

    for (const ki of kitItens) {
      const st = statusMap[ki.kit_item_id]?.status ?? null;
      if (st === "PRESENTE") presente++;
      else if (st === "DISTRIBUIDO") distribuido++;
      else pendente++;
    }

    const pendingRequests =
      pendingDevolucaoKits.size + pendingDevolucaoAvulsos.size + pendingSubstituicoes.size;

    return {
      total,
      presente,
      distribuido,
      pendente: pendente + pendingRequests,
    };
  }, [kitItens, statusMap, pendingDevolucaoKits, pendingDevolucaoAvulsos, pendingSubstituicoes]);

  function buildManualTermoTexto(itemName) {
    const parts = [
      "TERMO DE RESPONSABILIDADE - RETIRADA DE ITEM MANUAL",
      "Declaro que recebi da empresa o item manual identificado no sistema, comprometendo-me a:",
      "1) Zelar, guardar e utilizar corretamente o bem, mantendo-o sob minha custodia enquanto estiver sob minha responsabilidade.",
      "2) Nao ceder, transferir ou subdividir a posse sem registro no sistema.",
      "3) Comunicar imediatamente ocorrencia de extravio, dano, roubo/furto, sinistro ou qualquer irregularidade, permitindo a apuracao interna.",
      "4) Reconheco que, havendo comprovacao de conduta dolosa ou culposa e do nexo com o prejuizo, podera haver responsabilizacao civil e/ou medidas cabiveis, com eventual ressarcimento na forma da lei, observadas as regras trabalhistas aplicaveis e o devido processo de apuracao.",
      "5) Autorizo o registro, para fins de seguranca, auditoria e rastreabilidade, de data/hora, identificacao do usuario, IP, user-agent e, quando disponivel, geolocalizacao, limitado a finalidade de controle patrimonial e prevencao de perdas.",
      "",
      `ITEM: ${itemName}`,
      `DATA/HORA: ${new Date().toLocaleString()}`,
    ];
    return parts.join("\n");
  }

  function buildChecklistTermoTexto() {
    const kitRef = (kitLabel ?? "").trim() || `KIT ${selectedKitId || ""}`.trim();
    const parts = [
      "TERMO DE RESPONSABILIDADE - CHECKLIST DE KIT ELETRICO",
      "Declaro que conferi o kit identificado no sistema, mantendo a custodia sob minha responsabilidade.",
      "Comprometo-me a zelar, guardar e utilizar corretamente os bens, comunicando de imediato qualquer dano ou extravio.",
      "",
      `KIT: ${kitRef}`,
      `DATA/HORA: ${new Date().toLocaleString()}`,
    ].filter(Boolean);
    return parts.join("\n");
  }

  /**
   * =========================================================
   * Regras de envio do CHECKLIST (kit completo)
   * =========================================================
   *
   * - precisa kit e encarregado
   * - NÃO pode ter pendente (kit completo)
   * - se DISTRIBUIDO, precisa estar CONFIRMADO (movimentos) e com subresponsavel_id
   * =========================================================
   */
  const canSubmit = useMemo(() => {
    if (!selectedKitId) return false;
    if (!selectedEncarregadoId) return false;
    if (kitItens.length === 0) return false;

    // kit completo
    if (totals.pendente > 0) return false;

    // distribuído precisa de confirmação + id
    for (const ki of kitItens) {
      const st = statusMap[ki.kit_item_id];
      if (st?.status === "DISTRIBUINDO") return false;
      if (st?.status === "DISTRIBUIDO") {
        if (!st.subresponsavel_id) return false;
        if (!st.distribuicao_confirmada) return false;
      }
    }

    return true;
  }, [selectedKitId, selectedEncarregadoId, kitItens, totals.pendente, statusMap]);

  /**
   * =========================================================
   * Mutators (status por item)
   * =========================================================
   */
  function setItemStatus(kitItemId, status) {
    setStatusMap((prev) => {
      const cur = prev[kitItemId] ?? {
        status: null,
        subresponsavel_text: "",
        subresponsavel_id: null,
        distribuicao_confirmada: false,
        sync_pending: false,
      };

      // Se voltou para PRESENTE, limpa dados de distribuição
      if (status === "PRESENTE") {
        return {
          ...prev,
          [kitItemId]: {
            ...cur,
            status: "PRESENTE",
            subresponsavel_text: "",
            subresponsavel_id: null,
            distribuicao_confirmada: false,
            sync_pending: cur.sync_pending ?? false,
          },
        };
      }

      // Se setou DISTRIBUIDO, mantém o que já digitou/selecionou
      if (status === "DISTRIBUIDO") {
        return {
          ...prev,
          [kitItemId]: {
            ...cur,
            status: "DISTRIBUIDO",
            sync_pending: cur.sync_pending ?? false,
          },
        };
      }

      // null = pendente
      return {
        ...prev,
        [kitItemId]: {
          ...cur,
          status: null,
          subresponsavel_text: "",
          subresponsavel_id: null,
          distribuicao_confirmada: false,
          sync_pending: cur.sync_pending ?? false,
        },
      };
    });
  }

  async function submitAdminPin() {
    setAdminPinErr("");
    const pin = (adminPin || "").trim();
    const pin2 = (adminPinConfirm || "").trim();

    if (!/^\d{4}$/.test(pin)) {
      setAdminPinErr("PIN deve ter 4 dígitos numéricos.");
      return;
    }
    if (pin !== pin2) {
      setAdminPinErr("PIN e confirmação não conferem.");
      return;
    }

    setAdminPinLoading(true);
    try {
      await definirAdminPin(pin, pin2);
      setMustSetAdminPin(false);
      setAdminPin("");
      setAdminPinConfirm("");
      toast("PIN admin definido.");
    } catch (e) {
      setAdminPinErr(e?.message ?? "Falha ao definir PIN admin.");
    } finally {
      setAdminPinLoading(false);
    }
  }

  function setItemStatusBoth(kitItemId, status) {
    setItemStatus(kitItemId, status);
    setPosseStatusMap((prev) => {
      const cur = prev?.[kitItemId];
      if (!cur) return prev;
      return {
        ...prev,
        [kitItemId]: {
          ...cur,
          status,
        },
      };
    });
  }

  function setItemSyncPending(kitItemId, syncPending) {
    setStatusMap((prev) => {
      const cur = prev[kitItemId];
      if (!cur) return prev;
      return {
        ...prev,
        [kitItemId]: {
          ...cur,
          status: syncPending ? "PRESENTE" : cur.status,
          sync_pending: Boolean(syncPending),
        },
      };
    });

    setPosseStatusMap((prev) => {
      const cur = prev?.[kitItemId];
      if (!cur) return prev;
      return {
        ...prev,
        [kitItemId]: {
          ...cur,
          status: syncPending ? "PRESENTE" : cur.status,
          sync_pending: Boolean(syncPending),
        },
      };
    });
  }

  function handleSubresponsavelPickPosse(kitItemId, picked) {
    if (kitItemId == null || !picked) return;
    setPosseStatusMap((prev) => {
      const cur = prev?.[kitItemId] ?? {
        status: null,
        subresponsavel_text: "",
        subresponsavel_id: null,
        distribuicao_confirmada: false,
        sync_pending: false,
      };
      return {
        ...prev,
        [kitItemId]: {
          ...cur,
          subresponsavel_id: Number(picked?.id) || null,
          subresponsavel_text: picked?.nome || "",
        },
      };
    });
  }

  function markDistribuindoPosse(kitItemId) {
    if (kitItemId == null) return;
    setPosseStatusMap((prev) => {
      const cur = prev?.[kitItemId] ?? {
        status: null,
        subresponsavel_text: "",
        subresponsavel_id: null,
        distribuicao_confirmada: false,
        sync_pending: false,
      };
      return {
        ...prev,
        [kitItemId]: {
          ...cur,
          status: "DISTRIBUINDO",
        },
      };
    });
  }

  function markDistribConfirmadoPosse(kitItemId) {
    if (!kitItemId) return;
    setPosseStatusMap((prev) => {
      const cur = prev?.[kitItemId] ?? {
        status: null,
        subresponsavel_text: "",
        subresponsavel_id: null,
        distribuicao_confirmada: false,
        sync_pending: false,
      };
      return {
        ...prev,
        [kitItemId]: {
          ...cur,
          distribuicao_confirmada: true,
          status: "DISTRIBUIDO",
        },
      };
    });
  }

  function handleDistribConfirmadoPosse(kitItemId) {
    markDistribConfirmadoPosse(kitItemId);
    refreshStatusOverview();
    refreshPendingOps();
  }

  function openManualTermo(item) {
    if (!authToken) {
      setManualErr("Faca login para retirar item manual.");
      return;
    }
    setManualSel(item);
    setManualAssinatura("");
    setManualQty(1);
    setManualTermoMsg("");
    setManualTermoOpen(true);
  }

  async function submitManualTermo() {
    if (!manualSel) return;

    const nome = (manualAssinatura ?? "").trim();
    if (!nome) {
      setManualTermoMsg("Informe o nome para assinatura.");
      return;
    }

    setManualTermoSubmitting(true);
    setManualTermoMsg("");

    try {
      const termoPayload = {
        tipo: "RETIRADA",
        referencia_tipo: "ITEM_MANUAL",
        referencia_id: Number(manualSel.id),
        texto_termo: buildManualTermoTexto(manualSel.nome),
        assinatura_nome: nome,
        latitude: isGpsValid(geo) ? Number(geo.latitude ?? 0) : null,
        longitude: isGpsValid(geo) ? Number(geo.longitude ?? 0) : null,
      };

      await criarTermo(termoPayload);

      await entregarManual({
        manual_item_id: Number(manualSel.id),
        quantidade: Number(manualQty) || 1,
        data_retirada: new Date().toISOString().slice(0, 10),
        observacao: "PWA",
      });

      setManualTermoOpen(false);
      setManualSel(null);
    } catch (e) {
      setManualTermoMsg(e?.message ?? "Falha ao retirar item manual.");
    } finally {
      setManualTermoSubmitting(false);
    }
  }

  /**
   * =========================================================
   * POST checklist (modelo atual do backend)
   *
   * Observação:
   * - backend hoje salva "patrimonios_declarados" no checklist semanal
   * - movimentos (distribuir/recolher) ficam na tabela item_movimentos
   * =========================================================
   */
  function openChecklistTermo() {
    setChecklistTermoMsg("");
    if (!authToken) {
      setErr("Faca login para enviar checklist.");
      return;
    }
    if (!selectedKitId || !selectedEncarregadoId) {
      setErr("Selecione kit e encarregado antes.");
      return;
    }
    setChecklistAssinatura("");
    setChecklistTermoOpen(true);
  }

  async function submitChecklistTermo() {
    const nome = (checklistAssinatura ?? "").trim();
    if (!nome) {
      setChecklistTermoMsg("Informe o nome para assinatura.");
      return;
    }

    if (!selectedKitId) {
      setChecklistTermoMsg("Selecione um kit antes de solicitar o termo.");
      return;
    }

    setChecklistTermoSubmitting(true);
    setChecklistTermoMsg("");
    try {
      const termoPayload = {
        tipo: "RETIRADA",
        referencia_tipo: "KIT",
        referencia_id: Number(selectedKitId),
        texto_termo: buildChecklistTermoTexto(),
        assinatura_nome: nome,
        latitude: isGpsValid(geo) ? Number(geo.latitude ?? 0) : null,
        longitude: isGpsValid(geo) ? Number(geo.longitude ?? 0) : null,
      };

      const termoRes = await criarTermo(termoPayload);

      try {
        await submitChecklist();
      } catch (e2) {
        console.warn("Checklist semanal falhou após termo:", e2);
        setChecklistTermoMsg("Termo criado, mas falha no checklist semanal. Tente reenviar.");
      }

      try {
        await solicitarEletrico({ kit_id: Number(selectedKitId), termo_id: Number(termoRes?.id) });
      } catch (e3) {
        console.warn("Solicitacao eletrica falhou após termo:", e3);
        setChecklistTermoMsg("Termo criado, mas falha ao registrar solicitação elétrica.");
        return;
      }

      addTransit(selectedKitId);
      setChecklistTermoOpen(false);
      setChecklistTermoMsg("Solicitação enviada. Kit em transição.");
    } catch (e) {
      setChecklistTermoMsg(e?.message ?? "Falha ao salvar termo do checklist.");
    } finally {
      setChecklistTermoSubmitting(false);
    }
  }

  async function submitChecklist() {
    setSubmitting(true);
    setErr("");
    setLastSubmit("");

    try {
      const encId = Number(selectedEncarregadoId);
      const kitId = Number(selectedKitId);

      // Monta texto compatível (auditoria)
      const lines = [];
      for (const ki of kitItens) {
        const st = statusMap[ki.kit_item_id];
        const base = `${ki.patrimonio} - ${ki.descricao}`;

        if (st?.status === "PRESENTE") {
          lines.push(base);
        } else if (st?.status === "DISTRIBUIDO") {
          const nome = (st.subresponsavel_text ?? "").trim();
          lines.push(`${base} | DISTRIBUIDO_PARA: ${nome}`);
        } else {
          lines.push(`${base} | PENDENTE`);
        }
      }

      const payload = {
        kit_id: kitId,
        encarregado_id: encId,
        latitude: Number(geo.latitude ?? 0),
        longitude: Number(geo.longitude ?? 0),
        patrimonios_declarados: lines.join("\n"),
      };

      await apiPost("/checklists-semanais/", payload);

      setLastSubmit(`Checklist enviado em ${new Date().toLocaleString()}`);
    } catch (e) {
      console.error("submitChecklist error:", e);
      setErr(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * =========================================================
   * Handlers novos (modo elétrico)
   * =========================================================
   */

  // 1) Distribuir: statusMap vira DISTRIBUIDO; picker + PIN faz a confirmação de fato
  function handleSubresponsavelPick(kitItemId, picked, justMarkDistribuido = false) {
    setStatusMap((prev) => {
      const cur = prev[kitItemId] ?? {
        status: null,
        subresponsavel_text: "",
        subresponsavel_id: null,
        distribuicao_confirmada: false,
        sync_pending: false,
      };

      // apenas marcar distribuindo pra abrir o picker
      if (justMarkDistribuido) {
        return {
          ...prev,
          [kitItemId]: { ...cur, status: "DISTRIBUINDO" },
        };
      }

      const id = picked?.id ?? null;
      const nome = picked?.nome ?? "";

      return {
        ...prev,
        [kitItemId]: {
          ...cur,
          status: "DISTRIBUINDO",
          subresponsavel_text: nome,
          subresponsavel_id: id,
          distribuicao_confirmada: false,
        },
      };
    });
  }

  async function solicitarDevolucaoKit(kitId) {
    console.log("CLICK DEVOLUCAO KIT", kitId);
    toast(`DEVOLUCAO KIT click: ${kitId ?? "sem id"}`);
    if (!kitId) {
      toast("Kit inválido para devolução.");
      return;
    }
    if (pendingDevolucaoKits.has(String(kitId))) {
      toast("Devolução já solicitada para este kit.");
      return;
    }
    if (!authToken) {
      toast("Faça login antes de solicitar a devolução.");
      return;
    }

    addTransit(kitId);
    try {
      const resp = await fetch(`${apiBase}/solicitacoes/operacao/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          tipo: "DEVOLUCAO_KIT",
          kit_id: Number(kitId),
        }),
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        let msg = resp.statusText;
        try {
          const j = JSON.parse(txt);
          msg = j?.detail ?? j?.message ?? msg;
        } catch {
          if (txt) msg = txt;
        }
        throw new Error(msg);
      }

      toast("Solicitação de devolução enviada. Aguarde validação do admin.");
      setPosseSelecionada(null);
      addPendingKit(kitId);
      refreshPendingOps();
      refreshStatusOverview();
      await reloadMeusKits();
    } catch (e) {
      removeTransit(kitId);
      toast(e?.message ?? "Não foi possível enviar a devolução.");
      console.error("solicitarDevolucaoKit error:", e);
    }
  }

  async function solicitarDevolucaoAvulso(itemId) {
    console.log("CLICK DEVOLUCAO AVULSO", itemId);
    toast(`DEVOLUCAO AVULSO click: ${itemId ?? "sem id"}`);
    if (!itemId) {
      toast("Avulso inválido para devolução.");
      return;
    }
    if (pendingDevolucaoAvulsos.has(String(itemId))) {
      toast("Devolução já solicitada para este avulso.");
      return;
    }
    if (!authToken) {
      toast("Faça login antes de solicitar a devolução.");
      return;
    }

    try {
        const resp = await fetch(`${apiBase}/solicitacoes/operacao/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          tipo: "DEVOLUCAO_AVULSO",
          item_id: Number(itemId),
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        throw new Error(err?.detail ?? err?.message ?? resp.statusText);
      }

      toast("Solicitação de devolução enviada. Aguarde validação do admin.");
      setPosseSelecionada(null);
      addPendingAvulso(itemId);
      refreshPendingOps();
      refreshStatusOverview();
      await reloadMeusAvulsos();
    } catch (e) {
      toast(e?.message ?? "Não foi possível enviar a devolução.");
      console.error("solicitarDevolucaoAvulso error:", e);
    }
  }

  // 3) Solicitar substituição (usuário só solicita + motivo; admin escolhe equivalente e valida com PIN)
  function handleSolicitarSubstituicao(item) {
    if (!selectedKitId || !item) return;
    setSubstModalItem(item);
    setSubstObservacao("");
  }

  async function submitSolicitacaoSubstituicao(motivo) {
    console.log("CLICK SUBSTITUICAO", substModalItem);
    toast("SUBSTITUICAO click");
    if (!selectedKitId || !substModalItem) return;

    if (!["MANUTENCAO", "FURTO"].includes(motivo)) return;

    if (!authToken) {
      toast("Faça login antes de solicitar substituição.");
      return;
    }

    setSubstSubmitting(true);
    const substItemId = Number(
      substModalItem.item_id ?? substModalItem.id ?? substModalItem.kit_item_id
    );
    if (!substItemId) {
      toast("Item inválido para substituição.");
      setSubstSubmitting(false);
      return;
    }
    if (pendingSubstituicoes.has(String(substItemId))) {
      toast("Substituição já solicitada para este item.");
      setSubstSubmitting(false);
      return;
    }
    try {
        const resp = await fetch(`${apiBase}/solicitacoes/operacao/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          tipo: "SUBSTITUICAO_ITEM",
          kit_id: Number(selectedKitId),
          item_id: substItemId,
          motivo,
          observacao: substObservacao ? `PWA: ${substObservacao}` : "PWA",
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        throw new Error(err?.detail ?? err?.message ?? resp.statusText);
      }

      toast("Solicitação de substituição enviada. Admin vai escolher equivalente e validar com PIN.");
      addPendingSubstituicao(substItemId);
      refreshPendingOps();
      refreshStatusOverview();
      setSubstModalItem(null);
    } catch (e) {
      toast("Não consegui registrar no backend (endpoint de substituição ainda não confirmado).");
      console.warn("substituicao request error:", e);
    } finally {
      setSubstSubmitting(false);
    }
  }

  // 4) Reagrupar (usuário retoma item distribuído e reintegra no kit)
  async function handleReagruparItem(item) {
    if (!item) return;

    const kitId = Number(
      item?.kit_id ?? posseSelecionada?.data?.id ?? selectedKitId ?? 0
    );
    if (!kitId) {
      toast("Kit inválido para reagrupar.");
      return;
    }

    const encId = Number(selectedEncarregadoId || currentUser?.encarregado_id || 0);
    if (!encId) {
      toast("Encarregado não definido. Selecione o encarregado antes de reagrupar.");
      return;
    }

    const ok = window.confirm(
      `Confirma a posse do item e a reinserção no kit?\n\n${item.patrimonio} - ${item.descricao}`
    );
    if (!ok) return;

    try {
      const payload = {
        kit_id: kitId,
        patrimonio: String(item.patrimonio),
        encarregado_id: encId,
        lat: isGpsValid(geo) ? Number(geo.latitude ?? 0) : null,
        lng: isGpsValid(geo) ? Number(geo.longitude ?? 0) : null,
        observacao: "PWA_REAGRUPAR",
      };

      if (!navigator.onLine || !isGpsValid(geo)) {
        enqueuePendingOp({
          type: "RECOLHER",
          payload,
          meta: { kit_item_id: item.kit_item_id ?? null },
        });
        setItemStatusBoth(item.kit_item_id, "PRESENTE");
        setItemSyncPending(item.kit_item_id, true);
        toast("Reagrupar registrado. Sincronização pendente.");
        return;
      }

      await apiRecolher(payload);

      setItemStatusBoth(item.kit_item_id, "PRESENTE");
      setItemSyncPending(item.kit_item_id, false);
      refreshStatusOverview();
      refreshPendingOps();
      toast("Item reagruparado e reinserido no kit.");
    } catch (e) {
      enqueuePendingOp({
        type: "RECOLHER",
        payload: {
          kit_id: kitId,
          patrimonio: String(item.patrimonio),
          encarregado_id: encId,
          lat: isGpsValid(geo) ? Number(geo.latitude ?? 0) : null,
          lng: isGpsValid(geo) ? Number(geo.longitude ?? 0) : null,
          observacao: "PWA_REAGRUPAR",
        },
        meta: { kit_item_id: item.kit_item_id ?? null },
      });
      setItemStatusBoth(item.kit_item_id, "PRESENTE");
      setItemSyncPending(item.kit_item_id, true);
      toast("Sem conexão. Reagrupar ficou pendente para sincronizar.");
      console.warn("reagrupar error:", e);
    }
  }

  // 5) Avulso: solicitar uso temporário

  /**
   * =========================================================
   * UI
   * =========================================================
   */
  const role = currentUser?.role ?? "";
  const isAdmin = role === "admin";
  const isOperador = role === "manutencao";
  const hasProfile = Boolean(currentUser);
  const isUsuario = hasProfile && !isAdmin && !isOperador;

  useEffect(() => {
    if (!authToken || !isAdmin) return;
    loadAdminQueues();
  }, [authToken, isAdmin, loadAdminQueues]);

  useEffect(() => {
    if (!authToken || !isAdmin) return;
    loadAdminUsuarios();
  }, [authToken, isAdmin, loadAdminUsuarios]);

  useEffect(() => {
    if (!authToken || !isAdmin) return;
    loadAdminPendencias();
  }, [authToken, isAdmin, loadAdminPendencias]);

  const roleCopy = !hasProfile
    ? ""
    : isAdmin
      ? "Painel Administrativo ? visao global de kits, itens, termos, checklists e movimentos."
      : isOperador
        ? "Operador ? cadastro e gestao de kits e ferramentas."
        : "Operacao ? retirada, termo de responsabilidade e registro de custodia.";

  const adminKits = safeArray(adminResults?.kits);
  const adminItens = safeArray(adminResults?.itens);

  const gpsLabel = isGpsValid(geo) ? "GPS ok" : geo.ok ? "GPS inválido" : "GPS indisponível";

  const canEletrico = Boolean(currentUser?.encarregado_id);
  const disableSolicitarTermo = !selectedKitId || isTransit(selectedKitId);

  const encarregadoLabel = useMemo(() => {
    const encId = currentUser?.encarregado_id;
    if (!encId) return "";
    const enc = encarregados.find((x) => String(x.id) === String(encId));
    if (!enc) return `Encarregado #${encId}`;
    return `${enc.nome} (${enc.funcao ?? "-"})`;
  }, [currentUser, encarregados]);


  if (route === "login") {
    return (
      <div
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(1200px 600px at 10% 10%, rgba(56, 78, 108, 0.45), rgba(10, 12, 18, 0.98))",
          color: "#e8ecf2",
          display: "grid",
          placeItems: "center",
          padding: 20,
        }}
      >
        <div
          style={{
            width: "min(520px, 92vw)",
            background: "rgba(14, 18, 26, 0.9)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 16,
            padding: 24,
            boxShadow: "0 30px 80px rgba(0,0,0,.45)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                background: "linear-gradient(135deg, #2b4b6a, #0f1a2a)",
                border: "1px solid rgba(255,255,255,0.12)",
                display: "grid",
                placeItems: "center",
                fontWeight: 800,
              }}
            >
              PX
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: 0.2 }}>Monitoramento Perfil-X</div>
              <div style={{ fontSize: 13, opacity: 0.8 }}>Controle e Rastreabilidade</div>
            </div>
          </div>

          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 18 }}>
            Acesso exclusivo para equipes autorizadas. Suas acoes geram rastreabilidade e registro de custodia.
          </div>

          <form onSubmit={handleLogin} style={{ display: "grid", gap: 10 }}>
            <label style={{ fontSize: 12, opacity: 0.8 }}>Usuario</label>
            <input
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.04)",
                color: "#e8ecf2",
              }}
              placeholder="ex.: rehuel"
              value={authUser}
              onChange={(e) => setAuthUser(e.target.value)}
            />

            <label style={{ fontSize: 12, opacity: 0.8 }}>Senha</label>
            <input
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.04)",
                color: "#e8ecf2",
              }}
              placeholder="????????"
              type="password"
              value={authPass}
              onChange={(e) => setAuthPass(e.target.value)}
            />

            <button
              type="submit"
              disabled={authLoading}
              style={{
                marginTop: 6,
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #1b2a3d",
                background: "#1b2a3d",
                color: "#fff",
                fontWeight: 800,
                cursor: authLoading ? "not-allowed" : "pointer",
              }}
            >
              {authLoading ? "Entrando..." : "Entrar"}
            </button>
          </form>

          {authErr ? (
            <div style={{ marginTop: 12, fontSize: 12, color: "#ffb3b3" }}>{authErr}</div>
          ) : null}
          {authNotice ? (
            <div style={{ marginTop: 8, fontSize: 12, color: "#ffd27d" }}>{authNotice}</div>
          ) : null}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 16, fontFamily: "system-ui" }}>
        <h2 style={{ marginBottom: 8 }}>Checklist Semanal • Ferramental</h2>
        <p>Carregando dados…</p>
        <p style={{ opacity: 0.7 }}>
          API: <code>{apiBase}</code>
        </p>
      </div>
    );
  }



  return (
    <div
      className={`user-panel ${modo === "eletrico" ? "mode-eletrico" : "mode-manual"}`}
      style={{ padding: 16, fontFamily: "system-ui", maxWidth: 1200, margin: "0 auto" }}
    >
      <h2 style={{ marginBottom: 6 }}>Checklist Semanal • Ferramental</h2>

      <div style={{ opacity: 0.8, marginBottom: 12, fontSize: 13 }}>
        API: <code>{apiBase}</code> • {gpsLabel} • {nowISO()}
      </div>

      <header
        className="user-topbar"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          padding: 12,
          border: "1px solid #ddd",
          borderRadius: 12,
          marginBottom: 12,
          background: "#f7f7f7",
        }}
      >
        <div className="user-topbar__text" style={{ flex: 1, minWidth: 0 }}>
          <div className="user-topbar__title" style={{ fontWeight: 800 }}>
            Usuário
          </div>
          <div style={{ fontSize: 14, opacity: 0.9, marginTop: 2 }}>
            {currentUser?.nome ||
              (hasProfile ? (isAdmin ? "Admin" : isOperador ? "Operador" : "Usuario") : "Carregando")}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>Encarregado/Supervisor</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {canEletrico ? (
              <span style={{ fontWeight: 700 }}>{encarregadoLabel}</span>
            ) : (
              "Usuário sem encarregado vinculado. Eletricos bloqueados."
            )}
          </div>
          {roleCopy ? (
            <div className="user-topbar__subtitle" style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
              {roleCopy}
            </div>
          ) : null}
          {authNotice ? (
            <div style={{ fontSize: 12, color: "#b26d00", marginTop: 4 }}>{authNotice}</div>
          ) : null}
          {currentUserLoading ? (
            <div style={{ fontSize: 12, opacity: 0.6 }}>Carregando perfil...</div>
          ) : null}
          {currentUserErr ? (
            <div style={{ fontSize: 12, color: "#b00020" }}>{currentUserErr}</div>
          ) : null}
        </div>
        <button
          className="user-topbar__logout"
          onClick={handleLogout}
          style={{
            padding: "8px 12px",
            border: "1px solid #111",
            borderRadius: 8,
            background: "#111",
            color: "#fff",
            cursor: "pointer",
            fontWeight: 700,
          }}
        >
          Sair
        </button>
      </header>



      

      {mustChangePassword ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 99999,
            padding: 16,
          }}
        >
          <div
            style={{
              width: "min(520px, 94vw)",
              background: "#fff",
              color: "#111",
              borderRadius: 12,
              padding: 16,
              boxShadow: "0 20px 60px rgba(0,0,0,.35)",
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Definir senha</div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
              Primeiro acesso: crie sua senha (alfanumerica, maximo 8 caracteres).
            </div>

            <label style={{ fontSize: 12, opacity: 0.85 }}>Nova senha</label>
            <input
              style={{ width: "100%", padding: 10, marginTop: 4, marginBottom: 8 }}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />

            <label style={{ fontSize: 12, opacity: 0.85 }}>Confirmar senha</label>
            <input
              style={{ width: "100%", padding: 10, marginTop: 4, marginBottom: 8 }}
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />

            {newPassErr ? <div style={{ color: "#b00020", fontSize: 12 }}>{newPassErr}</div> : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
              <button
                onClick={submitNewPassword}
                disabled={newPassLoading}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                  cursor: newPassLoading ? "not-allowed" : "pointer",
                  fontWeight: 800,
                }}
              >
                {newPassLoading ? "Salvando..." : "Salvar senha"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {mustSetAdminPin ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 99999,
            padding: 16,
          }}
        >
          <div
            style={{
              width: "min(520px, 94vw)",
              background: "#fff",
              color: "#111",
              borderRadius: 12,
              padding: 16,
              boxShadow: "0 20px 60px rgba(0,0,0,.35)",
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Definir PIN admin</div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
              Primeiro acesso: crie seu PIN de 4 dígitos.
            </div>

            <label style={{ fontSize: 12, opacity: 0.85 }}>Novo PIN</label>
            <input
              style={{ width: "100%", padding: 10, marginTop: 4, marginBottom: 8 }}
              type="password"
              value={adminPin}
              onChange={(e) => setAdminPin(e.target.value)}
            />

            <label style={{ fontSize: 12, opacity: 0.85 }}>Confirmar PIN</label>
            <input
              style={{ width: "100%", padding: 10, marginTop: 4, marginBottom: 8 }}
              type="password"
              value={adminPinConfirm}
              onChange={(e) => setAdminPinConfirm(e.target.value)}
            />

            {adminPinErr ? <div style={{ color: "#b00020", fontSize: 12 }}>{adminPinErr}</div> : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
              <button
                onClick={submitAdminPin}
                disabled={adminPinLoading}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                  cursor: adminPinLoading ? "not-allowed" : "pointer",
                  fontWeight: 800,
                }}
              >
                {adminPinLoading ? "Salvando..." : "Salvar PIN"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

            {isAdmin && (
        <div style={{ marginBottom: 18 }}>
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 12,
              background: "#fafafa",
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontWeight: 800 }}>Painel Admin - Filas Operacionais</div>
              <button
                onClick={loadAdminQueues}
                disabled={adminQueuesLoading}
                style={{
                  padding: "6px 10px",
                  border: "1px solid #111",
                  borderRadius: 8,
                  background: "#111",
                  color: "#fff",
                  cursor: adminQueuesLoading ? "not-allowed" : "pointer",
                  fontWeight: 800,
                }}
              >
                {adminQueuesLoading ? "Carregando..." : "Recarregar filas"}
              </button>
            </div>

            {adminQueuesErr ? (
              <div style={{ marginTop: 8, fontSize: 12, color: "#b00020" }}>{adminQueuesErr}</div>
            ) : null}

            <div className="admin-results-grid" style={{ marginTop: 12 }}>
              <div className="admin-panel-card">
                <h3>Solicitações pendentes</h3>
                <div className="admin-list-scroll admin-queue-scroll">
                  {adminQueueSolicitacoes.length === 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Sem pendências.</div>
                  ) : (
                    adminQueueSolicitacoes.map((op) => (
                      <div
                        key={`${op.origem || "sol"}-${op.id}`}
                        style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0" }}
                      >
                        <div>
                          <div style={{ fontWeight: 700 }}>
                            {op.kit?.nome || `Kit #${op.kit?.id || "-"}`}
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.7 }}>
                            {op.solicitante?.nome || "—"} • {op.categoria || "KIT"}
                          </div>
                        </div>
                        <button
                          onClick={() => openAdminOpDetail(op)}
                          style={{ padding: "2px 6px", border: "1px solid #111", borderRadius: 6, cursor: "pointer" }}
                        >
                          Detalhe
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="admin-panel-card">
                <h3>Substituições pendentes</h3>
                <div className="admin-list-scroll admin-queue-scroll">
                  {adminQueueSubstituicoes.length === 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Sem pendências.</div>
                  ) : (
                    adminQueueSubstituicoes.map((op) => (
                      <div
                        key={`${op.origem || "sub"}-${op.id}`}
                        style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0" }}
                      >
                        <div>
                          <div style={{ fontWeight: 700 }}>
                            {op.item?.patrimonio || op.kit?.nome || `#${op.id}`}
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.7 }}>
                            {op.solicitante?.nome || "—"} • {op.categoria || "KIT"}
                          </div>
                        </div>
                        <button
                          onClick={() => openAdminOpDetail(op)}
                          style={{ padding: "2px 6px", border: "1px solid #111", borderRadius: 6, cursor: "pointer" }}
                        >
                          Detalhe
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="admin-panel-card">
                <h3>Devoluções pendentes</h3>
                <div className="admin-list-scroll admin-queue-scroll">
                  {adminQueueDevolucoes.length === 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Sem pendências.</div>
                  ) : (
                    adminQueueDevolucoes.map((op) => (
                      <div
                        key={`${op.origem || "dev"}-${op.id}`}
                        style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0" }}
                      >
                        <div>
                          <div style={{ fontWeight: 700 }}>
                            {op.item?.patrimonio || op.kit?.nome || `#${op.id}`}
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.7 }}>
                            {op.solicitante?.nome || "—"} • {op.categoria || "KIT"}
                          </div>
                        </div>
                        <button
                          onClick={() => openAdminOpDetail(op)}
                          style={{ padding: "2px 6px", border: "1px solid #111", borderRadius: 6, cursor: "pointer" }}
                        >
                          Detalhe
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 12,
              background: "#fafafa",
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontWeight: 800 }}>Kits com pendência</div>
              <button
                onClick={loadAdminPendencias}
                disabled={adminPendenciasLoading}
                style={{
                  padding: "6px 10px",
                  border: "1px solid #111",
                  borderRadius: 8,
                  background: "#111",
                  color: "#fff",
                  cursor: adminPendenciasLoading ? "not-allowed" : "pointer",
                  fontWeight: 800,
                }}
              >
                {adminPendenciasLoading ? "Carregando..." : "Recarregar"}
              </button>
            </div>
            <div className="admin-list-scroll" style={{ marginTop: 8 }}>
              {adminPendenciasKits.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.7 }}>Sem pendências.</div>
              ) : (
                adminPendenciasKits.map((p) => (
                  <div
                    key={p.id}
                    style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0" }}
                  >
                    <div style={{ fontSize: 12 }}>
                      <div style={{ fontWeight: 700 }}>{p.kit_nome || `Kit #${p.kit_id}`}</div>
                      <div style={{ opacity: 0.7 }}>
                        {p.descricao_canonica || "-"} • {p.motivo || "PENDENCIA"}
                      </div>
                    </div>
                    <button
                      onClick={() => resolverPendenciaKit(p.id)}
                      disabled={adminPendenciasLoading}
                      style={{
                        padding: "2px 6px",
                        border: "1px solid #111",
                        borderRadius: 6,
                        cursor: adminPendenciasLoading ? "not-allowed" : "pointer",
                      }}
                    >
                      Resolver
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 12,
              background: "#fafafa",
              marginBottom: 12,
            }}
          >
            <div
              onClick={() => setAdminOpenBusca((v) => !v)}
              style={{ fontWeight: 800, marginBottom: 8, cursor: "pointer" }}
            >
              Painel Admin - Busca Global {adminOpenBusca ? "▾" : "▸"}
            </div>

            {adminOpenBusca ? (
              <>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    style={{ flex: 1, minWidth: 220, padding: 10 }}
                    placeholder="Buscar por kit, patrimonio ou nome"
                    value={adminQuery}
                    onChange={(e) => setAdminQuery(e.target.value)}
                  />

                  <select
                    style={{ padding: 10, minWidth: 180 }}
                    value={adminSetorId}
                    onChange={(e) => setAdminSetorId(e.target.value)}
                  >
                    <option value="">Todas as obras/setores</option>
                    {setores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nome}
                      </option>
                    ))}
                  </select>

                  <button
                    onClick={runAdminBusca}
                    disabled={adminLoading}
                    style={{
                      padding: "10px 12px",
                      border: "1px solid #111",
                      borderRadius: 10,
                      background: "#111",
                      color: "#fff",
                      cursor: adminLoading ? "not-allowed" : "pointer",
                      fontWeight: 800,
                    }}
                  >
                    {adminLoading ? "Buscando..." : "Buscar"}
                  </button>
                </div>

                {adminErr ? (
                  <div style={{ background: "#ffe8e8", border: "1px solid #ffb3b3", padding: 10, marginBottom: 12 }}>
                    <b>Erro:</b> {adminErr}
                  </div>
                ) : null}

                <div className="admin-results-grid">
                  <div className="admin-panel-card">
                    <h3>Kits</h3>
                    <div className="admin-list-scroll">
                      {adminKits.length === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.7 }}>Sem resultados.</div>
                      ) : (
                        adminKits.map((k) => (
                          <div key={k.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0" }}>
                            <div>#{k.id} {k.nome}</div>
                            <button
                              onClick={() => openTrailKit(k)}
                              style={{ padding: "2px 6px", border: "1px solid #111", borderRadius: 6, cursor: "pointer" }}
                            >
                              Trilha
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="admin-panel-card">
                    <h3>Itens (patrimônio)</h3>
                    <div className="admin-list-scroll">
                      {adminItens.length === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.7 }}>Sem resultados.</div>
                      ) : (
                        adminItens.map((it) => (
                          <div key={it.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0" }}>
                            <div>{it.patrimonio}</div>
                            <button
                              onClick={() => openTrailPatrimonio(it)}
                              style={{ padding: "2px 6px", border: "1px solid #111", borderRadius: 6, cursor: "pointer" }}
                            >
                              Trilha
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="admin-panel-card">
                    <h3>Posse manual (atual)</h3>
                    <div className="admin-list-scroll">
                      {adminManualPosseRows.length === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.7 }}>Sem resultados.</div>
                      ) : (
                        adminManualPosseRows.map((row) => (
                          <div key={row.id} style={{ padding: "4px 0", fontSize: 13 }}>
                            {row.manual_item_nome} - {row.quantidade} un. - {row.encarregado_nome || row.subresponsavel_nome || "-"}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                {adminOpenTrilha && adminTrail ? (
                  <div className="admin-trail-shell" style={{ marginTop: 12 }}>
                    <div className="admin-trail-header">
                      <div>
                        <div className="trail-title">Trilha</div>
                        <div className="trail-subtitle muted">
                          {adminTrailTitle || "—"} • Última atualização: {formatDateTime(adminTrailLastUpdate)}
                        </div>
                      </div>

                      <div className="trail-actions">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setAdminTrailShowTech((v) => !v)}
                        >
                          {adminTrailShowTech ? "Ocultar técnico" : "Ver técnico"}
                        </button>
                      </div>
                    </div>

                    <div className="admin-trail-grid-top">
                      <div className="trail-card">
                        <div className="trail-card-title">Checklist</div>
                        <div className="trail-card-body">
                          {adminTrailChecklists.length ? (
                            adminTrailChecklists.slice(0, 3).map((c) => (
                              <div key={c.id || c.data_hora} className="trail-item">
                                <div>
                                  <strong>Quando:</strong> {formatDateTime(c.data_hora)}
                                </div>
                                <div>
                                  <strong>Kit:</strong> {c.kit_nome || c.kit_id || "—"}
                                </div>
                                <div>
                                  <strong>Patrimônios:</strong> {c.patrimonios_declarados || "—"}
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="muted">Nenhum checklist nesta trilha.</div>
                          )}
                        </div>
                      </div>

                      <div className="trail-card trail-termos-wide">
                        <div className="trail-card-title">
                          <span>Termos</span>
                          {adminTrailOldTerms.length > 0 && (
                            <button
                              type="button"
                              className="link-btn"
                              onClick={() => setAdminTermsShowHistory((v) => !v)}
                            >
                              {adminTermsShowHistory
                                ? "Ocultar histórico"
                                : `Ver histórico (${adminTrailOldTerms.length})`}
                            </button>
                          )}
                        </div>

                        <div className="trail-card-body">
                          {adminTrailLastTerm ? (
                            <>
                              <div className="trail-item">
                                <div>
                                  <strong>Último termo:</strong>{" "}
                                  {adminTrailLastTerm.tipo || adminTrailLastTerm.status || "—"}
                                </div>
                                <div>
                                  <strong>Assinante:</strong>{" "}
                                  {adminTrailLastTerm.assinatura_nome || adminTrailLastTerm.nome || "—"}
                                </div>
                                <div>
                                  <strong>Data:</strong>{" "}
                                  {formatDateTime(adminTrailLastTerm.criado_em || adminTrailLastTerm.created_at)}
                                </div>
                              </div>

                              <div className="trail-termo-text">
                                {adminTrailLastTerm.texto_termo || adminTrailLastTerm.texto || "—"}
                              </div>

                              {adminTermsShowHistory && (
                                <div className="trail-history">
                                  {adminTrailOldTerms.map((t) => (
                                    <div key={t.id || t.criado_em} className="trail-item">
                                      <div>
                                        <strong>{t.tipo || t.status || "Termo"}</strong>
                                      </div>
                                      <div className="muted">{formatDateTime(t.criado_em || t.created_at)}</div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="muted">
                              Sem termo registrado: não houve cautela assinada neste registro.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="trail-card-wide">
                      <div className="trail-card-title">Movimentos</div>
                      <div className="trail-card-body">
                        {adminTrailMovements.length ? (
                          <div className="trail-table-wrapper">
                            <table className="admin-trail-table">
                              <thead>
                                <tr>
                                  <th>Ação</th>
                                  <th>Item</th>
                                  <th>Qtde</th>
                                  <th>Registrado por</th>
                                  <th>PIN</th>
                                  <th>Termo</th>
                                  <th>Data</th>
                                </tr>
                              </thead>
                              <tbody>
                                {adminTrailMovements.map((m) => (
                                  <tr key={m.id || `${m.acao}-${m.data_hora}`}>
                                    <td>{m.acao || m.tipo || "—"}</td>
                                    <td>{m.patrimonio || m.item_patrimonio || "—"}</td>
                                    <td>{m.quantidade ?? "—"}</td>
                                    <td>
                                      {m.registrado_por_nome || m.registrado_por || m.encarregado_nome || "—"}
                                    </td>
                                    <td>
                                      {m.pin_tipo && m.pin_tipo !== "NONE"
                                        ? `${m.pin_tipo} • ${m.pin_autor_nome || m.pin_autor || "—"}`
                                        : "—"}
                                    </td>
                                    <td>
                                      {m.termo_texto ? (
                                        <button
                                          onClick={() => openAdminTermo(m)}
                                          style={{
                                            padding: "2px 6px",
                                            border: "1px solid #111",
                                            borderRadius: 6,
                                            cursor: "pointer",
                                          }}
                                        >
                                          Ver termo
                                        </button>
                                      ) : (
                                        "—"
                                      )}
                                    </td>
                                    <td>{formatDateTime(m.data_hora || m.created_at)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="muted">Nenhum movimento nesta trilha.</div>
                        )}
                      </div>
                    </div>

                    {adminTrailShowTech && (
                      <div className="trail-technical">
                        <pre className="trail-raw">{JSON.stringify(adminTrail ?? {}, null, 2)}</pre>
                      </div>
                    )}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 12,
              background: "#fafafa",
              marginBottom: 12,
            }}
          >
            <div
              onClick={() => setAdminOpenCred((v) => !v)}
              style={{ fontWeight: 800, marginBottom: 8, cursor: "pointer" }}
            >
              Credenciais (Admin) {adminOpenCred ? "▾" : "▸"}
            </div>
            {adminOpenCred ? (
              <>
                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Reset de senha</div>
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="ID do usuário"
                      value={adminResetUserId}
                      onChange={(e) => setAdminResetUserId(e.target.value)}
                    />
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="PIN admin (4 dígitos)"
                      value={adminResetPin}
                      onChange={(e) => setAdminResetPin(e.target.value)}
                    />
                    <button
                      onClick={handleAdminResetSenha}
                      disabled={adminCredLoading}
                      style={{
                        padding: "6px 10px",
                        border: "1px solid #111",
                        borderRadius: 8,
                        background: "#111",
                        color: "#fff",
                        cursor: adminCredLoading ? "not-allowed" : "pointer",
                        fontWeight: 800,
                      }}
                    >
                      Resetar senha
                    </button>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Alterar PIN subresponsável</div>
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="ID do subresponsável"
                      value={adminSubPinId}
                      onChange={(e) => setAdminSubPinId(e.target.value)}
                    />
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="Novo PIN (6 dígitos)"
                      value={adminSubPin}
                      onChange={(e) => setAdminSubPin(e.target.value)}
                    />
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="Confirmar PIN (6 dígitos)"
                      value={adminSubPinConfirm}
                      onChange={(e) => setAdminSubPinConfirm(e.target.value)}
                    />
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="PIN admin (4 dígitos)"
                      value={adminSubPinAdminPin}
                      onChange={(e) => setAdminSubPinAdminPin(e.target.value)}
                    />
                    <button
                      onClick={handleAdminAlterarPinSubresp}
                      disabled={adminCredLoading}
                      style={{
                        padding: "6px 10px",
                        border: "1px solid #111",
                        borderRadius: 8,
                        background: "#111",
                        color: "#fff",
                        cursor: adminCredLoading ? "not-allowed" : "pointer",
                        fontWeight: 800,
                      }}
                    >
                      Alterar PIN
                    </button>
                  </div>
                </div>
                {adminResetMsg ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: adminResetMsg.includes("Falha") ? "#b00020" : "#0b7a38" }}>
                    {adminResetMsg}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 12,
              background: "#fafafa",
              marginBottom: 12,
            }}
          >
            <div
              onClick={() => setAdminOpenUsers((v) => !v)}
              style={{ fontWeight: 800, marginBottom: 8, cursor: "pointer" }}
            >
              Gestão de usuários {adminOpenUsers ? "▾" : "▸"}
            </div>
            {adminOpenUsers ? (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                  <input
                    style={{ flex: 1, minWidth: 220, padding: 8 }}
                    placeholder="Buscar por nome ou username"
                    value={adminUsuariosQuery}
                    onChange={(e) => setAdminUsuariosQuery(e.target.value)}
                  />
                  <button
                    onClick={loadAdminUsuarios}
                    disabled={adminUsuariosLoading}
                    style={{
                      padding: "8px 12px",
                      border: "1px solid #111",
                      borderRadius: 8,
                      background: "#111",
                      color: "#fff",
                      cursor: adminUsuariosLoading ? "not-allowed" : "pointer",
                      fontWeight: 800,
                    }}
                  >
                    {adminUsuariosLoading ? "Buscando..." : "Buscar"}
                  </button>
                </div>

                {adminUsuariosErr ? (
                  <div style={{ fontSize: 12, color: "#b00020", marginBottom: 8 }}>{adminUsuariosErr}</div>
                ) : null}

                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Usuários</div>
                    <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid #eee", borderRadius: 8, padding: 8 }}>
                      {adminUsuarios.length === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.7 }}>Sem resultados.</div>
                      ) : (
                        adminUsuarios.map((u) => (
                          <div
                            key={u.id}
                            style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0" }}
                          >
                            <div style={{ fontSize: 12 }}>
                              <div style={{ fontWeight: 700 }}>{u.nome || "—"}</div>
                              <div style={{ opacity: 0.7 }}>
                                {u.username} • {u.role} • {Number(u.ativo) === 1 ? "ativo" : "inativo"}
                              </div>
                            </div>
                            <button
                              onClick={() => handleToggleUsuarioAtivo(u)}
                              disabled={adminUsuariosLoading}
                              style={{
                                padding: "2px 6px",
                                border: "1px solid #111",
                                borderRadius: 6,
                                cursor: adminUsuariosLoading ? "not-allowed" : "pointer",
                              }}
                            >
                              {Number(u.ativo) === 1 ? "Desativar" : "Ativar"}
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Criar usuário</div>
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="Nome completo"
                      value={adminNovoUsuario.nome_completo}
                      onChange={(e) => setAdminNovoUsuario((prev) => ({ ...prev, nome_completo: e.target.value }))}
                    />
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="Username"
                      value={adminNovoUsuario.username}
                      onChange={(e) => setAdminNovoUsuario((prev) => ({ ...prev, username: e.target.value }))}
                    />
                    <select
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      value={adminNovoUsuario.perfil}
                      onChange={(e) => setAdminNovoUsuario((prev) => ({ ...prev, perfil: e.target.value }))}
                    >
                      <option value="ENCARREGADO">Encarregado</option>
                      <option value="SUPERVISOR">Supervisor</option>
                      <option value="ADMIN">Admin</option>
                      <option value="MANUTENCAO">Operador</option>
                    </select>
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="ID subresponsável (opcional)"
                      value={adminNovoUsuario.subresponsavel_id}
                      onChange={(e) => setAdminNovoUsuario((prev) => ({ ...prev, subresponsavel_id: e.target.value }))}
                    />
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="ID encarregado (opcional)"
                      value={adminNovoUsuario.encarregado_id}
                      onChange={(e) => setAdminNovoUsuario((prev) => ({ ...prev, encarregado_id: e.target.value }))}
                    />
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 6 }}>
                      <input
                        type="checkbox"
                        checked={adminNovoUsuario.ativo}
                        onChange={(e) => setAdminNovoUsuario((prev) => ({ ...prev, ativo: e.target.checked }))}
                      />
                      Ativo
                    </label>
                    <button
                      onClick={handleCriarUsuarioAdmin}
                      disabled={adminUsuariosLoading}
                      style={{
                        padding: "6px 10px",
                        border: "1px solid #111",
                        borderRadius: 8,
                        background: "#111",
                        color: "#fff",
                        cursor: adminUsuariosLoading ? "not-allowed" : "pointer",
                        fontWeight: 800,
                      }}
                    >
                      Criar usuário
                    </button>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Criar subresponsável</div>
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="Nome"
                      value={adminNovoSubresp.nome}
                      onChange={(e) => setAdminNovoSubresp((prev) => ({ ...prev, nome: e.target.value }))}
                    />
                    <input
                      style={{ width: "100%", padding: 8, marginBottom: 6 }}
                      placeholder="Seção (opcional)"
                      value={adminNovoSubresp.secao}
                      onChange={(e) => setAdminNovoSubresp((prev) => ({ ...prev, secao: e.target.value }))}
                    />
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 6 }}>
                      <input
                        type="checkbox"
                        checked={adminNovoSubresp.ativo}
                        onChange={(e) => setAdminNovoSubresp((prev) => ({ ...prev, ativo: e.target.checked }))}
                      />
                      Ativo
                    </label>
                    <button
                      onClick={handleCriarSubresponsavelAdmin}
                      disabled={adminUsuariosLoading}
                      style={{
                        padding: "6px 10px",
                        border: "1px solid #111",
                        borderRadius: 8,
                        background: "#111",
                        color: "#fff",
                        cursor: adminUsuariosLoading ? "not-allowed" : "pointer",
                        fontWeight: 800,
                      }}
                    >
                      Criar subresponsável
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>


            {adminOpDetailOpen ? (
              <div
                onClick={() => {
                  if (!adminOpActionLoading) setAdminOpDetailOpen(false);
                }}
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0,0,0,0.5)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 99999,
                  padding: 16,
                }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    width: "min(640px, 94vw)",
                    background: "#fff",
                    color: "#111",
                    borderRadius: 12,
                    padding: 16,
                    boxShadow: "0 20px 60px rgba(0,0,0,.35)",
                  }}
                >
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>
                    Detalhe da pendência
                  </div>
                  {adminOpDetailLoading ? (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Carregando...</div>
                  ) : adminOpDetail ? (
                    <>
                      <div style={{ display: "grid", gap: 6, fontSize: 12, marginBottom: 10 }}>
                        <div>
                          <b>Tipo:</b> {adminOpDetail.tipo || "—"}
                        </div>
                        <div>
                          <b>Status:</b> {adminOpDetail.status || "—"}
                        </div>
                        <div>
                          <b>Solicitante:</b>{" "}
                          {adminOpDetail.solicitante?.nome || "—"} (
                          {adminOpDetail.solicitante?.username || "—"})
                        </div>
                        <div>
                          <b>Criado em:</b> {formatDateTime(adminOpDetail.criado_em)}
                        </div>
                        <div>
                          <b>Kit:</b> {adminOpDetail.contexto?.kit?.nome || "—"}
                        </div>
                        <div>
                          <b>Item:</b>{" "}
                          {adminOpDetail.contexto?.item_original?.patrimonio ||
                            adminOpDetail.contexto?.item_original?.descricao ||
                            "—"}
                        </div>
                      </div>

                      {adminOpDetail.tipo === "SOLICITACAO" ? (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                            Conferência de itens
                          </div>
                          <div style={{ display: "grid", gap: 8 }}>
                            {adminEntregaItens.map((it) => (
                              <div
                                key={it.solicitacao_item_id}
                                style={{
                                  border: "1px solid #eee",
                                  borderRadius: 8,
                                  padding: 8,
                                  display: "grid",
                                  gap: 6,
                                }}
                              >
                                <div style={{ fontSize: 12 }}>
                                  <b>{it.patrimonio}</b> • {it.descricao}
                                </div>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  <select
                                    value={it.status}
                                    onChange={(e) =>
                                      updateAdminEntregaItem(it.solicitacao_item_id, { status: e.target.value })
                                    }
                                    style={{ padding: 6, minWidth: 140 }}
                                  >
                                    <option value="PRESENTE">PRESENTE</option>
                                    <option value="AUSENTE">AUSENTE</option>
                                    <option value="DEFEITO">DEFEITO</option>
                                  </select>

                                  {it.status !== "PRESENTE" ? (
                                    <select
                                      value={it.acao}
                                      onChange={(e) =>
                                        updateAdminEntregaItem(it.solicitacao_item_id, { acao: e.target.value })
                                      }
                                      style={{ padding: 6, minWidth: 180 }}
                                    >
                                      <option value="SUBSTITUICAO">Gerar substituição</option>
                                      <option value="PENDENCIA">Entregar com pendência</option>
                                    </select>
                                  ) : null}
                                </div>

                                {it.status !== "PRESENTE" ? (
                                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                    <input
                                      value={it.motivo}
                                      onChange={(e) =>
                                        updateAdminEntregaItem(it.solicitacao_item_id, { motivo: e.target.value })
                                      }
                                      placeholder="Motivo (ex.: DEFEITO)"
                                      style={{ flex: 1, minWidth: 160, padding: 6 }}
                                    />
                                    <input
                                      value={it.observacao}
                                      onChange={(e) =>
                                        updateAdminEntregaItem(it.solicitacao_item_id, { observacao: e.target.value })
                                      }
                                      placeholder="Observação"
                                      style={{ flex: 1, minWidth: 160, padding: 6 }}
                                    />
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>

                          <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
                            <input
                              value={adminEntregaPinAdmin}
                              onChange={(e) => setAdminEntregaPinAdmin(e.target.value)}
                              placeholder="PIN admin (4 dígitos)"
                              style={{ padding: 8 }}
                            />
                          </div>
                        </div>
                      ) : null}

                      {adminOpDetail.tipo === "DEVOLUCAO" ? (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                            Conferência de devolução
                          </div>
                          <div style={{ display: "grid", gap: 8 }}>
                            {adminDevolucaoItens.map((it) => (
                              <div
                                key={it.item_id}
                                style={{
                                  border: "1px solid #eee",
                                  borderRadius: 8,
                                  padding: 8,
                                  display: "grid",
                                  gap: 6,
                                }}
                              >
                                <div style={{ fontSize: 12 }}>
                                  <b>{it.patrimonio}</b> • {it.descricao}
                                </div>
                                <select
                                  value={it.status}
                                  onChange={(e) =>
                                    updateAdminDevolucaoItem(it.item_id, { status: e.target.value })
                                  }
                                  style={{ padding: 6, minWidth: 140 }}
                                >
                                  <option value="PRESENTE">PRESENTE</option>
                                  <option value="AUSENTE">AUSENTE</option>
                                </select>

                                {it.status === "AUSENTE" ? (
                                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                    <select
                                      value={it.motivo}
                                      onChange={(e) =>
                                        updateAdminDevolucaoItem(it.item_id, { motivo: e.target.value })
                                      }
                                      style={{ padding: 6, minWidth: 160 }}
                                    >
                                      <option value="">Motivo</option>
                                      <option value="PERDA">PERDA</option>
                                      <option value="FURTO">FURTO</option>
                                    </select>
                                    <input
                                      value={it.anexo_path}
                                      onChange={(e) =>
                                        updateAdminDevolucaoItem(it.item_id, { anexo_path: e.target.value })
                                      }
                                      placeholder="Caminho do BO/termo"
                                      style={{ flex: 1, minWidth: 180, padding: 6 }}
                                    />
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                          <input
                            value={adminDevolucaoPinAdmin}
                            onChange={(e) => setAdminDevolucaoPinAdmin(e.target.value)}
                            placeholder="PIN admin (4 dígitos)"
                            style={{ padding: 8, marginTop: 10, width: "100%" }}
                          />
                        </div>
                      ) : null}

                      {adminOpDetail.tipo === "SUBSTITUICAO" ? (
                        <div style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 12, opacity: 0.8 }}>
                            Substituto equivalente ({adminDescricaoCanonica || "sem descricao"})
                          </label>
                          {adminSubstBloqueada ? (
                            <div style={{ fontSize: 12, color: "#b00020", marginTop: 6 }}>
                              Item sem classe_tipo — substituição bloqueada.
                            </div>
                          ) : null}
                          {adminSubstitutosDisponiveis.length ? (
                            <select
                              style={{ width: "100%", padding: 10, marginTop: 4 }}
                              value={adminSubstitutoId}
                              onChange={(e) => setAdminSubstitutoId(e.target.value)}
                            >
                              <option value="">Selecione o substituto</option>
                              {adminSubstitutosDisponiveis.map((it) => (
                                <option key={it.id} value={it.id}>
                                  {it.patrimonio} - {it.descricao}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              style={{ width: "100%", padding: 10, marginTop: 4 }}
                              value={adminSubstitutoId}
                              onChange={(e) => setAdminSubstitutoId(e.target.value)}
                              placeholder={adminSubstitutosLoading ? "Carregando substitutos..." : "Ex: 777"}
                              disabled={adminSubstitutosLoading}
                            />
                          )}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: "#b00020" }}>
                      Não foi possível carregar o detalhe.
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
                    <button
                      onClick={() => setAdminOpDetailOpen(false)}
                      disabled={adminOpActionLoading}
                      style={{
                        padding: "8px 12px",
                        borderRadius: 8,
                        border: "1px solid #aaa",
                        cursor: adminOpActionLoading ? "not-allowed" : "pointer",
                      }}
                    >
                      Fechar
                    </button>

                    {adminOpDetail?.tipo === "SOLICITACAO" ? (
                      <button
                        onClick={confirmarEntregaAdmin}
                        disabled={adminOpActionLoading}
                        style={{
                          padding: "8px 12px",
                          borderRadius: 8,
                          border: "1px solid #111",
                          background: "#111",
                          color: "#fff",
                          cursor: adminOpActionLoading ? "not-allowed" : "pointer",
                          fontWeight: 800,
                        }}
                      >
                        {adminOpActionLoading ? "Processando..." : "Concluir entrega"}
                      </button>
                    ) : null}

                    {adminOpDetail?.tipo === "SUBSTITUICAO" ? (
                      <button
                        onClick={aprovarSubstituicaoAdmin}
                        disabled={
                          adminOpActionLoading ||
                          adminSubstBloqueada ||
                          !adminSubstitutoId
                        }
                        style={{
                          padding: "8px 12px",
                          borderRadius: 8,
                          border: "1px solid #111",
                          background: "#111",
                          color: "#fff",
                          cursor: adminOpActionLoading ? "not-allowed" : "pointer",
                          fontWeight: 800,
                        }}
                      >
                        {adminOpActionLoading ? "Processando..." : "Aprovar substituição"}
                      </button>
                    ) : null}

                    {adminOpDetail?.tipo === "DEVOLUCAO" ? (
                      <button
                        onClick={confirmarDevolucaoDetalhada}
                        disabled={adminOpActionLoading}
                        style={{
                          padding: "8px 12px",
                          borderRadius: 8,
                          border: "1px solid #111",
                          background: "#111",
                          color: "#fff",
                          cursor: adminOpActionLoading ? "not-allowed" : "pointer",
                          fontWeight: 800,
                        }}
                      >
                        {adminOpActionLoading ? "Processando..." : "Confirmar devolução"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {adminTermoOpen ? (
              <div
                onClick={() => setAdminTermoOpen(false)}
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0,0,0,0.5)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 99999,
                  padding: 16,
                }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    width: "min(720px, 96vw)",
                    background: "#fff",
                    color: "#111",
                    borderRadius: 12,
                    padding: 16,
                    boxShadow: "0 20px 60px rgba(0,0,0,.35)",
                  }}
                >
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Termo vinculado</div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                    {adminTermoMeta?.tipo || "—"} • {adminTermoMeta?.assinante || "—"} •{" "}
                    {formatDateTime(adminTermoMeta?.criado_em)}
                  </div>
                  <textarea
                    readOnly
                    value={adminTermoTexto || "—"}
                    style={{ width: "100%", minHeight: 200, padding: 10, fontSize: 12 }}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                    <button
                      onClick={() => setAdminTermoOpen(false)}
                      style={{
                        padding: "8px 12px",
                        borderRadius: 8,
                        border: "1px solid #111",
                        background: "#111",
                        color: "#fff",
                        cursor: "pointer",
                        fontWeight: 800,
                      }}
                    >
                      Fechar
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
        </div>
      )}

      {isOperador && (
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, marginBottom: 12, background: "#fafafa" }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Area do Operador</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Cadastro e gestao de kits e ferramentas.</div>
        </div>
      )}
      {isUsuario && (
        <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          onClick={() => setModo("eletrico")}
          disabled={!canEletrico}
          style={{
            padding: "6px 10px",
            border: modo === "eletrico" ? "2px solid #111" : "1px solid #ccc",
            borderRadius: 8,
            fontWeight: modo === "eletrico" ? 800 : 600,
            cursor: "pointer",
          }}
        >
          Eletricos
        </button>
        <button
          onClick={() => setModo("manual")}
          style={{
            padding: "6px 10px",
            border: modo === "manual" ? "2px solid #111" : "1px solid #ccc",
            borderRadius: 8,
            fontWeight: modo === "manual" ? 800 : 600,
            cursor: "pointer",
          }}
        >
          Manuais
        </button>
      </div>

      {modo === "manual" ? (
        <div style={{ marginBottom: 12 }}>
      {manualErr ? (
        <div style={{ background: "#ffe8e8", border: "1px solid #ffb3b3", padding: 10, marginBottom: 12 }}>
          <b>Erro:</b> {manualErr}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ minWidth: 320 }}>
          <label style={{ fontSize: 12, opacity: 0.85 }}>Busca item manual</label>
          <input
            style={{ width: "100%", padding: 10 }}
            placeholder="Ex: chave combinada, carrinho..."
            value={manualQuery}
            onChange={(e) => setManualQuery(e.target.value)}
          />
        </div>
      </div>

      <div
        style={{
          border: "1px solid rgba(255,255,255,0.25)",
          borderRadius: 14,
          overflow: "hidden",
          background: "rgba(0,0,0,0.28)",
        }}
      >
        <div style={{ padding: 12, fontWeight: 700, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          Meus avulsos
        </div>
        <div style={{ maxHeight: 520, overflow: "auto", padding: 12 }}>
          {manualLoading ? (
            <div style={{ fontSize: 12, opacity: 0.75 }}>Carregando...</div>
          ) : manualItens.length === 0 ? (
            <div style={{ fontSize: 12, opacity: 0.75 }}>Sem avulsos em posse.</div>
          ) : (
            manualItens.map((it) => (
              <div
                key={it.id}
                style={{
                  padding: 10,
                  borderTop: it.id ? "1px solid rgba(255,255,255,0.08)" : "none",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ fontWeight: 700 }}>{it.nome}</div>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    {it.status || "Presente sob sua responsabilidade"}
                  </div>
                </div>
                <button
                  onClick={() => openManualTermo(it)}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #111",
                    borderRadius: 8,
                    background: "#111",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  Retirar
                </button>
              </div>
            ))
          )}
        </div>
      </div>

          {manualTermoOpen && manualSel ? (
            <div
              onClick={() => {
                if (!manualTermoSubmitting) setManualTermoOpen(false);
              }}
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 99999,
                padding: 16,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: "min(720px, 96vw)",
                  background: "#fff",
                  color: "#111",
                  borderRadius: 12,
                  padding: 16,
                  boxShadow: "0 20px 60px rgba(0,0,0,.35)",
                }}
              >
                <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Termo de Responsabilidade</div>
                <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 10 }}>
                  Retirada de item manual exige assinatura.
                </div>

                <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                  <div style={{ fontSize: 12 }}>
                    <b>Item:</b> {manualSel.nome}
                  </div>
                </div>

                <label style={{ fontSize: 12, opacity: 0.85 }}>Quantidade</label>
                <input
                  style={{ width: 120, padding: 8, marginTop: 4, marginBottom: 8 }}
                  type="number"
                  min="1"
                  value={manualQty}
                  onChange={(e) => setManualQty(e.target.value)}
                />

                <label style={{ fontSize: 12, opacity: 0.85 }}>Assinatura (nome completo)</label>
                <input
                  style={{ width: "100%", padding: 10, marginTop: 4, marginBottom: 8 }}
                  value={manualAssinatura}
                  onChange={(e) => setManualAssinatura(e.target.value)}
                  placeholder="Ex: NOME COMPLETO"
                />

                <label style={{ fontSize: 12, opacity: 0.85 }}>Texto do termo</label>
                <textarea
                  readOnly
                  value={buildManualTermoTexto(manualSel.nome)}
                  style={{ width: "100%", minHeight: 140, padding: 10, marginTop: 4, fontSize: 12 }}
                />

                {manualTermoMsg ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: "#b00020" }}>{manualTermoMsg}</div>
                ) : null}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
                  <button
                    onClick={() => setManualTermoOpen(false)}
                    disabled={manualTermoSubmitting}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "1px solid #aaa",
                      cursor: manualTermoSubmitting ? "not-allowed" : "pointer",
                    }}
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={submitManualTermo}
                    disabled={manualTermoSubmitting}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "1px solid #111",
                      background: "#111",
                      color: "#fff",
                      cursor: manualTermoSubmitting ? "not-allowed" : "pointer",
                      fontWeight: 800,
                    }}
                  >
                    {manualTermoSubmitting ? "Salvando termo..." : "Assinar e retirar"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {err ? (
        <div style={{ background: "#ffe8e8", border: "1px solid #ffb3b3", padding: 10, marginBottom: 12 }}>
          <b>Erro:</b> {err}{" "}
          <button
            onClick={loadMasters}
            style={{
              marginLeft: 10,
              padding: "6px 10px",
              border: "1px solid #111",
              cursor: "pointer",
              borderRadius: 8,
            }}
          >
            Recarregar
          </button>
        </div>
      ) : null}

      {lastSubmit ? (
        <div style={{ background: "#e9fff0", border: "1px solid #a7f3c0", padding: 10, marginBottom: 12 }}>
          {lastSubmit}
        </div>
      ) : null}

      {checklistTermoOpen ? (
        <div
          onClick={() => {
            if (!checklistTermoSubmitting) setChecklistTermoOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 99999,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 96vw)",
              background: "#fff",
              color: "#111",
              borderRadius: 12,
              padding: 16,
              boxShadow: "0 20px 60px rgba(0,0,0,.35)",
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Termo de Responsabilidade</div>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 10 }}>
              Envio de checklist eletrico exige assinatura.
            </div>

            <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
              <div style={{ fontSize: 12 }}>
                <b>Kit:</b> {kitLabel || selectedKitId}
              </div>
            </div>

            <label style={{ fontSize: 12, opacity: 0.85 }}>Assinatura (nome completo)</label>
            <input
              style={{ width: "100%", padding: 10, marginTop: 4, marginBottom: 8 }}
              value={checklistAssinatura}
              onChange={(e) => setChecklistAssinatura(e.target.value)}
              placeholder="Ex: NOME COMPLETO"
            />

            <label style={{ fontSize: 12, opacity: 0.85 }}>Texto do termo</label>
            <textarea
              readOnly
              value={buildChecklistTermoTexto()}
              style={{ width: "100%", minHeight: 140, padding: 10, marginTop: 4, fontSize: 12 }}
            />

            {checklistTermoMsg ? (
              <div style={{ marginTop: 8, fontSize: 12, color: "#b00020" }}>{checklistTermoMsg}</div>
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
              <button
                onClick={() => setChecklistTermoOpen(false)}
                disabled={checklistTermoSubmitting}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #aaa",
                  cursor: checklistTermoSubmitting ? "not-allowed" : "pointer",
                }}
              >
                Cancelar
              </button>
              <button
                onClick={submitChecklistTermo}
                disabled={checklistTermoSubmitting}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                  cursor: checklistTermoSubmitting ? "not-allowed" : "pointer",
                  fontWeight: 800,
                }}
              >
                {checklistTermoSubmitting ? "Salvando termo..." : "Assinar e enviar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}


      <div style={{ display: modo === "eletrico" ? "block" : "none" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            marginTop: 12,
          }}
        >
          <div>
            <SolicitacoesCard
              items={filtered}
              statusMap={statusMap}
              selectedKitId={selectedKitId}
              statusOverview={statusOverview}
              statusOverviewErr={statusOverviewErr}
            />
          </div>
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "stretch",
              height: 520,
            }}
          >
            <div
              style={{
                flex: "1 1 320px",
                minWidth: 320,
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 14,
                padding: 16,
                background: "rgba(0,0,0,0.28)",
                display: "flex",
                flexDirection: "column",
                gap: 12,
                overflow: "hidden",
                minHeight: 0,
              }}
            >
              <div style={{ fontWeight: 700 }}>Meus cautelados</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setTabMeus("kits")}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 10,
                    border: tabMeus === "kits" ? "1px solid #111" : "1px solid rgba(255,255,255,0.4)",
                    background: tabMeus === "kits" ? "#111" : "transparent",
                    color: tabMeus === "kits" ? "#fff" : "#f0f0f0",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  Kits
                </button>
                <button
                  onClick={() => setTabMeus("avulsos")}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 10,
                    border: tabMeus === "avulsos" ? "1px solid #111" : "1px solid rgba(255,255,255,0.4)",
                    background: tabMeus === "avulsos" ? "#111" : "transparent",
                    color: tabMeus === "avulsos" ? "#fff" : "#f0f0f0",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  Avulsos
                </button>
              </div>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  maxHeight: 320,
                  overflowY: "auto",
                  scrollbarGutter: "stable",
                  borderTop: "1px solid rgba(255,255,255,0.08)",
                  paddingTop: 12,
                  paddingRight: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {tabMeus === "kits" ? (
                  meusKits.length ? (
                    meusKits.map((kit, idx) => {
                      const kitPosseSelecionada = isKitPosseSelecionada(kit);
                      return (
                        <div
                          key={kit.id}
                          onClick={() => setPosseSelecionada({ tipo: "kit", data: kit })}
                          style={{
                            padding: "10px 12px",
                            borderTop: idx === 0 ? "none" : "1px solid rgba(255,255,255,0.08)",
                            borderRadius: 10,
                            background: kitPosseSelecionada ? "rgba(255,255,255,0.08)" : "transparent",
                            cursor: "pointer",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                            }}
                          >
                            <div>
                              <div style={{ fontWeight: 800 }}>{kit.nome}</div>
                              <div style={{ fontSize: 12, opacity: 0.7, display: "flex", alignItems: "center", gap: 6 }}>
                                {formatKitLabel(kit)}
                                {pendingDevolucaoKits.has(String(kit.id)) ? (
                                  <span
                                    style={{
                                      display: "inline-block",
                                      marginTop: 6,
                                      padding: "3px 8px",
                                      borderRadius: 999,
                                      fontSize: 12,
                                      fontWeight: 800,
                                      background: "rgba(255, 207, 51, 0.14)",
                                      border: "1px solid rgba(255, 207, 51, 0.35)",
                                      color: "#ffcf33",
                                    }}
                                  >
                                    Devolução solicitada
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPosseSelecionada({ tipo: "kit", data: kit });
                              }}
                              style={{
                                padding: "6px 10px",
                                borderRadius: 8,
                                border: "1px solid #111",
                                background: "#111",
                                color: "#fff",
                                fontWeight: 800,
                                cursor: "pointer",
                              }}
                            >
                              Detalhes
                            </button>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Sem kits em posse.</div>
                  )
                ) : meusAvulsosReais.length ? (
                  <>
                    <div style={{ fontSize: 12, opacity: 0.65 }}>
                      Meus avulsos em posse (reais).
                    </div>
                    {meusAvulsosReais.map((avulso, idx) => {
                      const avulsoPosseSelecionada = isAvulsoPosseSelecionada(avulso);
                      return (
                        <div
                          key={avulso.id ?? `${avulso.patrimonio}-${idx}`}
                          onClick={() => setPosseSelecionada({ tipo: "avulso", data: avulso })}
                          style={{
                            padding: "10px 12px",
                            borderTop: idx === 0 ? "none" : "1px solid rgba(255,255,255,0.08)",
                            borderRadius: 10,
                            background: avulsoPosseSelecionada ? "rgba(255,255,255,0.08)" : "transparent",
                            cursor: "pointer",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                            }}
                          >
                            <div>
                              <div style={{ fontWeight: 800 }}>{avulso.nome || avulso.patrimonio}</div>
                              <div style={{ fontSize: 12, opacity: 0.75, display: "flex", alignItems: "center", gap: 6 }}>
                                {avulso.status || "Presente sob sua responsabilidade"}
                                {pendingDevolucaoAvulsos.has(String(avulso.id)) ? (
                                  <span
                                    style={{
                                      display: "inline-block",
                                      marginTop: 6,
                                      padding: "3px 8px",
                                      borderRadius: 999,
                                      fontSize: 12,
                                      fontWeight: 800,
                                      background: "rgba(255, 207, 51, 0.14)",
                                      border: "1px solid rgba(255, 207, 51, 0.35)",
                                      color: "#ffcf33",
                                    }}
                                  >
                                    Devolução solicitada
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPosseSelecionada({ tipo: "avulso", data: avulso });
                              }}
                              style={{
                                padding: "6px 10px",
                                borderRadius: 8,
                                border: "1px solid #111",
                                background: "#111",
                                color: "#fff",
                                fontWeight: 800,
                                cursor: "pointer",
                              }}
                            >
                              Detalhes
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <div style={{ fontSize: 12, opacity: 0.7 }}>Sem avulsos em posse.</div>
                )}
              </div>
            </div>
            <div
              style={{
                flex: "1 1 320px",
                minWidth: 320,
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 14,
                padding: 16,
                background: "rgba(0,0,0,0.28)",
                display: "flex",
                flexDirection: "column",
                gap: 12,
                overflow: "hidden",
                minHeight: 0,
              }}
            >
              <div style={{ fontWeight: 700 }}>Detalhes</div>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: "auto",
                  scrollbarGutter: "stable",
                }}
              >
                {!posseSelecionada ? (
                  <div style={{ padding: 10, fontSize: 12, opacity: 0.7 }}>
                    Selecione um item em "Meus cautelados"...
                  </div>
                ) : posseSelecionada?.tipo === "kit" ? (
                  <DetalhesKitCard
                    items={posseKitItens}
                    statusMap={posseStatusMap}
                    geo={geo}
                    selectedKitId={String(posseSelecionada.data.id)}
                    kitLabel={posseSelecionada.data.nome}
                    selectedEncarregadoId={selectedEncarregadoId}
                    onSolicitarSubstituicao={handleSolicitarSubstituicao}
                    onReagrupar={handleReagruparItem}
                    onPickSubresponsavel={handleSubresponsavelPickPosse}
                    onConfirmDistribuicao={handleDistribConfirmadoPosse}
                    onSolicitarDevolucao={() => solicitarDevolucaoKit(posseSelecionada.data.id)}
                    onDistribuir={markDistribuindoPosse}
                    pendingDevolucaoKits={pendingDevolucaoKits}
                    pendingSubstituicoes={pendingSubstituicoes}
                  />
                ) : (
                  <CardShell title="Detalhes do avulso">
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontWeight: 800 }}>
                        {posseSelecionada.data?.descricao || posseSelecionada.data?.nome || "Avulso selecionado"}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        {posseSelecionada.data?.patrimonio}
                      </div>
                        <button
                          type="button"
                          onClick={() =>
                            solicitarDevolucaoAvulso(
                              posseSelecionada.data?.item_id ?? posseSelecionada.data?.id
                            )
                          }
                          disabled={pendingDevolucaoAvulsos.has(
                            String(posseSelecionada.data?.item_id ?? posseSelecionada.data?.id)
                          )}
                          style={{
                            marginTop: 12,
                            padding: "8px 12px",
                            borderRadius: 10,
                            border: "1px solid #b00020",
                            background: "#b00020",
                            color: "#fff",
                            fontWeight: 900,
                            cursor: pendingDevolucaoAvulsos.has(
                              String(posseSelecionada.data?.item_id ?? posseSelecionada.data?.id)
                            )
                              ? "not-allowed"
                              : "pointer",
                            opacity: pendingDevolucaoAvulsos.has(
                              String(posseSelecionada.data?.item_id ?? posseSelecionada.data?.id)
                            )
                              ? 0.6
                              : 1,
                          }}
                        >
                          {pendingDevolucaoAvulsos.has(
                            String(posseSelecionada.data?.item_id ?? posseSelecionada.data?.id)
                          )
                            ? "Devolução pendente"
                            : "Solicitar devolução"}
                        </button>
                    </div>
                  </CardShell>
                )}
              </div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 320 }}>
              <label style={{ fontSize: 12, opacity: 0.85 }}>Kit</label>
              <select
                style={{ width: "100%", padding: 10 }}
                value={selectedKitId}
                onChange={(e) => setSelectedKitId(e.target.value)}
              >
                <option value="">Selecione…</option>
                {kitsDisponiveisFiltrados.map((k) => (
                  <option key={k.id} value={k.id}>
                    #{k.id} • {k.nome}
                  </option>
                ))}
              </select>
              {selectedKitId ? <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{kitLabel}</div> : null}
            </div>
            <div style={{ flex: 1, minWidth: 280 }}>
              <label style={{ fontSize: 12, opacity: 0.85 }}>Avulso disponível</label>
              <select
                style={{ width: "100%", padding: 10 }}
                value={selectedAvulsoId}
                onChange={(e) => handleAvulsoSelectChange(e.target.value)}
              >
                <option value="">Selecione...</option>
                {avulsosDisponiveisFiltrados.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.patrimonio || a.codigo || a.id} - {a.descricao || a.nome || "Avulso"}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div
            style={{
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 14,
              padding: 16,
              background: "rgba(0,0,0,0.28)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ fontWeight: 700 }}>Detalhes (preview)</div>
            {!previewSelecionado ? (
              <div style={{ padding: 10, fontSize: 12, opacity: 0.7 }}>
                Selecione nos superselects (disponíveis) para solicitar com termo.
              </div>
            ) : previewSelecionado.tipo === "kit" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontWeight: 800 }}>{previewSelecionado.data?.nome || "Kit selecionado"}</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{formatKitLabel(previewSelecionado.data)}</div>
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 10,
                    padding: 10,
                    maxHeight: 180,
                    overflowY: "auto",
                    fontSize: 12,
                    background: "rgba(0,0,0,0.2)",
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>Itens do kit</div>
                  {kitItens.length === 0 ? (
                    <div style={{ opacity: 0.7 }}>Sem itens carregados para este kit.</div>
                  ) : (
                    kitItens.map((it, idx) => (
                      <div key={it.kit_item_id ?? `${it.patrimonio}-${idx}`} style={{ padding: "2px 0" }}>
                        <span style={{ fontWeight: 600 }}>{it.patrimonio || "—"}</span>
                        {" — "}
                        <span>{it.descricao || "Item"}</span>
                      </div>
                    ))
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (disableSolicitarTermo) return;
                    openChecklistTermo();
                  }}
                  disabled={disableSolicitarTermo}
                  style={{
                    alignSelf: "flex-start",
                    padding: "8px 12px",
                    borderRadius: 10,
                    border: "1px solid #111",
                    background: disableSolicitarTermo ? "#777" : "#111",
                    color: "#fff",
                    cursor: disableSolicitarTermo ? "not-allowed" : "pointer",
                    fontWeight: 700,
                    opacity: disableSolicitarTermo ? 0.75 : 1,
                  }}
                  title={disableSolicitarTermo ? "Kit já está em transição (solicitação pendente)." : ""}
                >
                  Solicitar kit (com termo)
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontWeight: 800 }}>
                  {previewSelecionado.data?.descricao || previewSelecionado.data?.patrimonio || "Avulso selecionado"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  {previewSelecionado.data?.status || "Selecione um avulso disponível"}
                </div>
                    <button
                      type="button"
                      onClick={handleSolicitarAvulsoComTermo}
                      style={{
                        alignSelf: "flex-start",
                        padding: "8px 12px",
                        borderRadius: 10,
                        border: "1px solid #111",
                        background: "#111",
                        color: "#fff",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      Solicitar avulso (com termo)
                    </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {substModalItem && (
        <div
          onClick={() => {
            if (!substSubmitting) {
              setSubstModalItem(null);
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 99999,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(520px, 96vw)",
              background: "#111",
              color: "#f2f2f2",
              borderRadius: 14,
              padding: 20,
              boxShadow: "0 20px 60px rgba(0,0,0,.45)",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
              Motivo da substituição
            </div>
            <div style={{ fontSize: 13, marginBottom: 16, opacity: 0.85 }}>
              Escolha o motivo padrão para a solicitação, o admin vai validar o PIN depois.
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <button
                onClick={() => submitSolicitacaoSubstituicao("MANUTENCAO")}
                disabled={substSubmitting}
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #0b7a38",
                  background: "#0b7a38",
                  color: "#fff",
                  fontWeight: 700,
                  cursor: substSubmitting ? "not-allowed" : "pointer",
                }}
              >
                Manutenção
              </button>
              <button
                onClick={() => submitSolicitacaoSubstituicao("FURTO")}
                disabled={substSubmitting}
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #b71c1c",
                  background: "#b71c1c",
                  color: "#fff",
                  fontWeight: 700,
                  cursor: substSubmitting ? "not-allowed" : "pointer",
                }}
              >
                Furto
              </button>
            </div>
            <label style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>Observação opcional</label>
            <textarea
              value={substObservacao}
              onChange={(e) => setSubstObservacao(e.target.value)}
              rows={3}
              placeholder="Detalhes extras (opcional)..."
              style={{
                width: "100%",
                padding: 10,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "#0f0f0f",
                color: "#fff",
                resize: "vertical",
                marginBottom: 12,
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                onClick={() => setSubstModalItem(null)}
                disabled={substSubmitting}
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: "1px solid #aaa",
                  background: "#222",
                  color: "#fff",
                  cursor: substSubmitting ? "not-allowed" : "pointer",
                }}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )}
    </div>
  );
}
