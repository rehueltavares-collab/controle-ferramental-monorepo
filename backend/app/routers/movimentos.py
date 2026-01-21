from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import SessionLocal


router = APIRouter(prefix="/movimentos", tags=["movimentos"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# noqa: E501
class DistribuirBody(BaseModel):
    kit_id: Optional[int] = None
    patrimonio: str = Field(min_length=1)
    encarregado_id: int
    subresponsavel_id: int
    pin: str = Field(min_length=6, max_length=6)

    lat: float = 0
    lng: float = 0
    accuracy_m: float = 0
    gps_timestamp: Optional[str] = None
    observacao: Optional[str] = None


class RecolherBody(BaseModel):
    kit_id: Optional[int] = None
    patrimonio: str = Field(min_length=1)
    encarregado_id: int

    lat: float = 0
    lng: float = 0
    accuracy_m: float = 0
    gps_timestamp: Optional[str] = None
    observacao: Optional[str] = None


def validate_pin(pin: str) -> None:
    if not (pin.isdigit() and len(pin) == 6):
        raise HTTPException(status_code=400, detail="PIN deve ter 6 digitos numericos")


def get_subresponsavel(db: Session, sub_id: int):
    row = db.execute(
        text(
            """
            SELECT id, nome, secao, ativo, pin
            FROM subresponsaveis
            WHERE id = :id
            """
        ),
        {"id": sub_id},
    ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Subresponsavel nao encontrado")
    if int(row["ativo"] or 0) != 1:
        raise HTTPException(status_code=400, detail="Subresponsavel inativo")
    if not row["pin"]:
        raise HTTPException(status_code=400, detail="Subresponsavel sem PIN cadastrado")
    return row


def check_pin(pin: str, pin_db: str) -> None:
    if pin != str(pin_db).strip():
        raise HTTPException(status_code=401, detail="PIN incorreto")


def get_item_id(db: Session, patrimonio: str) -> Optional[int]:
    row = db.execute(
        text("SELECT id FROM itens WHERE patrimonio = :p LIMIT 1"),
        {"p": patrimonio.strip()},
    ).first()
    return row[0] if row else None


@router.post("/distribuir")
def distribuir_item(body: DistribuirBody, db: Session = Depends(get_db)):
    validate_pin(body.pin)

    sub = get_subresponsavel(db, body.subresponsavel_id)
    check_pin(body.pin, sub["pin"])

    item_id = get_item_id(db, body.patrimonio)
    if not item_id:
        raise HTTPException(status_code=404, detail="Item nao encontrado para o patrimonio informado")

    created_at = utc_now_iso()
    gps_ts = body.gps_timestamp or created_at

    kit_id = body.kit_id if body.kit_id is not None else None

    db.execute(
        text(
            """
            INSERT INTO item_movimentos
            (data_hora, kit_id, encarregado_id, item_id, acao, subresponsavel_id,
             latitude, longitude, accuracy_m, gps_timestamp, observacao)
            VALUES
            (NOW(), :kit_id, :enc_id, :item_id, 'DISTRIBUIR', :sub_id,
             :lat, :lng, :acc, :gps_ts, :obs)
            """
        ),
        {
            "kit_id": kit_id,
            "enc_id": int(body.encarregado_id),
            "item_id": int(item_id),
            "sub_id": int(body.subresponsavel_id),
            "lat": float(body.lat or 0),
            "lng": float(body.lng or 0),
            "acc": float(body.accuracy_m or 0),
            "gps_ts": gps_ts,
            "obs": (body.observacao or "").strip() or None,
        },
    )

    db.execute(
        text(
            """
            INSERT INTO movimentos
            (tipo, kit_id, patrimonio, encarregado_id, subresponsavel_id, quantidade, observacao)
            VALUES
            ('DISTRIBUIR', :kit_id, :patrimonio, :enc_id, :sub_id, 1, :obs)
            """
        ),
        {
            "kit_id": kit_id,
            "patrimonio": body.patrimonio.strip(),
            "enc_id": int(body.encarregado_id),
            "sub_id": int(body.subresponsavel_id),
            "obs": (body.observacao or "").strip() or None,
        },
    )

    db.commit()

    return {
        "status": "ok",
        "tipo": "DISTRIBUIR",
        "kit_id": kit_id,
        "patrimonio": body.patrimonio,
        "encarregado_id": body.encarregado_id,
        "subresponsavel_id": body.subresponsavel_id,
        "subresponsavel_nome": sub["nome"],
        "lat": float(body.lat or 0),
        "lng": float(body.lng or 0),
        "accuracy_m": float(body.accuracy_m or 0),
        "gps_timestamp": gps_ts,
        "created_at": created_at,
    }


@router.post("/recolher")
def recolher_item(body: RecolherBody, db: Session = Depends(get_db)):
    item_id = get_item_id(db, body.patrimonio)
    if not item_id:
        raise HTTPException(status_code=404, detail="Item nao encontrado para o patrimonio informado")

    created_at = utc_now_iso()
    gps_ts = body.gps_timestamp or created_at

    kit_id = body.kit_id if body.kit_id is not None else None

    db.execute(
        text(
            """
            INSERT INTO item_movimentos
            (data_hora, kit_id, encarregado_id, item_id, acao, subresponsavel_id,
             latitude, longitude, accuracy_m, gps_timestamp, observacao)
            VALUES
            (NOW(), :kit_id, :enc_id, :item_id, 'RECOLHER', NULL,
             :lat, :lng, :acc, :gps_ts, :obs)
            """
        ),
        {
            "kit_id": kit_id,
            "enc_id": int(body.encarregado_id),
            "item_id": int(item_id),
            "lat": float(body.lat or 0),
            "lng": float(body.lng or 0),
            "acc": float(body.accuracy_m or 0),
            "gps_ts": gps_ts,
            "obs": (body.observacao or "").strip() or None,
        },
    )

    db.execute(
        text(
            """
            INSERT INTO movimentos
            (tipo, kit_id, patrimonio, encarregado_id, subresponsavel_id, quantidade, observacao)
            VALUES
            ('RECOLHER', :kit_id, :patrimonio, :enc_id, NULL, 1, :obs)
            """
        ),
        {
            "kit_id": kit_id,
            "patrimonio": body.patrimonio.strip(),
            "enc_id": int(body.encarregado_id),
            "obs": (body.observacao or "").strip() or None,
        },
    )

    db.commit()

    return {
        "status": "ok",
        "tipo": "RECOLHER",
        "kit_id": kit_id,
        "patrimonio": body.patrimonio,
        "encarregado_id": body.encarregado_id,
        "lat": float(body.lat or 0),
        "lng": float(body.lng or 0),
        "accuracy_m": float(body.accuracy_m or 0),
        "gps_timestamp": gps_ts,
        "created_at": created_at,
    }
