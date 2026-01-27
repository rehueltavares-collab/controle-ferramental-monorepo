from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..utils.security import hash_pin


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


def ensure_pin_hash_column(db: Session) -> None:
    try:
        db.execute(text("ALTER TABLE subresponsaveis ADD COLUMN pin_hash TEXT NULL"))
    except Exception:
        pass
    rows = db.execute(
        text("SELECT id, pin FROM subresponsaveis WHERE pin_hash IS NULL AND pin IS NOT NULL")
    ).mappings().all()
    for row in rows:
        try:
            db.execute(
                text("UPDATE subresponsaveis SET pin_hash=:ph, pin=NULL WHERE id=:id"),
                {"ph": hash_pin(str(row["pin"]).strip()), "id": row["id"]},
            )
        except Exception:
            pass
    db.commit()


@router.get("", response_model=List[SubresponsavelOut])
def listar(query: str = Query(default="", description="busca por nome"), db: Session = Depends(get_db)):
    ensure_pin_hash_column(db)
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
    ensure_pin_hash_column(db)
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
        text("UPDATE subresponsaveis SET pin_hash=:ph, pin=NULL WHERE id=:id"),
        {"ph": hash_pin(pin), "id": sub_id},
    )
    db.commit()

    return {"ok": True}
