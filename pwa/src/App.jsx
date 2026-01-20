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

function AvulsosPanel({ avulsos, onSolicitarAvulso }) {
  return (
    <CardShell
      title="Itens Avulsos"
      subtitle="Ferramentas fora de kits (reserva para substituição/manutenção/uso temporário)."
      right={
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          Total: <b>{avulsos?.length ?? 0}</b>
        </span>
      }
    >
      {(!avulsos || avulsos.length === 0) ? (
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          Nenhum item avulso disponível no momento. Quando o inventário consolidar, aqui aparece o “que sobrou do kit”.
        </div>
      ) : (
        <div style={{ maxHeight: 220, overflow: "auto", borderRadius: 12, border: "1px solid #eee" }}>
          {avulsos.map((it, idx) => (
            <div
              key={`${it.patrimonio ?? "avulso"}-${idx}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                borderTop: idx === 0 ? "none" : "1px solid #f1f1f1",
              }}
            >
              <div>
                <div style={{ fontWeight: 800 }}>{it.patrimonio ?? "—"}</div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>{it.descricao ?? it.nome ?? "Item avulso"}</div>
              </div>
              <button
                onClick={() => onSolicitarAvulso?.(it)}
                style={{
                  borderRadius: 10,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                  padding: "8px 10px",
                  fontWeight: 800,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
                title="Solicitar uso temporário deste item"
              >
                Solicitar
              </button>
            </div>
          ))}
        </div>
      )}
    </CardShell>
  );
}

function SolicitacoesCard({ totals, items, statusMap, selectedKitId, canSubmit, submitting, onSubmitChecklist }) {
  const pendentes = useMemo(() => {
    if (!selectedKitId) return [];
    return (items ?? []).filter((x) => {
      const st = statusMap?.[x.kit_item_id]?.status ?? null;
      return st == null;
    });
  }, [items, statusMap, selectedKitId]);

  return (
    <CardShell
      title="Solicitações"
      subtitle="Checklist semanal: confirma o kit e gera termo."
      right={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Pill label="Total" value={totals?.total} />
          <Pill label="Presente" value={totals?.presente} />
          <Pill label="Distribuído" value={totals?.distribuido} />
          <Pill label="Pendente" value={totals?.pendente} />
        </div>
      }
    >
      <button
        onClick={onSubmitChecklist}
        disabled={!selectedKitId || !canSubmit || submitting}
        style={{
          borderRadius: 12,
          padding: "12px 14px",
          fontWeight: 900,
          border: "1px solid #111",
          background: !selectedKitId || !canSubmit ? "#999" : "#111",
          color: "#fff",
          cursor: !selectedKitId || !canSubmit || submitting ? "not-allowed" : "pointer",
        }}
        title={canSubmit ? "Assinar termo e enviar checklist" : "Kit precisa estar completo e distribuído para enviar checklist."}
      >
        {submitting ? "Enviando..." : "Enviar Checklist (com termo)"}
      </button>

      <div style={{ fontSize: 12, opacity: 0.8 }}>Pendências locais (kit precisa estar íntegro para liberar o termo):</div>

      <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid #eee", borderRadius: 12 }}>
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

function DevolucoesCard({ selectedKitId, kitLabel, distributedItems, onRequestDevolucao }) {
  const totalDistribuidos = distributedItems?.length ?? 0;
  return (
    <CardShell
      title="Devoluções"
      subtitle="Você solicita. O admin encerra com PIN."
      right={<Pill label="Distribuído" value={totalDistribuidos} />}
    >
      <button
        onClick={() => onRequestDevolucao?.()}
        disabled={!selectedKitId}
        style={{
          borderRadius: 12,
          padding: "12px 14px",
          fontWeight: 900,
          border: "1px solid #111",
          background: selectedKitId ? "#fff" : "#999",
          color: selectedKitId ? "#111" : "#555",
          cursor: selectedKitId ? "pointer" : "not-allowed",
        }}
        title="Solicitar devolução do kit (fica pendente no admin até o PIN fechar o fluxo)"
      >
        Solicitar devolução do kit
      </button>

      <div style={{ fontSize: 12, opacity: 0.7 }}>
        Kit atual: <b>{kitLabel || selectedKitId || "—"}</b>
      </div>

      <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid #eee", borderRadius: 12 }}>
        {totalDistribuidos === 0 ? (
          <div style={{ padding: 12, fontSize: 12, opacity: 0.75 }}>
            Nenhum item marcado como distribuído neste kit.
          </div>
        ) : (
          distributedItems.map((x, idx) => (
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
}) {
  const renderStatus = (st) => {
    if (st?.status === "DISTRIBUIDO") {
      return (
        <span style={{ fontSize: 12, opacity: 0.85 }}>
          Distribuído • confirmação:{" "}
          <b style={{ color: st.distribuicao_confirmada ? "#0b7a38" : "#b00020" }}>
            {st.distribuicao_confirmada ? "OK" : "PENDENTE"}
          </b>
        </span>
      );
    }
    if (st?.status === "PRESENTE") {
      return <span style={{ fontSize: 12, opacity: 0.85 }}>Presente sob sua responsabilidade.</span>;
    }
    return <span style={{ fontSize: 12, opacity: 0.85 }}>Pendente</span>;
  };

  return (
    <CardShell
      title="Detalhes do kit"
      subtitle="Distribuição • Reagrupar • Solicitação de substituição."
      right={
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          Kit: <b>{kitLabel || selectedKitId || "—"}</b>
        </div>
      }
    >
      {!selectedKitId ? (
        <div style={{ padding: 10, fontSize: 12, opacity: 0.75 }}>Selecione um kit para operar.</div>
      ) : !items || items.length === 0 ? (
        <div style={{ padding: 10, fontSize: 12, opacity: 0.75 }}>Kit sem itens ou falha ao carregar.</div>
      ) : (
        <div style={{ maxHeight: 520, overflow: "auto", border: "1px solid #eee", borderRadius: 12 }}>
          {items.map((x, idx) => {
            const st = statusMap?.[x.kit_item_id] ?? {
              status: null,
              subresponsavel_text: "",
              subresponsavel_id: null,
              distribuicao_confirmada: false,
            };
            const isDistrib = st.status === "DISTRIBUIDO";

            return (
              <div
                key={x.kit_item_id}
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

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
                  <button
                    onClick={() => onSolicitarSubstituicao?.(x)}
                    disabled={!selectedKitId}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: "1px solid #111",
                      background: "#fff",
                      cursor: selectedKitId ? "pointer" : "not-allowed",
                      fontWeight: 900,
                    }}
                  >
                    Solicitar substituição
                  </button>

                  {isDistrib ? (
                    <button
                      onClick={() => onReagrupar?.(x)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid #111",
                        background: "#111",
                        color: "#fff",
                        cursor: "pointer",
                        fontWeight: 900,
                      }}
                      title="Reagrupar item distribuído ao kit"
                    >
                      Reagrupar
                    </button>
                  ) : (
                    <button
                      onClick={() => onPickSubresponsavel?.(x.kit_item_id, { id: null, nome: "" }, true)}
                      disabled={!selectedKitId || !selectedEncarregadoId}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid #111",
                        background: "#111",
                        color: "#fff",
                        cursor: !selectedKitId || !selectedEncarregadoId ? "not-allowed" : "pointer",
                        fontWeight: 900,
                      }}
                      title="Preparar distribuição (seleciona subresponsável + PIN)"
                    >
                      Distribuir
                    </button>
                  )}
                </div>

                {isDistrib ? (
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
                      onPick={({ id, nome }) => onPickSubresponsavel?.(x.kit_item_id, { id, nome }, false)}
                      onConfirmSuccess={() => onConfirmDistribuicao?.(x.kit_item_id)}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
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
  const [substModalItem, setSubstModalItem] = useState(null);
  const [substSubmitting, setSubstSubmitting] = useState(false);
  const [substObservacao, setSubstObservacao] = useState("");

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
  const [uiMsg, setUiMsg] = useState("");

  const distributedItems = useMemo(() => {
    return (kitItens ?? []).filter((x) => statusMap?.[x.kit_item_id]?.status === "DISTRIBUIDO");
  }, [kitItens, statusMap]);

  function toast(msg) {
    setUiMsg(msg);
    setTimeout(() => setUiMsg(""), 4500);
  }

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

  const adminTrailChecklists = safeArray(adminTrail?.checklists);

  const adminTrailTerms = safeArray(adminTrail?.termos).sort((a, b) => {
    const da = new Date(a?.criado_em || a?.created_at || a?.data_hora || 0).getTime();
    const db = new Date(b?.criado_em || b?.created_at || b?.data_hora || 0).getTime();
    return db - da;
  });

  const adminTrailLastTerm = adminTrailTerms[0] ?? null;
  const adminTrailOldTerms = adminTrailTerms.slice(1);

  const adminTrailMovements = safeArray(adminTrail?.movimentos);

  const adminTrailLastUpdate =
    adminTrailChecklists?.[0]?.data_hora ??
    adminTrailLastTerm?.criado_em ??
    adminTrailMovements?.[0]?.data_hora ??
    adminTrailMovements?.[0]?.created_at ??
    null;

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
            status: "PRESENTE",
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
      };

      // apenas marcar distribuído pra abrir o picker
      if (justMarkDistribuido) {
        return {
          ...prev,
          [kitItemId]: { ...cur, status: "DISTRIBUIDO" },
        };
      }

      const id = picked?.id ?? null;
      const nome = picked?.nome ?? "";

      return {
        ...prev,
        [kitItemId]: {
          ...cur,
          status: "DISTRIBUIDO",
          subresponsavel_text: nome,
          subresponsavel_id: id,
          distribuicao_confirmada: false,
        },
      };
    });
  }

  // 2) Solicitar devolução (usuário só solicita; admin encerra com PIN)
  async function handleRequestDevolucao() {
    if (!selectedKitId) return;

    const motivo = window.prompt(
      "Motivo da devolução do kit (ex: término de frente / troca de equipe / manutenção):"
    );
    if (motivo == null) return;
    const m = String(motivo).trim();
    if (!m) {
      toast("Informe o motivo da devolução.");
      return;
    }

    try {
      await apiPost("/solicitacoes/devolucao", {
        kit_id: Number(selectedKitId),
        motivo: m,
        observacao: "PWA",
      });
      toast("Solicitação de devolução enviada. Admin vai receber e encerrar com PIN.");
    } catch (e) {
      toast("Não consegui registrar no backend (endpoint de solicitação ainda não confirmado).");
      console.warn("devolucao request error:", e);
    }
  }

  // 3) Solicitar substituição (usuário só solicita + motivo; admin escolhe equivalente e valida com PIN)
  function handleSolicitarSubstituicao(item) {
    if (!selectedKitId || !item) return;
    setSubstModalItem(item);
    setSubstObservacao("");
  }

  async function submitSolicitacaoSubstituicao(motivo) {
    if (!selectedKitId || !substModalItem) return;

    if (!["MANUTENCAO", "FURTO"].includes(motivo)) return;

    setSubstSubmitting(true);
    try {
      await apiPost("/solicitacoes/substituicao", {
        kit_id: Number(selectedKitId),
        kit_item_id: Number(substModalItem.kit_item_id),
        patrimonio: String(substModalItem.patrimonio),
        motivo,
        observacao: substObservacao ? `PWA: ${substObservacao}` : "PWA",
      });
      toast("Solicitação de substituição enviada. Admin vai escolher equivalente e validar com PIN.");
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
    if (!selectedKitId || !item) return;

    const ok = window.confirm(
      `Confirma a posse do item e a reinserção no kit?\n\n${item.patrimonio} - ${item.descricao}`
    );
    if (!ok) return;

    try {
      await apiRecolher({
        kit_id: Number(selectedKitId),
        patrimonio: String(item.patrimonio),
        encarregado_id: Number(selectedEncarregadoId),
        lat: Number(geo.latitude ?? 0),
        lng: Number(geo.longitude ?? 0),
        observacao: "PWA_REAGRUPAR",
      });

      setItemStatus(item.kit_item_id, "PRESENTE");
      toast("Item reagruparado e reinserido no kit.");
    } catch (e) {
      toast(
        "Não consegui reagrupar via backend. (Pode depender de validação do admin/PIN no fluxo final.)"
      );
      console.warn("reagrupar error:", e);
    }
  }

  // 5) Avulso: solicitar uso temporário
  async function handleSolicitarAvulso(avulso) {
    const motivo = window.prompt(
      "Motivo do uso temporário (ex: serviço pontual / substituição / manutenção):"
    );
    if (motivo == null) return;
    const m = String(motivo).trim();
    if (!m) {
      toast("Informe o motivo.");
      return;
    }
    try {
      await apiPost("/solicitacoes/avulso", {
        kit_id: Number(selectedKitId) || null,
        patrimonio: String(avulso?.patrimonio ?? ""),
        motivo: m,
        observacao: "PWA",
      });
      toast("Solicitação de avulso enviada. Admin vai aprovar/encaminhar conforme regra.");
    } catch (e) {
      toast("Não consegui registrar no backend (endpoint de avulso ainda não confirmado).");
      console.warn("avulso request error:", e);
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
        <div className="user-topbar__text">
          <div className="user-topbar__title" style={{ fontWeight: 800 }}>
            {hasProfile ? (isAdmin ? "Admin" : isOperador ? "Operador" : "Usuario") : "Carregando"}
          </div>
          {roleCopy ? (
            <div className="user-topbar__subtitle" style={{ fontSize: 12, opacity: 0.8 }}>
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

            {adminTrail && (
              <div className="admin-trail-shell">
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
                                  {m.registrado_por_nome || m.encarregado_nome || m.registrado_por || "—"}
                                </td>
                                <td>{m.subresponsavel_nome || (m.admin_pin_usado ? "Admin" : "—")}</td>
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
            )}
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
            <div className="manual-list-header">
              <span className="manual-list-header__title">
                {manualLoading ? "Carregando..." : `Mostrando ${manualItens.length} itens manuais`}
              </span>
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

      <AvulsosPanel avulsos={avulsos} onSolicitarAvulso={handleSolicitarAvulso} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 16,
          marginTop: 16,
          alignItems: "stretch",
        }}
      >
        <SolicitacoesCard
          totals={totals}
          items={filtered}
          statusMap={statusMap}
          selectedKitId={selectedKitId}
          canSubmit={canSubmit}
          submitting={submitting}
          onSubmitChecklist={openChecklistTermo}
        />
        <DevolucoesCard
          kitLabel={kitLabel}
          selectedKitId={selectedKitId}
          distributedItems={distributedItems}
          onRequestDevolucao={handleRequestDevolucao}
        />
      </div>

      <DetalhesKitCard
        items={kitItens}
        statusMap={statusMap}
        geo={geo}
        selectedKitId={selectedKitId}
        kitLabel={kitLabel}
        selectedEncarregadoId={selectedEncarregadoId}
        onSolicitarSubstituicao={handleSolicitarSubstituicao}
        onReagrupar={handleReagruparItem}
        onPickSubresponsavel={handleSubresponsavelPick}
        onConfirmDistribuicao={markDistribConfirmado}
      />

      <div style={{ marginTop: 14, fontSize: 12, opacity: 0.75 }}>
        Regra: checklist confirma o kit completo e mantém o histórico dos itens distribuídos; devoluções e substituições só são fechadas pelo admin com PIN.
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
        </div>
      )}
    </div>
  );
}
