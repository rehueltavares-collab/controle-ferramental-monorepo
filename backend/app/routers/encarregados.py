from fastapi import APIRouter
import sqlite3
from pathlib import Path

router = APIRouter(prefix="/encarregados", tags=["encarregados"])

def _db():
    return sqlite3.connect(
        Path(__file__).resolve().parents[3] / "ferramental.db"
    )

@router.get("/")
def listar_encarregados():
    con = _db()
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    rows = cur.execute("""
        SELECT id, nome
        FROM encarregados
        ORDER BY nome
    """).fetchall()

    con.close()
    return [dict(r) for r in rows]
