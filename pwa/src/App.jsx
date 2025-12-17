import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "./services/api";

const endpoints = [
  { key: "root", label: "Root (/)", path: "/" },

  { key: "itens_list", label: "GET Itens (/itens/)", method: "GET", path: "/itens/" },
  { key: "itens_post", label: "POST Itens (/itens/)", method: "POST", path: "/itens/" },

  { key: "setores_list", label: "GET Setores (/setores/)", method: "GET", path: "/setores/" },
  { key: "setores_post", label: "POST Setores (/setores/)", method: "POST", path: "/setores/" },

  { key: "enc_list", label: "GET Encarregados (/encarregados/)", method: "GET", path: "/encarregados/" },
  { key: "enc_post", label: "POST Encarregados (/encarregados/)", method: "POST", path: "/encarregados/" },

  { key: "kits_list", label: "GET Kits (/kits/)", method: "GET", path: "/kits/" },
  { key: "kits_post", label: "POST Kits (/kits/)", method: "POST", path: "/kits/" },

  { key: "check_list", label: "GET Checklists semanais (/checklists-semanais/)", method: "GET", path: "/checklists-semanais/" },
  { key: "check_post", label: "POST Checklists semanais (/checklists-semanais/)", method: "POST", path: "/checklists-semanais/" },
];

function pretty(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

const examplesByPath = {
  "/itens/": { patrimonio: "PX-0001", descricao: "Furadeira Bosch" },
  "/setores/": { nome: "Almoxarifado" },
  "/encarregados/": { setor_id: 1, funcao: "Encarregado", nome: "João", telefone: "21999999999" },
  "/kits/": { nome: "Kit Elétrica", setor_id: 1, tipo: "Obra" },
  "/checklists-semanais/": {
    kit_id: 1,
    encarregado_id: 1,
    latitude: 0,
    longitude: 0,
    patrimonios_declarados: "PX-0001, PX-0002",
  },
};

export default function App() {
  const apiBase = import.meta.env.VITE_API_URL;

  const [selected, setSelected] = useState(endpoints[1].path);
  const [method, setMethod] = useState("GET");

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  const selectedEndpoint = useMemo(() => {
    // pega o primeiro endpoint que bate o path e deixa o method coerente
    const found = endpoints.find((e) => e.path === selected && e.method === method) ||
                  endpoints.find((e) => e.path === selected) ||
                  endpoints[0];
    return found;
  }, [selected, method]);

  const selectedLabel = useMemo(() => selectedEndpoint.label, [selectedEndpoint]);

  const [payloadText, setPayloadText] = useState(() => {
    const ex = examplesByPath[selected] || {};
    return pretty(ex);
  });

  useEffect(() => {
    setMethod(selectedEndpoint.method || "GET");

    const ex = examplesByPath[selectedEndpoint.path] || {};
    // só troca payload automaticamente se for POST (pra evitar irritar no GET)
    if ((selectedEndpoint.method || "GET") === "POST") setPayloadText(pretty(ex));
  }, [selectedEndpoint]);

  async function run() {
    setLoading(true);
    setErr("");
    setData(null);

    try {
      const m = selectedEndpoint.method || "GET";
      const p = selectedEndpoint.path;

      if (m === "POST") {
        let body;
        try {
          body = JSON.parse(payloadText || "{}");
        } catch {
          throw new Error("Payload JSON inválido. Corrige e tenta de novo.");
        }
        const res = await apiPost(p, body);
        setData(res);
      } else {
        const res = await apiGet(p);
        setData(res);
      }
    } catch (e) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 20, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 4 }}>Controle de Ferramental — PWA</h1>
      <div style={{ opacity: 0.7, marginBottom: 16 }}>
        API: <b>{apiBase}</b>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          Endpoint
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{ padding: 8, minWidth: 360 }}
          >
            {Array.from(new Set(endpoints.map((e) => e.path))).map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          Método
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            style={{ padding: 8, minWidth: 160 }}
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
          </select>
        </label>

        <div style={{ display: "flex", alignItems: "end", gap: 10 }}>
          <button
            onClick={run}
            disabled={loading}
            style={{ padding: "10px 14px", cursor: loading ? "not-allowed" : "pointer" }}
          >
            {loading ? "Executando..." : "Executar"}
          </button>

          <span style={{ opacity: 0.8 }}>{selectedLabel}</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14 }}>
          <h3 style={{ marginTop: 0 }}>Payload (POST)</h3>
          <div style={{ opacity: 0.7, marginBottom: 10 }}>
            Use JSON. Se estiver em GET, pode ignorar.
          </div>
          <textarea
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            rows={16}
            style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", padding: 10 }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button
              onClick={() => setPayloadText(pretty(examplesByPath[selectedEndpoint.path] || {}))}
              style={{ padding: "8px 12px" }}
            >
              Carregar exemplo
            </button>
            <button onClick={() => setPayloadText("{}")} style={{ padding: "8px 12px" }}>
              Limpar
            </button>
          </div>
        </div>

        <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14 }}>
          <h3 style={{ marginTop: 0 }}>Resposta</h3>

          {err ? (
            <div style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
              ERRO: {err}
            </div>
          ) : (
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {data === null ? "Sem dados ainda. Clique em Executar." : pretty(data)}
            </pre>
          )}
        </div>
      </div>

      <div style={{ marginTop: 18, opacity: 0.7, fontSize: 13 }}>
        Dica: POST cria registros; GET lista. O Swagger continua útil, mas agora você faz tudo pelo PWA.
      </div>
    </div>
  );
}
