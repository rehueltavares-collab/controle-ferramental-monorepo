// pwa/src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost, searchSubresponsaveis, distribuir as apiDistribuir } from "./services/api";

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
 * SafeSelect (dropdown próprio) — evita bug do <select> no Android
 * =========================================================
 */
function SafeSelect({ label, value, onChange, options, placeholder = "Selecione…", disabled, renderOption }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const current = useMemo(() => options.find((o) => String(o.value) === String(value)) ?? null, [options, value]);

  useEffect(() => {
    function onDocClick(e) {
      if (!open) return;
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("touchstart", onDocClick, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("touchstart", onDocClick);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: "relative", minWidth: 320, opacity: disabled ? 0.6 : 1 }}>
      {label ? <label style={{ fontSize: 12, opacity: 0.85 }}>{label}</label> : null}

      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          padding: 10,
          textAlign: "left",
          border: "1px solid #ccc",
          borderRadius: 10,
          cursor: disabled ? "not-allowed" : "pointer",
          background: "#fff",
        }}
      >
        {current ? (
          <span style={{ fontWeight: 800 }}>{renderOption ? renderOption(current.raw) : current.label}</span>
        ) : (
          <span style={{ opacity: 0.7 }}>{placeholder}</span>
        )}
        <span style={{ float: "right", opacity: 0.6 }}>▾</span>
      </button>

      {open ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 58,
            background: "#fff",
            border: "1px solid #ccc",
            borderRadius: 12,
            boxShadow: "0 10px 30px rgba(0,0,0,.18)",
            zIndex: 9999,
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          <div style={{ padding: 10, borderBottom: "1px solid #eee", fontSize: 12, opacity: 0.75 }}>
            {placeholder}
          </div>

          {options.map((opt) => (
            <div
              key={String(opt.value)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                onChange(String(opt.value));
              }}
              style={{
                padding: "10px 12px",
                borderTop: "1px solid #f0f0f0",
                cursor: "pointer",
                background: String(opt.value) === String(value) ? "#f7f7f7" : "#fff",
              }}
            >
              <div style={{ fontWeight: 900, fontSize: 13 }}>{renderOption ? renderOption(opt.raw) : opt.label}</div>
              {opt.sub ? <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{opt.sub}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * =========================================================
 * Subresponsável Autocomplete (com confirmação via PIN)
 * =========================================================
 *
 * ✅ ALTERAÇÃO CRÍTICA:
 * - distribuição NÃO trava mais por GPS.
 * - se GPS estiver ruim, envia 0,0 mas deixa AUDITÁVEL (observacao).
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
  const blurCloseRef = useRef(null);

  // Sincroniza texto externo -> input local
  useEffect(() => {
    setTyping(valueText ?? "");
  }, [valueText]);

  // Busca com debounce
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

    // ✅ NÃO BLOQUEIA POR GPS
    const gpsOk = isGpsValid(geo);

    const pin = window.prompt("PIN do subresponsável (6 dígitos):");
    if (pin == null) return;
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
        observacao: gpsOk ? "PWA" : "PWA (GPS indisponível)",
      };

      await apiDistribuir(payload);

      setMsg(gpsOk ? "✅ Distribuição confirmada." : "✅ Distribuição confirmada (sem GPS — auditável).");
      onConfirmSuccess?.();
    } catch (e) {
      setMsg(e?.message ?? String(e));
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
            if (blurCloseRef.current) clearTimeout(blurCloseRef.current);
            blurCloseRef.current = setTimeout(() => setOpen(false), 180);
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
          isGpsValid(geo)
            ? "Confirmar distribuição (PIN 6 dígitos)"
            : "Confirmar distribuição (PIN 6 dígitos) — GPS indisponível ficará auditável"
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
 *
 * ✅ ALTERAÇÃO CRÍTICA (MODO BASE / ALMOXARIFADO):
 * - CHECKLIST NÃO EXIGE GPS
 * - CAN_SUBMIT NÃO BLOQUEIA POR GPS
 * - SUBMITCHECKLIST NÃO BARRA GPS 0,0
 * - GPS continua "best-effort" (informativo/auditável), mas nunca trava operação
 */
export default function App() {
  const apiBase = import.meta.env.VITE_API_URL;

  // ✅ MODO BASE: não depende de GPS
  const GPS_REQUIRED_FOR_CHECKLIST = false;

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [setores, setSetores] = useState([]);
  const [encarregados, setEncarregados] = useState([]);
  const [kits, setKits] = useState([]);

  const [selectedKitId, setSelectedKitId] = useState("");
  const [selectedEncarregadoId, setSelectedEncarregadoId] = useState("");

  const [kitItens, setKitItens] = useState([]);
  const [q, setQ] = useState("");

  const [statusMap, setStatusMap] = useState({});

  const [geo, setGeo] = useState({
    ok: false,
    latitude: 0,
    longitude: 0,
    accuracy_m: 0,
    gps_timestamp: null,
    last_error: null,
  });

  const [submitting, setSubmitting] = useState(false);
  const [lastSubmit, setLastSubmit] = useState("");

  async function loadMasters() {
    setLoading(true);
    setErr("");

    try {
      const [setoresRes, encRes, kitsRes] = await Promise.all([
        withRetry(() => apiGet("/setores/"), 2, 300),
        withRetry(() => apiGet("/encarregados/"), 2, 300),
        withRetry(() => apiGet("/kits/"), 2, 300),
      ]);

      console.log("[masters] setores raw:", setoresRes);
      console.log("[masters] encarregados raw:", encRes);
      console.log("[masters] kits raw:", kitsRes);

      const setoresList = safeArray(setoresRes);
      const encList = safeArray(encRes);
      const kitsList = safeArray(kitsRes);

      console.log("[masters] setores:", setoresList.length);
      console.log("[masters] encarregados:", encList.length);
      console.log("[masters] kits:", kitsList.length);

      setSetores(setoresList);
      setEncarregados(encList);
      setKits(kitsList);
    } catch (e) {
      console.error("loadMasters error:", e);
      setErr(e?.message ?? "Falha ao buscar (rede instável). Tente recarregar.");
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
   * GPS (best-effort / informativo)
   * =========================================================
   */
  function requestGps(timeoutMs = 15000) {
    if (!("geolocation" in navigator)) {
      setGeo((g) => ({ ...g, ok: false, last_error: "Geolocation não suportado" }));
      return;
    }

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
          last_error: null,
        });
      },
      (e) => {
        console.warn("GPS error:", e);
        setGeo((g) => ({
          ...g,
          ok: false,
          last_error: `${e?.code ?? "?"} ${e?.message ?? "Erro GPS"}`,
        }));
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  }

  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setGeo((g) => ({ ...g, ok: false, last_error: "Geolocation não suportado" }));
      return;
    }

    let cancelled = false;
    let watchId = null;

    // tenta pegar (se o browser permitir)
    requestGps(12000);

    const t1 = setTimeout(() => !cancelled && requestGps(20000), 4000);
    const t2 = setTimeout(() => !cancelled && requestGps(30000), 12000);

    try {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (cancelled) return;
          const lat = pos.coords.latitude ?? 0;
          const lng = pos.coords.longitude ?? 0;
          const acc = pos.coords.accuracy ?? 0;

          setGeo({
            ok: true,
            latitude: lat,
            longitude: lng,
            accuracy_m: acc,
            gps_timestamp: new Date().toISOString(),
            last_error: null,
          });
        },
        (e) => {
          if (cancelled) return;
          console.warn("GPS watch error:", e);
          setGeo((g) => ({
            ...g,
            ok: false,
            last_error: `${e?.code ?? "?"} ${e?.message ?? "Erro GPS"}`,
          }));
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 25000 }
      );
    } catch {
      // browsers podem bloquear (IP sem https), e tá tudo bem — MODO BASE
    }

    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
      if (watchId != null) {
        try {
          navigator.geolocation.clearWatch(watchId);
        } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const canSubmit = useMemo(() => {
    if (!selectedKitId) return false;
    if (!selectedEncarregadoId) return false;
    if (kitItens.length === 0) return false;

    if (totals.pendente > 0) return false;

    for (const ki of kitItens) {
      const st = statusMap[ki.kit_item_id];
      if (st?.status === "DISTRIBUIDO") {
        if (!st.subresponsavel_id) return false;
        if (!st.distribuicao_confirmada) return false;
      }
    }

    // ✅ MODO BASE: não trava por GPS
    if (GPS_REQUIRED_FOR_CHECKLIST && !isGpsValid(geo)) return false;

    return true;
  }, [selectedKitId, selectedEncarregadoId, kitItens, totals.pendente, statusMap, geo]);

  function setItemStatus(kitItemId, status) {
    setStatusMap((prev) => {
      const cur = prev[kitItemId] ?? {
        status: null,
        subresponsavel_text: "",
        subresponsavel_id: null,
        distribuicao_confirmada: false,
      };

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

      if (status === "DISTRIBUIDO") {
        return {
          ...prev,
          [kitItemId]: {
            ...cur,
            status: "DISTRIBUIDO",
          },
        };
      }

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

  async function submitChecklist() {
    setSubmitting(true);
    setErr("");
    setLastSubmit("");

    try {
      // ✅ MODO BASE: não bloqueia GPS (mas mantém auditável)
      if (GPS_REQUIRED_FOR_CHECKLIST && !isGpsValid(geo)) {
        setErr("GPS indisponível (0,0). Para enviar checklist, ative localização e tente novamente.");
        return;
      }

      const encId = Number(selectedEncarregadoId);
      const kitId = Number(selectedKitId);

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

      // mantém lat/lng no payload (0,0 quando bloqueado pelo browser)
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

  const gpsValid = isGpsValid(geo);
  const gpsLabel = gpsValid
    ? "GPS ok"
    : geo.last_error?.includes("Only secure origins")
    ? "GPS bloqueado (IP sem HTTPS) — modo base"
    : geo.ok
    ? "GPS inválido"
    : "GPS indisponível";

  const kitOptions = kits.map((k) => ({
    value: String(k.id),
    label: `#${k.id} • ${k.nome}`,
    raw: k,
  }));

  const encarregadoOptions = encarregados.map((x) => ({
    value: String(x.id),
    label: `#${x.id} • ${x.nome}`,
    sub: x.funcao ? `(${x.funcao})` : "(—)",
    raw: x,
  }));

  return (
    <div style={{ padding: 16, fontFamily: "system-ui", maxWidth: 1200, margin: "0 auto" }}>
      <h2 style={{ marginBottom: 6 }}>Checklist Semanal • Ferramental</h2>

      <div style={{ opacity: 0.8, marginBottom: 12, fontSize: 13 }}>
        API: <code>{apiBase}</code> • {gpsLabel} • {nowISO()}
        <button
          onClick={() => requestGps(20000)}
          style={{
            marginLeft: 10,
            padding: "4px 8px",
            border: "1px solid #111",
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 12,
          }}
          title="Forçar atualização do GPS (se o navegador permitir)"
        >
          Atualizar GPS
        </button>
        {!gpsValid && geo.last_error ? (
          <span style={{ marginLeft: 10, fontSize: 12, color: "#b36b00" }}>⚠️ {geo.last_error}</span>
        ) : null}
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
        <SafeSelect
          label="Kit"
          value={selectedKitId}
          onChange={(v) => setSelectedKitId(v)}
          options={kitOptions}
          placeholder="Selecione…"
        />

        <div style={{ minWidth: 320, flex: "0 0 auto" }}>
          {selectedKitId ? <div style={{ fontSize: 12, opacity: 0.75, marginTop: 22 }}>{kitLabel}</div> : null}
        </div>

        <SafeSelect
          label="Encarregado"
          value={selectedEncarregadoId}
          onChange={(v) => setSelectedEncarregadoId(v)}
          options={encarregadoOptions}
          placeholder="Selecione…"
        />

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
          Total: <b>{totals.total}</b> • Presente: <b>{totals.presente}</b> • Distribuído: <b>{totals.distribuido}</b> •
          Pendente: <b>{totals.pendente}</b>
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
              : GPS_REQUIRED_FOR_CHECKLIST && !gpsValid
              ? "Checklist exige GPS válido (modo atual)"
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
                      title="Marcar como distribuído"
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
                        onConfirmSuccess={() => markDistribConfirmado(x.kit_item_id)}
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
        Regra: checklist só envia com <b>kit completo</b> (sem pendente). Distribuído exige seleção + confirmação (PIN 6 dígitos).
        <br />
        Nota: distribuição <b>aceita</b> GPS 0,0 e fica auditável. Checklist em <b>modo base</b> não trava por GPS.
      </div>
    </div>
  );
}
