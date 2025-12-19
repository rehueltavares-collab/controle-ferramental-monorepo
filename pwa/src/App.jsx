import { useEffect, useMemo, useState } from "react";
import {
  apiGet,
  apiPost,
  searchSubresponsaveis,
  distribuir,
  recolher,
} from "./services/api";

/**
 * App.jsx (PWA)
 * Checklist Semanal – Ferramental
 *
 * Regras:
 * 1) Checklist só envia com KIT COMPLETO (sem pendente)
 * 2) Se item for DISTRIBUIDO:
 *    - exige selecionar subresponsável (ID)
 *    - exige confirmar com PIN (6 dígitos) -> registra movimento no backend
 * 3) GPS é bônus: nunca pode travar o fluxo
 *
 * Backend exige em /movimentos/distribuir:
 * - accuracy_m (obrigatório no schema)
 * - gps_timestamp (pode ser obrigatório dependendo do schema)
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

function safeArray(x) {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.value)) return x.value;
  return [];
}

function isSixDigits(pin) {
  return /^[0-9]{6}$/.test(String(pin ?? ""));
}

/**
 * GPS helper (inline)
 * - NUNCA lança erro
 * - sempre retorna accuracy_m (número) e gps_timestamp (ISO string)
 */
async function getCurrentPositionSafe() {
  const fallback = {
    ok: false,
    lat: 0,
    lng: 0,
    accuracy_m: 0, // backend exige campo
    gps_timestamp: new Date().toISOString(),
    reason: "gps_unavailable",
  };

  if (!("geolocation" in navigator)) return fallback;

  return new Promise((resolve) => {
    const opts = {
      enableHighAccuracy: true,
      timeout: 3000,
      maximumAge: 60000,
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          ok: true,
          lat: pos.coords.latitude ?? 0,
          lng: pos.coords.longitude ?? 0,
          accuracy_m: Number(pos.coords.accuracy ?? 0),
          gps_timestamp: new Date().toISOString(),
          reason: null,
        });
      },
      (err) => {
        resolve({
          ...fallback,
          reason: err?.message ?? "gps_error",
        });
      },
      opts
    );
  });
}

export default function App() {
  const apiBase = import.meta.env.VITE_API_URL;

  // ---------- Dados mestres ----------
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [setores, setSetores] = useState([]);
  const [encarregados, setEncarregados] = useState([]);
  const [kits, setKits] = useState([]);

  // ---------- Seleções ----------
  const [selectedKitId, setSelectedKitId] = useState("");
  const [selectedEncarregadoId, setSelectedEncarregadoId] = useState("");

  // ---------- Itens do kit ----------
  const [kitItens, setKitItens] = useState([]); // detalhados
  const [q, setQ] = useState("");

  /**
   * statusMap[kit_item_id] = {
   *   status: "PRESENTE" | "DISTRIBUIDO" | null,
   *   subresponsavel: string,
   *   subresponsavel_id: number|null,
   *   distribuicao_ok: boolean
   * }
   */
  const [statusMap, setStatusMap] = useState({});

  // ---------- Autocomplete ----------
  // subQueryMap: texto no input por item
  const [subQueryMap, setSubQueryMap] = useState({});
  // subOptionsMap: lista retornada por item
  const [subOptionsMap, setSubOptionsMap] = useState({});
  // subLoadingMap: loading por item
  const [subLoadingMap, setSubLoadingMap] = useState({});

  // ---------- Geo (display no topo) ----------
  const [geo, setGeo] = useState({ latitude: 0, longitude: 0, ok: false });

  // ---------- Submit ----------
  const [submitting, setSubmitting] = useState(false);
  const [lastSubmit, setLastSubmit] = useState("");

  /* ========================= LOAD INICIAL ========================= */

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr("");
      try {
        const [setoresRes, encarRes, kitsRes] = await Promise.all([
          apiGet("/setores/"),
          apiGet("/encarregados/"),
          apiGet("/kits/"),
        ]);

        setSetores(safeArray(setoresRes));
        setEncarregados(safeArray(encarRes));
        setKits(safeArray(kitsRes));
      } catch (e) {
        setErr(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /* ========================= GEO (best effort) ========================= */

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({
          latitude: pos.coords.latitude ?? 0,
          longitude: pos.coords.longitude ?? 0,
          ok: true,
        });
      },
      () => setGeo((g) => ({ ...g, ok: false })),
      { enableHighAccuracy: true, timeout: 3000 }
    );
  }, []);

  /* ========================= CARREGAR ITENS DO KIT ========================= */

  useEffect(() => {
    (async () => {
      if (!selectedKitId) {
        setKitItens([]);
        setStatusMap({});
        setSubQueryMap({});
        setSubOptionsMap({});
        setSubLoadingMap({});
        return;
      }

      setErr("");
      try {
        const res = await apiGet(`/kits/${selectedKitId}/itens-detalhados/`);
        const list = safeArray(res);
        setKitItens(list);

        // inicializa statusMap por kit_item_id (único)
        const next = {};
        for (const it of list) {
          next[it.kit_item_id] = {
            status: null,
            subresponsavel: "",
            subresponsavel_id: null,
            distribuicao_ok: false,
          };
        }
        setStatusMap(next);

        // reset autocomplete
        setSubQueryMap({});
        setSubOptionsMap({});
        setSubLoadingMap({});
      } catch (e) {
        setErr(e?.message ?? String(e));
        setKitItens([]);
        setStatusMap({});
      }
    })();
  }, [selectedKitId]);

  /* ========================= AUTOCOMPLETE (DEBOUNCE) ========================= */

  useEffect(() => {
    const entries = Object.entries(subQueryMap);

    const timers = entries.map(([kitItemIdStr, text]) => {
      const kitItemId = Number(kitItemIdStr);
      const query = (text ?? "").trim();

      // não busca com menos de 2 chars
      if (!query || query.length < 2) {
        setSubOptionsMap((p) => ({ ...p, [kitItemId]: [] }));
        return null;
      }

      return setTimeout(async () => {
        try {
          setSubLoadingMap((p) => ({ ...p, [kitItemId]: true }));
          const resp = await searchSubresponsaveis(query);
          const lista = safeArray(resp);
          setSubOptionsMap((p) => ({ ...p, [kitItemId]: lista.slice(0, 12) }));
        } catch {
          setSubOptionsMap((p) => ({ ...p, [kitItemId]: [] }));
        } finally {
          setSubLoadingMap((p) => ({ ...p, [kitItemId]: false }));
        }
      }, 250);
    });

    return () => timers.forEach((t) => t && clearTimeout(t));
  }, [subQueryMap]);

  /* ========================= LABELS / FILTROS ========================= */

  const kitLabel = useMemo(() => {
    const k = kits.find((x) => String(x.id) === String(selectedKitId));
    if (!k) return "";
    const setor = setores.find((s) => s.id === k.setor_id)?.nome ?? `Setor ${k.setor_id}`;
    return `${k.nome} • ${setor} • ${k.tipo ?? ""}`.trim();
  }, [kits, setores, selectedKitId]);

  const filtered = useMemo(() => {
    const nq = norm(q);
    if (!nq) return kitItens;

    return kitItens.filter((x) => {
      const a = norm(x.patrimonio);
      const b = norm(x.descricao);
      return a.includes(nq) || b.includes(nq);
    });
  }, [kitItens, q]);

  /* ========================= CONTADORES ========================= */

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

  /* ========================= REGRAS (KIT COMPLETO + CONFIRMAÇÕES) ========================= */

  const canSubmit = useMemo(() => {
    if (!selectedKitId) return false;
    if (!selectedEncarregadoId) return false;
    if (kitItens.length === 0) return false;

    // (1) kit completo: todo item precisa ter status (PRESENTE ou DISTRIBUIDO)
    for (const ki of kitItens) {
      const st = statusMap[ki.kit_item_id];
      if (!st?.status) return false;
    }

    // (2) distribuído exige seleção + confirmação
    for (const ki of kitItens) {
      const st = statusMap[ki.kit_item_id];
      if (st?.status === "DISTRIBUIDO") {
        if (!st.subresponsavel_id) return false;
        if (!st.distribuicao_ok) return false;
      }
    }

    return true;
  }, [selectedKitId, selectedEncarregadoId, kitItens, statusMap]);

  /* ========================= FUNÇÕES DE ESTADO ========================= */

  function setItemStatus(kitItemId, status) {
    setStatusMap((prev) => ({
      ...prev,
      [kitItemId]: { ...(prev[kitItemId] ?? {}), status },
    }));
  }

  function markAllAsPresente() {
    setStatusMap((prev) => {
      const next = { ...prev };
      for (const ki of kitItens) {
        next[ki.kit_item_id] = {
          ...(next[ki.kit_item_id] ?? {}),
          status: "PRESENTE",
          subresponsavel: "",
          subresponsavel_id: null,
          distribuicao_ok: false,
        };
      }
      return next;
    });

    setSubQueryMap({});
    setSubOptionsMap({});
    setSubLoadingMap({});
  }

  /* ========================= MOVIMENTOS ========================= */

  async function distribuirItem(ki) {
    setErr("");

    const st = statusMap[ki.kit_item_id];
    if (!st?.subresponsavel_id) {
      alert("Selecione um subresponsável na lista.");
      return;
    }

    let pin = prompt("PIN do subresponsável (6 dígitos):");
    if (pin == null) return;
    pin = String(pin).trim();

    if (!isSixDigits(pin)) {
      alert("PIN inválido. Precisa ter 6 dígitos numéricos.");
      return;
    }

    try {
      const gps = await getCurrentPositionSafe();

      // IMPORTANTE: accuracy_m é obrigatório no backend
      const payload = {
        kit_id: Number(selectedKitId),
        patrimonio: ki.patrimonio,
        encarregado_id: Number(selectedEncarregadoId),
        subresponsavel_id: st.subresponsavel_id,
        pin,
        lat: gps.lat,
        lng: gps.lng,
        accuracy_m: gps.accuracy_m ?? 0,
        gps_timestamp: gps.gps_timestamp ?? new Date().toISOString(),
        observacao: "PWA",
      };

      const resp = await distribuir(payload);
      console.log("DISTRIBUIR OK:", resp);

      setStatusMap((prev) => ({
        ...prev,
        [ki.kit_item_id]: {
          ...(prev[ki.kit_item_id] ?? {}),
          distribuicao_ok: true,
        },
      }));

      setSubOptionsMap((p) => ({ ...p, [ki.kit_item_id]: [] }));
      alert("✅ Distribuição confirmada.");
    } catch (e) {
      console.error("DISTRIBUIR ERRO:", e);
      setErr(e?.message ?? String(e));
      alert("Falhou ao confirmar distribuição. Veja o erro no topo.");
    }
  }

  async function recolherItem(ki) {
    setErr("");
    try {
      const gps = await getCurrentPositionSafe();

      const payload = {
        kit_id: Number(selectedKitId),
        patrimonio: ki.patrimonio,
        encarregado_id: Number(selectedEncarregadoId),
        lat: gps.lat,
        lng: gps.lng,
        accuracy_m: gps.accuracy_m ?? 0,
        gps_timestamp: gps.gps_timestamp ?? new Date().toISOString(),
        observacao: "PWA",
      };

      const resp = await recolher(payload);
      console.log("RECOLHER OK:", resp);

      setStatusMap((prev) => ({
        ...prev,
        [ki.kit_item_id]: {
          ...(prev[ki.kit_item_id] ?? {}),
          distribuicao_ok: false,
        },
      }));

      alert("✅ Recolhido.");
    } catch (e) {
      console.error("RECOLHER ERRO:", e);
      setErr(e?.message ?? String(e));
      alert("Falhou ao recolher. Veja o erro no topo.");
    }
  }

  /* ========================= CHECKLIST (POST) ========================= */

  async function submitChecklist() {
    setSubmitting(true);
    setErr("");
    setLastSubmit("");

    try {
      const encId = Number(selectedEncarregadoId);
      const kitId = Number(selectedKitId);

      const lines = kitItens.map((ki) => {
        const st = statusMap[ki.kit_item_id];
        const base = `${ki.patrimonio} - ${ki.descricao}`;
        if (st?.status === "DISTRIBUIDO") {
          return `${base} | DISTRIBUIDO_PARA: ${st.subresponsavel}`;
        }
        return base;
      });

      await apiPost("/checklists-semanais/", {
        kit_id: kitId,
        encarregado_id: encId,
        latitude: geo.latitude ?? 0,
        longitude: geo.longitude ?? 0,
        patrimonios_declarados: lines.join("\n"),
      });

      setLastSubmit(`Checklist enviado em ${new Date().toLocaleString()}`);
    } catch (e) {
      setErr(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  /* ========================= UI ========================= */

  if (loading) {
    return (
      <div style={{ padding: 16, fontFamily: "system-ui" }}>
        <h2>Controle de Ferramental</h2>
        <p>Carregando dados…</p>
        <p style={{ opacity: 0.7 }}>API: {apiBase}</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, fontFamily: "system-ui", maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ marginBottom: 6 }}>Checklist Semanal • Ferramental</h2>

      <div style={{ opacity: 0.75, marginBottom: 12, fontSize: 13 }}>
        API: <code>{apiBase}</code> • {geo.ok ? "GPS ok" : "GPS indisponível"} • {nowISO()}
      </div>

      {err ? (
        <div style={{ background: "#ffe8e8", border: "1px solid #ffb3b3", padding: 10, marginBottom: 12 }}>
          <b>Erro:</b> {err}
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
          <label style={{ fontSize: 12, opacity: 0.8 }}>Kit</label>
          <select style={{ width: "100%", padding: 8 }} value={selectedKitId} onChange={(e) => setSelectedKitId(e.target.value)}>
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
          <label style={{ fontSize: 12, opacity: 0.8 }}>Encarregado</label>
          <select
            style={{ width: "100%", padding: 8 }}
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
            {!selectedEncarregadoId ? "Sem encarregado selecionado, sem checklist. A vida é dura." : "Encarregado selecionado."}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 260 }}>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Busca (patrimônio ou descrição)</label>
          <input
            style={{ width: "100%", padding: 8 }}
            placeholder="Ex: 2056, furadeira, makita…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={!selectedKitId || kitItens.length === 0}
          />
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
            Dica: digite só o final do patrimônio (ex: “937”). Menos drama, mais controle.
          </div>
        </div>
      </div>

      {/* Ações */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <div style={{ padding: "6px 10px", border: "1px solid #ddd", borderRadius: 8 }}>
          Total: <b>{totals.total}</b> • Presente: <b>{totals.presente}</b> • Distribuído: <b>{totals.distribuido}</b> • Pendente:{" "}
          <b>{totals.pendente}</b>
        </div>

        <button
          onClick={markAllAsPresente}
          disabled={!selectedKitId || kitItens.length === 0}
          style={{ padding: "8px 12px", cursor: "pointer", fontWeight: 700 }}
        >
          Marcar todos PRESENTE
        </button>

        <button
          onClick={submitChecklist}
          disabled={!canSubmit || submitting}
          style={{
            padding: "8px 12px",
            cursor: canSubmit ? "pointer" : "not-allowed",
            border: "1px solid #111",
            fontWeight: 700,
          }}
          title={
            canSubmit
              ? "Enviar checklist"
              : "Kit completo obrigatório (sem pendente). Distribuídos exigem seleção + confirmação (PIN)."
          }
        >
          {submitting ? "Enviando…" : "Enviar Checklist Semanal"}
        </button>
      </div>

      {/* Lista */}
      {!selectedKitId ? (
        <div style={{ opacity: 0.8, padding: 16, border: "1px dashed #ccc" }}>
          Selecione um <b>Kit</b> para carregar itens.
        </div>
      ) : kitItens.length === 0 ? (
        <div style={{ opacity: 0.8, padding: 16, border: "1px dashed #ccc" }}>
          Kit selecionado, mas sem itens carregados. (Ou kit vazio, ou endpoint não respondeu.)
        </div>
      ) : (
        <div style={{ border: "1px solid #ddd", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: 10, background: "#f7f7f7", fontSize: 13 }}>
            Mostrando <b>{filtered.length}</b> de <b>{kitItens.length}</b> itens do kit.
          </div>

          <div style={{ maxHeight: 520, overflow: "auto" }}>
            {filtered.map((x) => {
              const st = statusMap[x.kit_item_id] ?? {
                status: null,
                subresponsavel: "",
                subresponsavel_id: null,
                distribuicao_ok: false,
              };

              const isDistrib = st.status === "DISTRIBUIDO";
              const inputValue = subQueryMap[x.kit_item_id] ?? st.subresponsavel ?? "";
              const options = subOptionsMap[x.kit_item_id] ?? [];
              const loadingOpt = !!subLoadingMap[x.kit_item_id];

              return (
                <div
                  key={x.kit_item_id}
                  style={{
                    padding: 10,
                    borderTop: "1px solid #eee",
                    display: "grid",
                    gridTemplateColumns: "1fr 520px",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 800 }}>
                      {x.patrimonio}{" "}
                      <span style={{ fontWeight: 400, opacity: 0.7, fontSize: 12 }}>
                        (kit_item_id: {x.kit_item_id} • item_id: {x.item_id})
                      </span>
                    </div>

                    <div style={{ opacity: 0.85 }}>{x.descricao}</div>

                    <div style={{ opacity: 0.7, fontSize: 12 }}>
                      status: <b>{st.status ?? "PENDENTE"}</b>
                      {isDistrib ? (
                        <span style={{ marginLeft: 10 }}>
                          • confirmação: <b>{st.distribuicao_ok ? "OK" : "PENDENTE"}</b>
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
                    {/* PRESENTE */}
                    <button
                      onClick={async () => {
                        const current = statusMap[x.kit_item_id];
                        if (current?.status === "DISTRIBUIDO" && current?.distribuicao_ok) {
                          await recolherItem(x);
                        }

                        setStatusMap((prev) => ({
                          ...prev,
                          [x.kit_item_id]: {
                            ...(prev[x.kit_item_id] ?? {}),
                            status: "PRESENTE",
                            subresponsavel: "",
                            subresponsavel_id: null,
                            distribuicao_ok: false,
                          },
                        }));

                        setSubQueryMap((p) => ({ ...p, [x.kit_item_id]: "" }));
                        setSubOptionsMap((p) => ({ ...p, [x.kit_item_id]: [] }));
                      }}
                      style={{
                        padding: "6px 10px",
                        cursor: "pointer",
                        border: st.status === "PRESENTE" ? "2px solid #111" : "1px solid #ccc",
                        fontWeight: st.status === "PRESENTE" ? 800 : 400,
                      }}
                    >
                      Presente
                    </button>

                    {/* DISTRIBUÍDO */}
                    <button
                      onClick={() => {
                        setStatusMap((prev) => ({
                          ...prev,
                          [x.kit_item_id]: {
                            ...(prev[x.kit_item_id] ?? {}),
                            status: "DISTRIBUIDO",
                            distribuicao_ok: false,
                          },
                        }));
                      }}
                      style={{
                        padding: "6px 10px",
                        cursor: "pointer",
                        border: st.status === "DISTRIBUIDO" ? "2px solid #111" : "1px solid #ccc",
                        fontWeight: st.status === "DISTRIBUIDO" ? 800 : 400,
                      }}
                      title="Marcar como distribuído (depois confirmar com PIN)"
                    >
                      Distribuído
                    </button>

                    {/* LIMPAR */}
                    <button
                      onClick={() => {
                        setStatusMap((prev) => ({
                          ...prev,
                          [x.kit_item_id]: {
                            ...(prev[x.kit_item_id] ?? {}),
                            status: null,
                            subresponsavel: "",
                            subresponsavel_id: null,
                            distribuicao_ok: false,
                          },
                        }));
                        setSubQueryMap((p) => ({ ...p, [x.kit_item_id]: "" }));
                        setSubOptionsMap((p) => ({ ...p, [x.kit_item_id]: [] }));
                      }}
                      style={{ padding: "6px 10px", cursor: "pointer", border: "1px solid #ccc" }}
                      title="Voltar para pendente"
                    >
                      Limpar
                    </button>

                    {/* SUBRESPONSÁVEL + CONFIRMAR */}
                    {isDistrib ? (
                      <div style={{ position: "relative", minWidth: 380 }}>
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                          <input
                            style={{ padding: 6, width: 250 }}
                            placeholder="Buscar subresponsável..."
                            value={inputValue}
                            onChange={(e) => {
                              const v = e.target.value;

                              setSubQueryMap((p) => ({ ...p, [x.kit_item_id]: v }));

                              // ao digitar, invalida seleção
                              setStatusMap((p) => ({
                                ...p,
                                [x.kit_item_id]: {
                                  ...(p[x.kit_item_id] ?? {}),
                                  subresponsavel: v,
                                  subresponsavel_id: null,
                                  distribuicao_ok: false,
                                },
                              }));
                            }}
                          />

                          <button
                            onClick={() => distribuirItem(x)}
                            disabled={!st.subresponsavel_id}
                            style={{
                              padding: "6px 10px",
                              cursor: st.subresponsavel_id ? "pointer" : "not-allowed",
                              border: "1px solid #ccc",
                              fontWeight: 700,
                            }}
                            title={!st.subresponsavel_id ? "Selecione um nome da lista" : "Confirma e pede PIN"}
                          >
                            Confirmar
                          </button>
                        </div>

                        {loadingOpt ? (
                          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>Buscando...</div>
                        ) : null}

                        {options.length ? (
                          <div
                            style={{
                              position: "absolute",
                              top: 36,
                              right: 0,
                              width: 380,
                              background: "#fff",
                              color: "#111",
                              border: "1px solid #ccc",
                              borderRadius: 8,
                              overflow: "hidden",
                              zIndex: 9999,
                              boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
                            }}
                          >
                            {options.map((opt) => (
                              <div
                                key={opt.id}
                                onClick={() => {
                                  // sobe texto pro input
                                  setSubQueryMap((p) => ({ ...p, [x.kit_item_id]: opt.nome }));

                                  // salva ID selecionado
                                  setStatusMap((p) => ({
                                    ...p,
                                    [x.kit_item_id]: {
                                      ...(p[x.kit_item_id] ?? {}),
                                      subresponsavel: opt.nome,
                                      subresponsavel_id: opt.id,
                                      distribuicao_ok: false,
                                    },
                                  }));

                                  // fecha lista
                                  setSubOptionsMap((p) => ({ ...p, [x.kit_item_id]: [] }));
                                }}
                                style={{
                                  padding: "8px 10px",
                                  cursor: "pointer",
                                  borderTop: "1px solid #eee",
                                  fontSize: 13,
                                  color: "#111",
                                }}
                                title={opt.secao ?? ""}
                              >
                                <b>{opt.nome}</b>{" "}
                                <span style={{ opacity: 0.7 }}>• {opt.secao ?? "—"}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 12, opacity: 0.7 }}>
        Regra: checklist <b>só envia</b> com kit completo (sem pendente). Distribuído exige seleção + confirmação (PIN 6 dígitos).
      </div>
    </div>
  );
}
