# DEV SETUP — Controle Ferramental (PWA + Backend)

## 1. Pré-requisitos
- Instale o `mkcert`: https://github.com/FiloSottile/mkcert
- Registre a CA local: `mkcert -install`
- Crie certificados para os domínios em uso:

  ```powershell
  cd pwa
  mkcert -key-file certs\ferramental.local+3-key.pem -cert-file certs\ferramental.local+3.pem ferramental.local api-ferramental.local localhost
  ```

## 2. Copiar certificados
- Copie os arquivos gerados para o backend (sem versionar):

  ```powershell
  copy pwa\certs\ferramental.local+3*.pem backend\certs\
  ```

  > Os arquivos `.pem` **não entram no Git**; o `.gitignore` cobre `**/certs/*`, `*.pem`, `*-key.pem`.

## 3. Variáveis de ambiente
- `pwa/.env` e `pwa/.env.local` devem conter:

  ```
  VITE_API_URL=https://api-ferramental.local:8000
  ```

- `backend/.env` já deve definir `JWT_SECRET`, `CORS_ORIGINS`, `DB_*`, etc. Atualize conforme necessário.

## 4. Rodar backend (PowerShell)

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 `
  --ssl-certfile ".\certs\ferramental.local+3.pem" `
  --ssl-keyfile ".\certs\ferramental.local+3-key.pem"
```

## 5. Rodar frontend (PowerShell)

```powershell
cd pwa
npm install
npm run dev -- --host 0.0.0.0
```

## 6. Linux/macOS (opcional)

- Gere os mesmos certificados com `mkcert` e copie para `backend/certs` e `pwa/certs`.
- Substitua o `.\.venv\Scripts\Activate.ps1` e `copy` por equivalentes bash (`source .venv/bin/activate`, `cp`).

## 7. Validação rápida

- Abra `https://ferramental.local:5173` (o navegador confia no cert emitido pelo `mkcert`).
- Limpe localStorage/sessionStorage se trocar de usuário (`localStorage.clear(); sessionStorage.clear(); location.reload();`).
- Login disponível: `rehuel / abc123` (admin/usuario conforme já configurado).

## 8. Observações

- Os certificados permanecem fora do Git. O arquivo `docs/DEV_SETUP.md` documenta como gerar / posicionar localmente para cada dev.
- Se precisar de outros domínios (`ferramentas.perfilx.com.br`, `api.ferramentas.perfilx.com.br`), repita o `mkcert` com os novos nomes.
