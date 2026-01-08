import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";

const host = "0.0.0.0";

// tenta habilitar HTTPS se os arquivos existirem
const certPath = path.resolve(__dirname, "192.168.0.130.pem");
const keyPath = path.resolve(__dirname, "192.168.0.130-key.pem");
const hasHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);

export default defineConfig({
  plugins: [react()],

  server: {
    host,
    port: 5173,
    strictPort: true,

    // ✅ resolve: "Blocked request. This host is not allowed."
    // Libera hosts que você vai usar via DNS/hosts file.
    // Dica: pode manter isso bem restrito.
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      "ferramental.perfilx.corp",
      // se quiser separar API por subdomínio no futuro:
      "api-ferramental.perfilx.corp",
      // libera também acesso direto por IP (se alguém insistir em usar)
      "192.168.0.130",
      "192.168.0.164",
    ],

    // se tiver cert, liga https. se não, fica http
    https: hasHttps
      ? {
          cert: fs.readFileSync(certPath),
          key: fs.readFileSync(keyPath),
        }
      : false,
  },
});
