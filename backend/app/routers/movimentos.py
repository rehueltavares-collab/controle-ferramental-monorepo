from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

# Usa as funções de segurança que você já tem
# (hash_pin / verify_pin). Se seu utils/security.py não tiver verify_pin,
# eu já tratei isso com fallback (mensagem clara).
try:
    from ..utils.security import verify_pin  # type: ignore
except Exception:  # pragma: no cover
    verify_pin = None  # fallback tratado abaixo


router = APIRouter(prefix="/movimentos", tags=["movimentos"])


# =========================
# DB helpers
# =========================

def _db_path() -> Path:
    # .../backend/app/routers/movimentos.py -> project root é parents[3]
    return Path(__file__).resolve().parents[3] / "ferramental.db"


def _connect() -> sqlite3.Connection:
    con = sqlite3.connect(str(_db_path()))
    con.row_factory = sqlite3.Row
    return con


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_schema() -> None:
    """
    Garante tabela item_movimentos e colunas extras para auditoria.
    Não quebra se já existir sem as colunas; tenta ALTER e ignora erro.
    """
    con = _connect()
    cur = con.cursor()

    # Tabela base (se não existir)
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS item_movimentos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kit_id INTEGER NOT NULL,
            patrimonio TEXT NOT NULL,
            tipo TEXT NOT NULL, -- DISTRIBUIR | RECOLHER
            encarregado_id INTEGER NOT NULL,
            subresponsavel_id INTEGER,
            created_at TEXT NOT NULL
        );
        """
    )

    # Colunas extras (tentativa “best effort”)
    for stmt in [
        "ALTER TABLE item_movimentos ADD COLUMN lat REAL DEFAULT 0",
        "ALTER TABLE item_movimentos ADD COLUMN lng REAL DEFAULT 0",
        "ALTER TABLE item_movimentos ADD COLUMN accuracy_m REAL DEFAULT 0",
        "ALTER TABLE item_movimentos ADD COLUMN gps_timestamp TEXT",
        "ALTER TABLE item_movimentos ADD COLUMN gps_ok INTEGER DEFAULT 0",
        "ALTER TABLE item_movimentos ADD COLUMN observacao TEXT",
    ]:
        try:
            cur.execute(stmt)
        except sqlite3.OperationalError:
            # coluna já existe (ou SQLite antigo); ignora
            pass

    con.commit()
    con.close()


# roda ao importar o router
_ensure_schema()


# =========================
# Models (payloads)
# =========================

class DistribuirBody(BaseModel):
    kit_id: int
    patrimonio: str = Field(min_length=1)
    encarregado_id: int
    subresponsavel_id: int
    pin: str = Field(min_length=6, max_length=6)

    lat: float = 0
    lng: float = 0
    accuracy_m: float = 0  # obrigatório no seu schema anterior: aqui garantido sempre
    gps_timestamp: Optional[str] = None
    observacao: Optional[str] = None


class RecolherBody(BaseModel):
    kit_id: int
    patrimonio: str = Field(min_length=1)
    encarregado_id: int

    lat: float = 0
    lng: float = 0
    accuracy_m: float = 0
    gps_timestamp: Optional[str] = None
    observacao: Optional[str] = None


# =========================
# Util validações
# =========================

def _validate_pin(pin: str) -> None:
    if not (pin.isdigit() and len(pin) == 6):
        raise HTTPException(status_code=400, detail="PIN deve ter 6 dígitos numéricos")


def _get_subresponsavel(con: sqlite3.Connection, sub_id: int) -> sqlite3.Row:
    cur = con.cursor()
    row = cur.execute(
        "SELECT id, nome, secao, ativo, pin_hash FROM subresponsaveis WHERE id=?",
        (sub_id,),
    ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Subresponsável não encontrado")

    if int(row["ativo"] or 0) != 1:
        raise HTTPException(status_code=400, detail="Subresponsável inativo")

    if not row["pin_hash"]:
        raise HTTPException(status_code=400, detail="Subresponsável sem PIN cadastrado")

    return row


def _check_pin(pin: str, pin_hash: str) -> None:
    """
    Verifica PIN com o verify_pin do utils/security.py.
    Se o verify_pin não existir, dá erro orientando.
    """
    if verify_pin is None:
        raise HTTPException(
            status_code=500,
            detail="verify_pin não encontrado em utils/security.py. Implemente verify_pin(pin, pin_hash).",
        )

    try:
        ok = bool(verify_pin(pin, pin_hash))
    except Exception as e:
        # erro típico: passlib/bcrypt quebrado
        raise HTTPException(
            status_code=500,
            detail=f"Falha ao validar PIN (biblioteca de hash). Erro: {type(e).__name__}: {e}",
        )

    if not ok:
        raise HTTPException(status_code=401, detail="PIN incorreto")


# =========================
# Endpoints
# =========================

@router.post("/distribuir")
def distribuir_item(body: DistribuirBody):
    """
    Registra um movimento DISTRIBUIR.
    - NÃO bloqueia se GPS vier 0,0 (desktop/ambiente sem permissão).
    - Mantém auditável: gps_ok = 1 quando lat/lng != 0.
    """
    _validate_pin(body.pin)

    con = _connect()
    try:
        sub = _get_subresponsavel(con, body.subresponsavel_id)
        _check_pin(body.pin, sub["pin_hash"])

        gps_ok = 0 if (float(body.lat) == 0.0 and float(body.lng) == 0.0) else 1

        created_at = _utc_now_iso()
        gps_ts = body.gps_timestamp or created_at

        cur = con.cursor()
        cur.execute(
            """
            INSERT INTO item_movimentos
            (kit_id, patrimonio, tipo, encarregado_id, subresponsavel_id, created_at,
             lat, lng, accuracy_m, gps_timestamp, gps_ok, observacao)
            VALUES
            (?, ?, 'DISTRIBUIR', ?, ?, ?,
             ?, ?, ?, ?, ?, ?)
            """,
            (
                int(body.kit_id),
                body.patrimonio.strip(),
                int(body.encarregado_id),
                int(body.subresponsavel_id),
                created_at,
                float(body.lat or 0),
                float(body.lng or 0),
                float(body.accuracy_m or 0),
                gps_ts,
                int(gps_ok),
                (body.observacao or "").strip() or None,
            ),
        )
        con.commit()

        mov_id = cur.lastrowid

        return {
            "status": "ok",
            "movimento_id": mov_id,
            "tipo": "DISTRIBUIR",
            "kit_id": body.kit_id,
            "patrimonio": body.patrimonio,
            "encarregado_id": body.encarregado_id,
            "subresponsavel_id": body.subresponsavel_id,
            "subresponsavel_nome": sub["nome"],
            "gps_ok": bool(gps_ok),
            "lat": float(body.lat or 0),
            "lng": float(body.lng or 0),
            "accuracy_m": float(body.accuracy_m or 0),
            "gps_timestamp": gps_ts,
            "created_at": created_at,
        }
    finally:
        con.close()


@router.post("/recolher")
def recolher_item(body: RecolherBody):
    """
    Registra um movimento RECOLHER.
    - Não exige PIN.
    - Não bloqueia GPS 0,0.
    """
    con = _connect()
    try:
        gps_ok = 0 if (float(body.lat) == 0.0 and float(body.lng) == 0.0) else 1

        created_at = _utc_now_iso()
        gps_ts = body.gps_timestamp or created_at

        cur = con.cursor()
        cur.execute(
            """
            INSERT INTO item_movimentos
            (kit_id, patrimonio, tipo, encarregado_id, subresponsavel_id, created_at,
             lat, lng, accuracy_m, gps_timestamp, gps_ok, observacao)
            VALUES
            (?, ?, 'RECOLHER', ?, NULL, ?,
             ?, ?, ?, ?, ?, ?)
            """,
            (
                int(body.kit_id),
                body.patrimonio.strip(),
                int(body.encarregado_id),
                created_at,
                float(body.lat or 0),
                float(body.lng or 0),
                float(body.accuracy_m or 0),
                gps_ts,
                int(gps_ok),
                (body.observacao or "").strip() or None,
            ),
        )
        con.commit()

        mov_id = cur.lastrowid

        return {
            "status": "ok",
            "movimento_id": mov_id,
            "tipo": "RECOLHER",
            "kit_id": body.kit_id,
            "patrimonio": body.patrimonio,
            "encarregado_id": body.encarregado_id,
            "gps_ok": bool(gps_ok),
            "lat": float(body.lat or 0),
            "lng": float(body.lng or 0),
            "accuracy_m": float(body.accuracy_m or 0),
            "gps_timestamp": gps_ts,
            "created_at": created_at,
        }
    finally:
        con.close()
