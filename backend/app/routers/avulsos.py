from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import SessionLocal

router = APIRouter(prefix="/avulsos", tags=["Avulsos"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_itens_columns(db: Session) -> None:
    try:
        db.execute(text("ALTER TABLE itens ADD COLUMN disponivel INT NOT NULL DEFAULT 1"))
    except Exception:
        pass
    db.commit()


class AvulsoItemOut(BaseModel):
    id: int
    patrimonio: str
    descricao: str


class RetirarAvulsoIn(BaseModel):
    encarregado_id: int
    patrimonio: str
    quantidade: int = 1
    observacao: Optional[str] = None


@router.get("", response_model=List[AvulsoItemOut])
def listar_avulsos(db: Session = Depends(get_db)):
    ensure_itens_columns(db)
    q = text("""
        SELECT i.id, i.patrimonio, i.descricao
        FROM itens i
        LEFT JOIN kit_itens ki ON ki.item_id = i.id
        WHERE ki.item_id IS NULL
          AND i.ativo = 1
          AND i.disponivel = 1
        ORDER BY i.descricao, i.patrimonio
    """)
    rows = db.execute(q).mappings().all()
    return [dict(r) for r in rows]


@router.post("/retirar")
def retirar_avulso(payload: RetirarAvulsoIn, db: Session = Depends(get_db)):
    ensure_itens_columns(db)
    q_item = text("""
        SELECT i.id, i.patrimonio, i.descricao
        FROM itens i
        LEFT JOIN kit_itens ki ON ki.item_id = i.id
        WHERE i.patrimonio = :patrimonio
          AND i.ativo = 1
          AND ki.item_id IS NULL
          AND i.disponivel = 1
        LIMIT 1
    """)
    item = db.execute(q_item, {"patrimonio": payload.patrimonio}).mappings().first()
    if not item:
        raise HTTPException(status_code=404, detail="Avulso não encontrado (ou está em kit / inativo).")

    q_mov = text("""
        INSERT INTO movimentos (tipo, kit_id, patrimonio, encarregado_id, subresponsavel_id, manual_item_id, quantidade, observacao)
        VALUES ('MANUAL_ENTREGAR', NULL, :patrimonio, :encarregado_id, NULL, NULL, :quantidade, :observacao)
    """)
    db.execute(q_mov, {
        "patrimonio": payload.patrimonio,
        "encarregado_id": payload.encarregado_id,
        "quantidade": payload.quantidade,
        "observacao": payload.observacao or "Retirada avulso para acervo"
    })
    db.execute(
        text("UPDATE itens SET disponivel = 0 WHERE id = :id"),
        {"id": item["id"]},
    )
    db.commit()

    return {
        "ok": True,
        "patrimonio": payload.patrimonio,
        "encarregado_id": payload.encarregado_id
    }


@router.get("/minha")
def meus_avulsos(encarregado_id: int, db: Session = Depends(get_db)):
    q = text("""
        SELECT i.id AS item_id, i.patrimonio, i.descricao, last.tipo AS ultimo_tipo, last.created_at
        FROM itens i
        LEFT JOIN kit_itens ki ON ki.item_id = i.id
        JOIN (
          SELECT m1.*
          FROM movimentos m1
          JOIN (
            SELECT patrimonio, MAX(created_at) AS last_dt
            FROM movimentos
            WHERE kit_id IS NULL AND patrimonio IS NOT NULL
            GROUP BY patrimonio
          ) t ON t.patrimonio = m1.patrimonio AND t.last_dt = m1.created_at
        ) last ON last.patrimonio = i.patrimonio
        WHERE ki.item_id IS NULL
          AND i.ativo = 1
          AND last.encarregado_id = :encarregado_id
          AND last.tipo IN ('MANUAL_ENTREGAR','RECOLHER')
        ORDER BY last.created_at DESC
    """)
    rows = db.execute(q, {"encarregado_id": encarregado_id}).mappings().all()
    return [dict(r) for r in rows]
