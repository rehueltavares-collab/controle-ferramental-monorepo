from __future__ import annotations

from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..core.auth import get_current_token, get_db, require_roles, get_user_row


router = APIRouter(prefix="/manuais", tags=["Manuais"])


class ManualItemOut(BaseModel):
    id: int
    nome: str
    ativo: int


class ManualMovIn(BaseModel):
    manual_item_id: int
    quantidade: int = Field(default=1, ge=1)
    data_retirada: Optional[date] = None
    observacao: Optional[str] = None


@router.get("/itens", response_model=List[ManualItemOut])
def listar_itens(query: str = Query(default="", description="busca por nome"), db: Session = Depends(get_db)):
    q = query.strip()
    if q:
        rows = db.execute(
            text(
                """
                SELECT id, nome, ativo
                FROM manual_itens
                WHERE ativo=1 AND nome LIKE :q
                ORDER BY nome
                LIMIT 100
                """
            ),
            {"q": f"%{q}%"},
        ).mappings().all()
    else:
        rows = db.execute(
            text(
                """
                SELECT id, nome, ativo
                FROM manual_itens
                WHERE ativo=1
                ORDER BY nome
                LIMIT 100
                """
            )
        ).mappings().all()

    return [ManualItemOut(**r) for r in rows]


@router.post("/entregar", dependencies=[Depends(require_roles(["admin", "manutencao", "funcionario"]))])
def entregar_item(
    body: ManualMovIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    sub_id = payload.get("subresponsavel_id")
    enc_id = payload.get("encarregado_id")
    if sub_id is None and enc_id is None:
        user = get_user_row(db, payload.get("sub"))
        sub_id = user["subresponsavel_id"] if user else None
        enc_id = user["encarregado_id"] if user else None

    if sub_id is None and enc_id is None:
        raise HTTPException(status_code=400, detail="Usuario sem subresponsavel_id ou encarregado_id")

    row = db.execute(
        text("SELECT id FROM manual_itens WHERE id = :id AND ativo=1"),
        {"id": body.manual_item_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Item manual nao encontrado")

    if sub_id is not None:
        existing = db.execute(
            text(
                """
                SELECT id, quantidade FROM manual_posse
                WHERE subresponsavel_id = :sub_id AND manual_item_id = :item_id
                LIMIT 1
                """
            ),
            {"sub_id": sub_id, "item_id": body.manual_item_id},
        ).mappings().first()
    else:
        existing = db.execute(
            text(
                """
                SELECT id, quantidade FROM manual_posse
                WHERE encarregado_id = :enc_id AND manual_item_id = :item_id
                LIMIT 1
                """
            ),
            {"enc_id": enc_id, "item_id": body.manual_item_id},
        ).mappings().first()

    if existing:
        db.execute(
            text(
                """
                UPDATE manual_posse
                SET quantidade = :q, data_retirada = :d
                WHERE id = :id
                """
            ),
            {
                "q": int(existing["quantidade"]) + int(body.quantidade),
                "d": body.data_retirada,
                "id": existing["id"],
            },
        )
    else:
        db.execute(
            text(
                """
                INSERT INTO manual_posse
                (subresponsavel_id, encarregado_id, manual_item_id, quantidade, data_retirada)
                VALUES
                (:sub_id, :enc_id, :item_id, :q, :d)
                """
            ),
            {
                "sub_id": sub_id,
                "enc_id": enc_id,
                "item_id": body.manual_item_id,
                "q": int(body.quantidade),
                "d": body.data_retirada,
            },
        )

    db.execute(
        text(
            """
            INSERT INTO movimentos
            (tipo, manual_item_id, encarregado_id, subresponsavel_id, quantidade, observacao)
            VALUES
            ('MANUAL_ENTREGAR', :item_id, :enc_id, :sub_id, :q, :obs)
            """
        ),
        {
            "item_id": body.manual_item_id,
            "enc_id": enc_id,
            "sub_id": sub_id,
            "q": int(body.quantidade),
            "obs": (body.observacao or "").strip() or None,
        },
    )

    db.commit()
    return {
        "ok": True,
        "subresponsavel_id": sub_id,
        "encarregado_id": enc_id,
        "manual_item_id": body.manual_item_id,
    }
