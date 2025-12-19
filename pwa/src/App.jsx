// pwa/src/App.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  apiGet,
  apiPost,
  searchSubresponsaveis,
  distribuir as apiDistribuir,
  recolher as apiRecolher,
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

  const lastQueryRef = useRef("");
  const debounceRef = useRef(null);

  // Sincroniza texto externo -> input local
  useEffect(() => {
    setTyping(valueText ?? "");
  }, [valueText]);

  // Busca com debounce
  useEffect(() => {
    const q = (typing ?? "").trim();
    setMsg("");

    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Se o usuário apagou, zera opções e "desseleciona"
    if (!q) {
      setOptions([]);
      setOpen(false);
      // não mexe no selectedId automaticamente (evita perder seleção por acidente)
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        setLoading(true);
        lastQueryRef.current = q;

        const res = await searchSubresponsaveis(q);
        const list = safeArray(res); // backend pode vir [] ou {value:[]}

        // Só aplica se for a busca mais recente
        if (lastQueryRef.current !== q) return;

        setOptions(list);
        setOpen(true);
      } catch (e) {
        setOptions([]);
        setOpen(false);
        setMsg(e?.message ?? "Falha ao buscar subresponsáveis");
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [typing]);

  function handlePick(opt) {
    // opt: {id, nome, secao, ativo}
    const label = `${opt.nome}`;
    setTyping(label);
    setOpen(false);
    setOptions([]);
    onPick({ id: opt.id, nome: opt.nome });
  }

  async function confirmDistribuir() {
    setMsg("");

    if (!kitId || !patrimonio || !encarregadoId) {
      setMsg("Selecione kit e encarregado antes.");
      return;
    }

    if (!selectedId) {
      setMsg("Selecione um subresponsável na lista.");
      return;
    }

    // Backend barra GPS inválido. Então aqui a gente bloqueia antes.
    if (!isGpsValid(geo)) {
      setMsg("GPS indisponível/inválido. Não dá pra confirmar distribuição sem localização.");
      return;
    }

    const pin = window.prompt("PIN do subresponsável (6 dígitos):");
    if (pin == null) return; // cancelou
    const pinTrim = String(pin).trim();

    if (!/^\d{6}$/.test(pinTrim)) {
      setMsg("PIN inválido. Precisa ter 6 dígitos numéricos.");
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

      // chama o backend (movimentos/distribuir)
      await apiDistribuir(payload);

      setMsg("✅ Distribuição confirmada.");
      onConfirmSuccess?.();
    } catch (e) {
      // Mostra o erro real (quando vier JSON stringado pelo fetch)
      const t = e?.message ?? String(e);

      // Se o backend manda {"detail":"..."} no texto, o nosso apiPost já joga isso no message
      setMsg(t.includes("detail") ? t : t);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div style={{ position: "relative", width: 340, display: "flex", gap: 8, alignItems: "center" }}>
      <div style={{ flex: 1, position: "relative" }}>
        <input
          style={{ width: "100%", padding: 8 }}
          placeholder="Subresponsável (digite para buscar)"
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
            // fecha com pequeno atraso para permitir clique na lista
            setTimeout(() => setOpen(false), 150);
          }}
        />

        {/* Dropdown */}
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

        {/* Loading / mensagem */}
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
          {loading ? "Buscando..." : null}
          {msg ? (
            <span style={{ marginLeft: 8, color: msg.startsWith("✅") ? "#0b7a38" : "#b00020" }}>{msg}</span>
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
            ? "GPS inválido — backend não aceita distribuição sem localização"
            : "Confirmar distribuição (PIN 6 dígitos)"
        }
      >
        {confirming ? "Confirmando..." : "Confirmar"}
      </button>
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

  useEffect(() => {
    loadMasters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  /**
   * =========================================================
   * POST checklist (modelo atual do backend)
   *
   * Observação:
   * - backend hoje salva "patrimonios_declarados" no checklist semanal
   * - movimentos (distribuir/recolher) ficam na tabela item_movimentos
   * =========================================================
   */
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

  const gpsLabel = isGpsValid(geo) ? "GPS ok" : geo.ok ? "GPS inválido" : "GPS indisponível";

  return (
    <div style={{ padding: 16, fontFamily: "system-ui", maxWidth: 1200, margin: "0 auto" }}>
      <h2 style={{ marginBottom: 6 }}>Checklist Semanal • Ferramental</h2>

      <div style={{ opacity: 0.8, marginBottom: 12, fontSize: 13 }}>
        API: <code>{apiBase}</code> • {gpsLabel} • {nowISO()}
      </div>

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
          ✅ {lastSubmit}
        </div>
      ) : null}

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
          <label style={{ fontSize: 12, opacity: 0.85 }}>Encarregado</label>
          <select
            style={{ width: "100%", padding: 10 }}
            value={selectedEncarregadoId}
            onChange={(e) => setSelectedEncarregadoId(e.target.value)}
          >
            <option value="">Selecione…</option>
            {encarregados.map((x) => (
              <option key={x.id} value={x.id}>
                #{x.id} • {x.nome} ({x.funcao ?? "—"})
              </option>
            ))}
          </select>

          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
            Sem encarregado selecionado, sem checklist. A vida é dura.
          </div>
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
          onClick={submitChecklist}
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
  );
}
