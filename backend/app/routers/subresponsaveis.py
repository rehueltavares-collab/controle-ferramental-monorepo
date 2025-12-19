from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
import sqlite3

from ..utils.security import hash_pin

DB_PATH = "ferramental.db"

router = APIRouter(prefix="/subresponsaveis", tags=["subresponsaveis"])

class SubresponsavelOut(BaseModel):
    id: int
    nome: str
    secao: Optional[str] = None
    ativo: int

class DefinirPinIn(BaseModel):
    pin: str

@router.get("", response_model=List[SubresponsavelOut])
def listar(query: str = Query(default="", description="busca por nome")):
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    q = query.strip().upper()
    if q:
        cur.execute(
            """
            SELECT id, nome, secao, ativo
            FROM subresponsaveis
            WHERE ativo=1 AND nome LIKE ?
            ORDER BY nome
            LIMIT 50
            """,
            (f"%{q}%",),
        )
    else:
        cur.execute(
            """
            SELECT id, nome, secao, ativo
            FROM subresponsaveis
            WHERE ativo=1
            ORDER BY nome
            LIMIT 50
            """
        )

    rows = [dict(r) for r in cur.fetchall()]
    con.close()
    return rows

@router.post("/{sub_id}/definir-pin")
def definir_pin(sub_id: int, body: DefinirPinIn):
    pin = body.pin.strip()
    if not pin.isdigit() or len(pin) != 6:
        raise HTTPException(status_code=400, detail="PIN deve ter 6 dígitos numéricos")

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    cur.execute("SELECT id FROM subresponsaveis WHERE id=?", (sub_id,))
    if not cur.fetchone():
        con.close()
        raise HTTPException(status_code=404, detail="Subresponsável não encontrado")

    cur.execute("UPDATE subresponsaveis SET pin_hash=? WHERE id=?", (hash_pin(pin), sub_id))
    con.commit()
    con.close()

    return {"ok": True}
