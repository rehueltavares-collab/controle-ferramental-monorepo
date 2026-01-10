# AI Coding Agent Instructions

## Project Overview

**Controle Ferramental** is a monorepo tool management system for tracking and managing tool kits across facility sectors. It consists of:

- **Backend**: FastAPI Python REST API with SQLAlchemy ORM (SQLite/MariaDB compatible)
- **Frontend**: React 19 + Vite PWA with offline support
- **Purpose**: Track tool distribution, inventory, movements, and accountability by sector and personnel

## Architecture

### Backend Structure (`backend/app/`)
- **main.py**: FastAPI app setup, CORS config for LAN/mobile access, main route handlers
- **models.py**: SQLAlchemy ORM models (Setor, Kit, Item, Encarregado, Subresponsavel, ItemMovimento, ChecklistSemanal)
- **schemas.py**: Pydantic validators for request/response serialization
- **database.py**: SQLAlchemy engine, session management, supports SQLite (dev) and DATABASE_URL env var for MariaDB
- **routers/**: Modular API endpoints
  - `movimentos.py`: Manual inventory adjustments with audit logging
  - `subresponsaveis.py`: Tool holder management
  - `encarregados.py`, `kits.py`, `setores.py`, `status.py`: Core CRUD endpoints

### Frontend Structure (`pwa/src/`)
- **App.jsx**: Main component handling UI logic, inventory distribution, tool tracking
- **services/api.js**: Centralized API client with retry logic and VITE_API_URL environment variable
- Uses `norm()` helper to normalize paths (adds trailing slash automatically)

### Data & Database
- Default SQLite: `backend/data/ferramental.db`
- Seed data: `data/fontes/itens_ferramental_utf8.csv`
- Environment override: Set `DATABASE_URL` for MariaDB in production

## Key Patterns

### API Response Format
Backend uses inconsistent response formats—normalize client-side with `safeArray()`:
```javascript
// Frontend helper (in App.jsx)
function safeArray(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.value)) return res.value;
  return [];
}
```

Some endpoints return `{value: [...], Count: N}`, others return `[...]` directly.

### Database Connection
- **SQLAlchemy routers** (e.g., `encarregados.py`): Use `get_db()` dependency injection
- **Raw SQLite routers** (e.g., `movimentos.py`): Direct `sqlite3` connection for audit logging flexibility
- Path resolution uses `Path(__file__).resolve().parents[3]` to locate monorepo root

### CORS & Network Access
Frontend expects API at `http://localhost:8000` in dev. CORS allows:
- localhost:5173 (Vite default), localhost:5174
- 192.168.1.108:5173 (LAN access for mobile/tablets)
- Regex fallback: Any `http://192.168.x.x:*` for dynamic LAN IPs

### Frontend Utilities
- `norm(s)`: Diacritic-insensitive string normalization for search
- `withRetry(fn, tries=2, delayMs=500)`: Resilient async operations
- `nowISO()`: UTC timestamp generation
- `sleep(ms)`: Promise-based delay utility

## Development Workflow

### Starting Dev Environment
Run `start-dev.ps1` (Windows Terminal) to launch:
1. Backend: `uvicorn app.main:app --host 0.0.0.0 --port 8000`
2. Frontend: `npm run dev -- --host 0.0.0.0 --port 5173`
3. Additional tabs for tests and scripting

Ensure `.venv` is activated and `backend/requirements.txt` installed.

### Environment Setup
- Python 3.10+ with FastAPI 0.128+, SQLAlchemy 2.0+, Uvicorn
- Node.js 18+ for Vite & React 19
- Set `DATABASE_URL` for non-SQLite databases (auto-creates tables via `Base.metadata.create_all()`)

### Scripts
- `backend/scripts/import_seed_mariadb.py`: Populate database from CSV seed data
- `backend/reset_kits.py`: Utility for test data management
- Legacy imports: `backend/scripts/legacy_app_imports/` (data migration helpers)

## Important Conventions

1. **Endpoint Naming**: Prefix routes in routers (`router = APIRouter(prefix="/endpoint")`) rather than repeating in functions
2. **Error Handling**: Frontend retries with exponential backoff; backend returns 4xx/5xx status codes
3. **Timestamps**: Use `datetime.utcnow()` in models, ISO format strings in API responses
4. **Audit Trail**: Manual movements stored in raw SQLite for immutable audit logging
5. **Field Normalization**: Frontend normalizes accent-sensitive searches; backend stores as-is

## When Adding Features

- New CRUD endpoints: Create schema in `schemas.py`, model in `models.py`, router in `routers/new_feature.py`, register in `main.py`
- UI state: Check existing App.jsx patterns (useState, useMemo, withRetry for API calls)
- Database migrations: Modify models.py; `create_all()` in main.py handles dev. For production, use proper migration tools (Alembic recommended)
- Cross-origin requests: Update CORS allowlist in main.py if adding new frontend hosts

## Testing & Debugging

- Backend unit tests: Create in `backend/tests/` (use pytest)
- Frontend: React DevTools + Network tab for API debugging
- Database: Use direct SQLite queries (`sqlite3 backend/data/ferramental.db`) for audit logs
- Network debugging: CORS errors indicate frontend URL not in allowlist; check main.py CORSMiddleware config
