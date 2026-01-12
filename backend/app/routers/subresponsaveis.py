from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import SessionLocal


router = APIRouter(prefix="/subresponsaveis", tags=["subresponsaveis"])


class SubresponsavelOut(BaseModel):
    id: int
    nome: str
    secao: Optional[str] = None
    ativo: int


class DefinirPinIn(BaseModel):
    pin: str


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("", response_model=List[SubresponsavelOut])
def listar(query: str = Query(default="", description="busca por nome"), db: Session = Depends(get_db)):
    q = query.strip()
    if q:
        rows = db.execute(
            text(
                """
                SELECT id, nome, secao, ativo
                FROM subresponsaveis
                WHERE ativo=1 AND nome LIKE :q
                ORDER BY nome
                LIMIT 50
                """
            ),
            {"q": f"%{q}%"},
        ).mappings().all()
    else:
        rows = db.execute(
            text(
                """
                SELECT id, nome, secao, ativo
                FROM subresponsaveis
                WHERE ativo=1
                ORDER BY nome
                LIMIT 50
                """
            )
        ).mappings().all()

    return [SubresponsavelOut(**r) for r in rows]


@router.post("/{sub_id}/definir-pin")
def definir_pin(sub_id: int, body: DefinirPinIn, db: Session = Depends(get_db)):
    pin = body.pin.strip()
    if not pin.isdigit() or len(pin) != 6:
        raise HTTPException(status_code=400, detail="PIN deve ter 6 digitos numericos")

    row = db.execute(
        text("SELECT id FROM subresponsaveis WHERE id=:id"),
        {"id": sub_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Subresponsavel nao encontrado")

    db.execute(
        text("UPDATE subresponsaveis SET pin=:pin WHERE id=:id"),
        {"pin": pin, "id": sub_id},
    )
    db.commit()

    return {"ok": True}
