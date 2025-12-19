from fastapi import APIRouter, Query
import sqlite3

DB_PATH = "ferramental.db"
router = APIRouter(prefix="/status", tags=["status"])

@router.get("/kit/{kit_id}")
def status_kit(kit_id: int):
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    # último movimento por patrimonio (no kit)
    cur.execute(
        """
        SELECT m1.*
        FROM item_movimentos m1
        JOIN (
          SELECT patrimonio, MAX(id) AS max_id
          FROM item_movimentos
          WHERE kit_id=?
          GROUP BY patrimonio
        ) t
        ON t.patrimonio = m1.patrimonio AND t.max_id = m1.id
        WHERE m1.kit_id=?
        ORDER BY m1.patrimonio
        """,
        (kit_id, kit_id),
    )

    rows = [dict(r) for r in cur.fetchall()]
    con.close()
    return rows
