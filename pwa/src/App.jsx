// pwa/src/App.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  apiGet,
  apiPost,
  searchSubresponsaveis,
  distribuir as apiDistribuir,
  recolher as apiRecolher,
  criarTermo,
  termosMinha,
  login,
  definirSenha,
  listarManuais,
  entregarManual,
  adminPessoas,
  adminBusca,
  adminManualPosse,
  adminTrilhaKit,
  adminTrilhaPatrimonio,
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

function safeArray(res) {
  // Backend pode retornar [] puro ou {value: []}
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.value)) return res.value;
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      await doDistribuir();
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

      await doDistribuir();
    } catch (e) {
      const t = e?.message ?? String(e);
      setTermoMsg(t.includes("detail") ? t : t);
    } finally {
      setTermoSubmitting(false);
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
    </div>
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
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newPassErr, setNewPassErr] = useState("");
  const [newPassLoading, setNewPassLoading] = useState(false);




  /**
   * Dados mestres
   */
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [setores, setSetores] = useState([]);
  const [encarregados, setEncarregados] = useState([]);
  const [kits, setKits] = useState([]);

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

  // Admin panel state
  const [adminQuery, setAdminQuery] = useState("");
  const [adminSetorId, setAdminSetorId] = useState("");
  const [adminPessoaTipo, setAdminPessoaTipo] = useState("");
  const [adminPessoaId, setAdminPessoaId] = useState("");
  const [adminPessoas, setAdminPessoas] = useState([]);
  const [adminResults, setAdminResults] = useState(null);
  const [adminManualPosseRows, setAdminManualPosseRows] = useState([]);
  const [adminTrail, setAdminTrail] = useState(null);
  const [adminTrailTitle, setAdminTrailTitle] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminErr, setAdminErr] = useState("");

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

  /**
   * statusMap[kit_item_id] = {
   *   status: "PRESENTE" | "DISTRIBUIDO" | null,
   *   subresponsavel_text: string,
   *   subresponsavel_id: number|null,
   *   distribuicao_confirmada: boolean
   * }
   */
  const [statusMap, setStatusMap] = useState({});

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

  useEffect(() => {
    if (!authToken) {
      setCurrentUser(null);
      setCurrentUserErr("");
      setCurrentUserLoading(false);
      setSelectedEncarregadoId("");
      return;
    }

    setCurrentUserLoading(true);
    setCurrentUserErr("");
    apiGet("/auth/me")
      .then((res) => {
        setCurrentUser(res);
        setMustChangePassword(Boolean(res?.must_change_password));
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
    const encId = currentUser?.encarregado_id;
    if (encId) {
      setSelectedEncarregadoId(String(encId));
    } else {
      setSelectedEncarregadoId("");
    }
  }, [currentUser]);

  useEffect(() => {
    if (currentUser?.role === "admin") {
      loadAdminPeople();
    }
  }, [currentUser]);

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
      const [setoresRes, encRes, kitsRes] = await Promise.all([
        withRetry(() => apiGet("/setores/"), 2, 300),
        withRetry(() => apiGet("/encarregados/"), 2, 300),
        withRetry(() => apiGet("/kits/"), 2, 300),
      ]);

      setSetores(safeArray(setoresRes));
      setEncarregados(safeArray(encRes));
      setKits(safeArray(kitsRes));
    } catch (e) {
      console.error("loadMasters error:", e);
      setErr(e?.message ?? "Falha ao buscar (rede instável). Tente recarregar.");
      // NÃO zera estados aqui; mantém o que tiver (se tiver)
    } finally {
      setLoading(false);
    }
  }

  async function loadAdminPeople() {
    try {
      const res = await adminPessoas("");
      const encs = safeArray(res?.encarregados);
      const subs = safeArray(res?.subresponsaveis);
      const merged = [
        ...encs.map((p) => ({ ...p, tipo: "encarregado" })),
        ...subs.map((p) => ({ ...p, tipo: "subresponsavel" })),
      ];
      setAdminPessoas(merged);
    } catch {
      setAdminPessoas([]);
    }
  }

  async function runAdminBusca() {
    setAdminLoading(true);
    setAdminErr("");
    setAdminTrail(null);
    setAdminTrailTitle("");
    try {
      const res = await adminBusca({
        query: adminQuery.trim(),
        setorId: adminSetorId,
      });
      setAdminResults(res);

      const posseRes = await adminManualPosse({
        query: adminQuery.trim(),
        setorId: adminSetorId,
        pessoaTipo: adminPessoaTipo,
        pessoaId: adminPessoaId,
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
      if (!tok) {
        setAuthErr("Token nao retornado pelo login.");
        return;
      }
      localStorage.setItem("access_token", tok);
      setAuthToken(tok);
      setMustChangePassword(mustChange);
      if (mustChange) {
        setAuthNotice("Senha temporaria detectada. Defina sua senha para continuar.");
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

        // inicializa statusMap por kit_item_id
        const next = {};
        for (const it of list) {
          next[it.kit_item_id] = {
            status: null,
            subresponsavel_text: "",
            subresponsavel_id: null,
            distribuicao_confirmada: false,
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
  }, [selectedKitId]);

  /**
   * =========================================================
   * Label do kit
   * =========================================================
   */
  const kitLabel = useMemo(() => {
    const k = kits.find((x) => String(x.id) === String(selectedKitId));
    if (!k) return "";
    const setor = setores.find((s) => s.id === k.setor_id)?.nome ?? `Setor ${k.setor_id}`;
    return `${k.nome} • ${setor} • ${k.tipo ?? ""}`.trim();
  }, [kits, setores, selectedKitId]);

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

    return { total, presente, distribuido, pendente };
  }, [kitItens, statusMap]);

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
        },
      };
    });
  }

  function markAllAsPresente() {
    setStatusMap((prev) => {
      const next = { ...prev };
      for (const ki of kitItens) {
        const cur = next[ki.kit_item_id] ?? {};
        next[ki.kit_item_id] = {
          ...cur,
          status: "PRESENTE",
          subresponsavel_text: "",
          subresponsavel_id: null,
          distribuicao_confirmada: false,
        };
      }
      return next;
    });
  }

  /**
   * =========================================================
   * Confirm callback (quando distribuir via PIN dá certo)
   * =========================================================
   */
  function markDistribConfirmado(kitItemId) {
    setStatusMap((prev) => {
      const cur = prev[kitItemId];
      if (!cur) return prev;
      return {
        ...prev,
        [kitItemId]: {
          ...cur,
          distribuicao_confirmada: true,
        },
      };
    });
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

      await criarTermo(termoPayload);
      setChecklistTermoOpen(false);
      await submitChecklist();
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
   * UI
   * =========================================================
   */
  const role = currentUser?.role ?? "";
  const isAdmin = role === "admin";
  const isOperador = role === "manutencao";
  const hasProfile = Boolean(currentUser);
  const isUsuario = hasProfile && !isAdmin && !isOperador;

  const roleCopy = !hasProfile
    ? ""
    : isAdmin
      ? "Painel Administrativo ? visao global de kits, itens, termos, checklists e movimentos."
      : isOperador
        ? "Operador ? cadastro e gestao de kits e ferramentas."
        : "Operacao ? retirada, termo de responsabilidade e registro de custodia.";

  const adminKits = safeArray(adminResults?.kits);
  const adminItens = safeArray(adminResults?.itens);
  const adminPessoasRes = safeArray(adminResults?.pessoas);
  const adminManuaisRes = safeArray(adminResults?.manuais);

  const gpsLabel = isGpsValid(geo) ? "GPS ok" : geo.ok ? "GPS inválido" : "GPS indisponível";

  const canEletrico = Boolean(currentUser?.encarregado_id);

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
    <div style={{ padding: 16, fontFamily: "system-ui", maxWidth: 1200, margin: "0 auto" }}>
      <h2 style={{ marginBottom: 6 }}>Checklist Semanal • Ferramental</h2>

      <div style={{ opacity: 0.8, marginBottom: 12, fontSize: 13 }}>
        API: <code>{apiBase}</code> • {gpsLabel} • {nowISO()}
      </div>

      <div
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
        <div>
          <div style={{ fontWeight: 800 }}>
            {hasProfile ? (isAdmin ? "Admin" : isOperador ? "Operador" : "Usuario") : "Carregando"}
          </div>
          {roleCopy ? <div style={{ fontSize: 12, opacity: 0.8 }}>{roleCopy}</div> : null}
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
      </div>



      

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
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Painel Admin - Busca Global</div>

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

              <select
                style={{ padding: 10, minWidth: 220 }}
                value={adminPessoaTipo && adminPessoaId ? `${adminPessoaTipo}:${adminPessoaId}` : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) {
                    setAdminPessoaTipo("");
                    setAdminPessoaId("");
                    return;
                  }
                  const [t, id] = v.split(":");
                  setAdminPessoaTipo(t);
                  setAdminPessoaId(id);
                }}
              >
                <option value="">Todas as pessoas</option>
                {adminPessoas.map((p) => (
                  <option key={`${p.tipo}-${p.id}`} value={`${p.tipo}:${p.id}`}>
                    {p.nome} ({p.tipo})
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
          </div>

          {adminErr ? (
            <div style={{ background: "#ffe8e8", border: "1px solid #ffb3b3", padding: 10, marginBottom: 12 }}>
              <b>Erro:</b> {adminErr}
            </div>
          ) : null}

          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 10 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Kits</div>
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

            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 10 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Itens (patrimonio)</div>
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

            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 10 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Pessoas</div>
              {adminPessoasRes.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.7 }}>Sem resultados.</div>
              ) : (
                adminPessoasRes.map((p, idx) => (
                  <div key={`${p.tipo}-${p.id}-${idx}`} style={{ padding: "4px 0" }}>
                    {p.nome} ({p.tipo})
                  </div>
                ))
              )}
            </div>

            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 10 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Itens manuais</div>
              {adminManuaisRes.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.7 }}>Sem resultados.</div>
              ) : (
                adminManuaisRes.map((m) => (
                  <div key={m.id} style={{ padding: "4px 0" }}>{m.nome}</div>
                ))
              )}
            </div>
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 10, marginTop: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Posse manual (atual)</div>
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

          {adminTrail ? (
            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 10, marginTop: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>{adminTrailTitle}</div>
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                {adminTrail.checklists ? (
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>Checklists</div>
                    <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(adminTrail.checklists, null, 2)}</pre>
                  </div>
                ) : null}
                {adminTrail.termos ? (
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>Termos</div>
                    <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(adminTrail.termos, null, 2)}</pre>
                  </div>
                ) : null}
                {adminTrail.movimentos ? (
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>Movimentos</div>
                    <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(adminTrail.movimentos, null, 2)}</pre>
                  </div>
                ) : null}
                {adminTrail.item_movimentos ? (
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>Item Movimentos</div>
                    <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(adminTrail.item_movimentos, null, 2)}</pre>
                  </div>
                ) : null}
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

          <div style={{ border: "1px solid #ddd", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: 10, background: "#f7f7f7", fontSize: 13 }}>
              {manualLoading ? "Carregando..." : `Mostrando ${manualItens.length} itens manuais`}
            </div>
            <div style={{ maxHeight: 520, overflow: "auto" }}>
              {manualItens.map((it) => (
                <div
                  key={it.id}
                  style={{
                    padding: 10,
                    borderTop: "1px solid #eee",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{it.nome}</div>
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
              ))}
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
      {/* Seleções */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ minWidth: 320 }}>
          <label style={{ fontSize: 12, opacity: 0.85 }}>Kit</label>
          <select
            style={{ width: "100%", padding: 10 }}
            value={selectedKitId}
            onChange={(e) => setSelectedKitId(e.target.value)}
          >
            <option value="">Selecione…</option>
            {kits.map((k) => (
              <option key={k.id} value={k.id}>
                #{k.id} • {k.nome}
              </option>
            ))}
          </select>
          {selectedKitId ? <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{kitLabel}</div> : null}
        </div>

        
        <div style={{ minWidth: 320 }}>
          <label style={{ fontSize: 12, opacity: 0.85 }}>Encarregado/Supervisor</label>
          {canEletrico ? (
            <div style={{ marginTop: 8, fontWeight: 700 }}>{encarregadoLabel}</div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
              Usuário sem encarregado vinculado. Eletricos bloqueados.
            </div>
          )}
        </div>


        <div style={{ flex: 1, minWidth: 280 }}>
          <label style={{ fontSize: 12, opacity: 0.85 }}>Busca (patrimônio ou descrição)</label>
          <input
            style={{ width: "100%", padding: 10 }}
            placeholder="Ex: 2056, furadeira, makita…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={!selectedKitId || kitItens.length === 0}
          />
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
            Dica: digite apenas o final do patrimônio (ex: “937”). Menos drama, mais controle.
          </div>
        </div>
      </div>

      {/* Ações */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <div style={{ padding: "8px 12px", border: "1px solid #ddd", borderRadius: 10 }}>
          Total: <b>{totals.total}</b> • Presente: <b>{totals.presente}</b> • Distribuído: <b>{totals.distribuido}</b> • Pendente:{" "}
          <b>{totals.pendente}</b>
        </div>

        <button
          onClick={markAllAsPresente}
          disabled={!selectedKitId || kitItens.length === 0}
          style={{
            padding: "10px 14px",
            cursor: !selectedKitId || kitItens.length === 0 ? "not-allowed" : "pointer",
            border: "1px solid #111",
            borderRadius: 10,
            fontWeight: 800,
          }}
        >
          Marcar todos PRESENTE
        </button>

        <button
          onClick={openChecklistTermo}
          disabled={!canSubmit || submitting}
          style={{
            padding: "10px 14px",
            cursor: canSubmit ? "pointer" : "not-allowed",
            border: "1px solid #111",
            borderRadius: 10,
            fontWeight: 900,
            opacity: canSubmit ? 1 : 0.6,
          }}
          title={
            canSubmit
              ? "Enviar checklist"
              : "Checklist só envia com kit completo (sem pendente). Distribuído exige seleção + confirmação (PIN 6 dígitos)."
          }
        >
          {submitting ? "Enviando…" : "Enviar Checklist Semanal"}
        </button>
      </div>

      {/* Lista */}
      {!selectedKitId ? (
        <div style={{ opacity: 0.85, padding: 16, border: "1px dashed #ccc", borderRadius: 12 }}>
          Selecione um <b>Kit</b> para carregar itens.
        </div>
      ) : kitItens.length === 0 ? (
        <div style={{ opacity: 0.85, padding: 16, border: "1px dashed #ccc", borderRadius: 12 }}>
          Kit selecionado, mas sem itens carregados. (Ou kit vazio, ou endpoint não respondeu.)
        </div>
      ) : (
        <div style={{ border: "1px solid #ddd", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: 10, background: "#f7f7f7", fontSize: 13 }}>
            Mostrando <b>{filtered.length}</b> de <b>{kitItens.length}</b> itens do kit.
          </div>

          <div style={{ maxHeight: 560, overflow: "auto" }}>
            {filtered.map((x) => {
              const st =
                statusMap[x.kit_item_id] ??
                ({
                  status: null,
                  subresponsavel_text: "",
                  subresponsavel_id: null,
                  distribuicao_confirmada: false,
                });

              const isDistrib = st.status === "DISTRIBUIDO";

              return (
                <div
                  key={x.kit_item_id}
                  style={{
                    padding: 12,
                    borderTop: "1px solid #eee",
                    display: "grid",
                    gridTemplateColumns: "1fr 460px",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 900, fontSize: 15 }}>
                      {x.patrimonio}{" "}
                      <span style={{ fontWeight: 500, opacity: 0.7, fontSize: 12 }}>
                        (kit_item_id: {x.kit_item_id} • item_id: {x.item_id})
                      </span>
                    </div>

                    <div style={{ opacity: 0.9 }}>{x.descricao}</div>

                    <div style={{ opacity: 0.75, fontSize: 12, marginTop: 4 }}>
                      qtd: {x.quantidade ?? 1} • status: <b>{st.status ?? "PENDENTE"}</b>
                      {isDistrib ? (
                        <>
                          {" "}
                          • confirmação:{" "}
                          <b style={{ color: st.distribuicao_confirmada ? "#0b7a38" : "#b00020" }}>
                            {st.distribuicao_confirmada ? "OK" : "PENDENTE"}
                          </b>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button
                      onClick={() => setItemStatus(x.kit_item_id, "PRESENTE")}
                      style={{
                        padding: "8px 12px",
                        cursor: "pointer",
                        border: st.status === "PRESENTE" ? "2px solid #111" : "1px solid #ccc",
                        fontWeight: st.status === "PRESENTE" ? 900 : 600,
                        borderRadius: 10,
                        minWidth: 92,
                      }}
                    >
                      Presente
                    </button>

                    <button
                      onClick={() => setItemStatus(x.kit_item_id, "DISTRIBUIDO")}
                      style={{
                        padding: "8px 12px",
                        cursor: "pointer",
                        border: st.status === "DISTRIBUIDO" ? "2px solid #111" : "1px solid #ccc",
                        fontWeight: st.status === "DISTRIBUIDO" ? 900 : 600,
                        borderRadius: 10,
                        minWidth: 100,
                      }}
                      title={!isGpsValid(geo) ? "Backend não aceita distribuir com GPS inválido" : "Marcar como distribuído"}
                    >
                      Distribuído
                    </button>

                    <button
                      onClick={() => setItemStatus(x.kit_item_id, null)}
                      style={{
                        padding: "8px 12px",
                        cursor: "pointer",
                        border: "1px solid #ccc",
                        fontWeight: 700,
                        borderRadius: 10,
                        minWidth: 92,
                      }}
                      title="Voltar para pendente"
                    >
                      Limpar
                    </button>

                    {isDistrib ? (
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
                        onPick={({ id, nome }) => {
                          // preenche texto + id, mas confirmação ainda não aconteceu
                          setStatusMap((prev) => {
                            const cur = prev[x.kit_item_id];
                            if (!cur) return prev;
                            return {
                              ...prev,
                              [x.kit_item_id]: {
                                ...cur,
                                subresponsavel_text: nome,
                                subresponsavel_id: id,
                                distribuicao_confirmada: false,
                              },
                            };
                          });
                        }}
                        onConfirmSuccess={() => {
                          markDistribConfirmado(x.kit_item_id);
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 12, opacity: 0.75 }}>
        Regra: checklist só envia com <b>kit completo</b> (sem pendente). Distribuído exige seleção + confirmação (PIN 6 dígitos).<br />
        Nota: backend <b>não aceita</b> distribuição com GPS inválido (0,0). Se o GPS do desktop não vier, a próxima evolução é “Obra/Local manual”
        para auditar sem depender do GPS.
      </div>
        </div>
        </div>
      )}
    </div>
  );
}
