const BASE = import.meta.env.VITE_API_URL;

function norm(path) {
  if (!path.startsWith("/")) path = `/${path}`;
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
