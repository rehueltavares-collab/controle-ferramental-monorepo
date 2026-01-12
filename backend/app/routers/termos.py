from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..core.auth import get_db, get_current_token, get_user_row

router = APIRouter(prefix="/termos", tags=["Termos"])


class TermoCreate(BaseModel):
    tipo: str
    referencia_tipo: str
    referencia_id: int
    texto_termo: str
    assinatura_nome: str
    assinatura_imagem: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class TermoOut(BaseModel):
    id: int
    user_id: int
    subresponsavel_id: Optional[int] = None
    tipo: str
    referencia_tipo: str
    referencia_id: int
    texto_termo: str
    assinatura_nome: str
    assinatura_imagem: Optional[str] = None
    ip: Optional[str] = None
    user_agent: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    criado_em: datetime


@router.post("/", response_model=TermoOut)
def criar_termo(
    body: TermoCreate,
    request: Request,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    if body.tipo not in ("RETIRADA", "DEVOLUCAO"):
        raise HTTPException(status_code=400, detail="tipo invalido (RETIRADA/DEVOLUCAO)")
    if body.referencia_tipo not in ("KIT", "ITEM_ELETRICO", "ITEM_MANUAL", "KIT_MANUAL"):
        raise HTTPException(
            status_code=400,
            detail="referencia_tipo invalido (KIT/ITEM_ELETRICO/ITEM_MANUAL/KIT_MANUAL)",
        )

    sub_id = payload.get("subresponsavel_id")
    enc_id = payload.get("encarregado_id")
    if sub_id is None:
        user = get_user_row(db, payload.get("sub"))
        sub_id = user["subresponsavel_id"] if user else None

    if sub_id is None and enc_id is None:
        raise HTTPException(status_code=400, detail="Usuario sem subresponsavel_id ou encarregado_id")

    ip = request.client.host if request.client else None
    ua = request.headers.get("user-agent")

    db.execute(
        text(
            """
            INSERT INTO termos_responsabilidade
                (user_id, subresponsavel_id, tipo, referencia_tipo, referencia_id,
                 texto_termo, assinatura_nome, assinatura_imagem, ip, user_agent, latitude, longitude)
            VALUES
                (:user_id, :subresponsavel_id, :tipo, :referencia_tipo, :referencia_id,
                 :texto_termo, :assinatura_nome, :assinatura_imagem, :ip, :user_agent, :latitude, :longitude)
            """
        ),
        {
            "user_id": payload["uid"],
            "subresponsavel_id": sub_id,
            "tipo": body.tipo,
            "referencia_tipo": body.referencia_tipo,
            "referencia_id": body.referencia_id,
            "texto_termo": body.texto_termo,
            "assinatura_nome": body.assinatura_nome,
            "assinatura_imagem": body.assinatura_imagem,
            "ip": ip,
            "user_agent": ua,
            "latitude": body.latitude,
            "longitude": body.longitude,
        },
    )
    db.commit()

    row = db.execute(
        text(
            """
            SELECT id, user_id, subresponsavel_id, tipo, referencia_tipo, referencia_id,
                   texto_termo, assinatura_nome, assinatura_imagem, ip, user_agent,
                   latitude, longitude, criado_em
            FROM termos_responsabilidade
            WHERE user_id = :uid
            ORDER BY id DESC
            LIMIT 1
            """
        ),
        {"uid": payload["uid"]},
    ).mappings().first()

    return TermoOut(**row)


@router.get("/minha", response_model=List[TermoOut])
def meus_termos(
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    rows = db.execute(
        text(
            """
            SELECT id, user_id, subresponsavel_id, tipo, referencia_tipo, referencia_id,
                   texto_termo, assinatura_nome, assinatura_imagem, ip, user_agent,
                   latitude, longitude, criado_em
            FROM termos_responsabilidade
            WHERE user_id = :uid
            ORDER BY id DESC
            LIMIT 200
            """
        ),
        {"uid": payload["uid"]},
    ).mappings().all()

    return [TermoOut(**r) for r in rows]
