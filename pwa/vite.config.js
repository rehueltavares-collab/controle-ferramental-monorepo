import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

const host = '0.0.0.0'

// tenta habilitar HTTPS se os arquivos existirem
const certPath = path.resolve(__dirname, '192.168.0.130.pem')
const keyPath  = path.resolve(__dirname, '192.168.0.130-key.pem')
const hasHttps = fs.existsSync(certPath) && fs.existsSync(keyPath)

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port: 5173,
    strictPort: true,
    // se tiver cert, liga https. se não, fica http (rede também)
    https: false,
  },
})

