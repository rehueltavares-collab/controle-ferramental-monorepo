from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import SessionLocal
from .. import models, schemas

router = APIRouter(prefix="/subresponsaveis")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("", response_model=List[schemas.Subresponsavel])
def listar(query: str = "", db: Session = Depends(get_db)):
    q = (query or "").strip()
    qry = db.query(models.Subresponsavel)

    if q:
        like = f"%{q}%"
        qry = qry.filter(models.Subresponsavel.nome.ilike(like))

    return qry.order_by(models.Subresponsavel.nome.asc()).limit(30).all()


@router.post("/{sub_id}/definir-pin")
def definir_pin(sub_id: int, payload: schemas.DefinirPinRequest, db: Session = Depends(get_db)):
    pin = (payload.pin or "").strip()
    if (not pin.isdigit()) or len(pin) != 6:
        raise HTTPException(status_code=400, detail="PIN inválido. Use 6 dígitos numéricos.")

    sub = db.query(models.Subresponsavel).filter(models.Subresponsavel.id == sub_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Subresponsável não encontrado.")

    sub.pin = pin
    db.commit()
    return {"ok": True}
