from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..database import get_db
from .. import models, schemas
from ..core.auth import require_roles

router = APIRouter(prefix="/solicitacoes/operacao", tags=["SolicitacoesOperacao"])

VALID_TIPOS = {"DEVOLUCAO_KIT", "DEVOLUCAO_AVULSO", "SUBSTITUICAO_ITEM"}


@router.get("/minhas")
def listar_solicitacoes_minhas(
    status: Optional[str] = Query("PENDENTE"),
    db: Session = Depends(get_db),
    payload: dict = Depends(require_roles(["admin", "manutencao", "funcionario"])),
):
    query = db.query(models.SolicitacaoOperacao).filter(
        models.SolicitacaoOperacao.solicitante_id == int(payload["uid"])
    )
    if status:
        query = query.filter(models.SolicitacaoOperacao.status == status)
    rows = query.order_by(models.SolicitacaoOperacao.criado_em.desc()).all()
    items = [
        {
            "id": r.id,
            "tipo": r.tipo,
            "kit_id": r.kit_id,
            "item_id": r.item_id,
            "status": r.status,
            "criado_em": r.criado_em,
        }
        for r in rows
    ]
    return JSONResponse(content={"items": jsonable_encoder(items)})


@router.post("/", response_model=schemas.SolicitacaoOperacaoOut)
def criar_solicitacao_operacao(
    body: schemas.SolicitacaoOperacaoCreate,
    db: Session = Depends(get_db),
    payload: dict = Depends(require_roles(["admin", "manutencao", "funcionario"])),
):
    tipo = (body.tipo or "").strip().upper()
    if tipo not in VALID_TIPOS:
        raise HTTPException(status_code=400, detail="Tipo de solicitacao invalido")

    if tipo == "DEVOLUCAO_KIT" and not body.kit_id:
        raise HTTPException(status_code=400, detail="kit_id obrigatorio para devolucao de kit")
    if tipo == "DEVOLUCAO_AVULSO" and not body.item_id:
        raise HTTPException(status_code=400, detail="item_id obrigatorio para devolucao de avulso")
    if tipo == "SUBSTITUICAO_ITEM" and (not body.kit_id or not body.item_id or not body.motivo):
        raise HTTPException(
            status_code=400,
            detail="kit_id, item_id e motivo obrigatorios para substituicao",
        )

    solicitacao = models.SolicitacaoOperacao(
        tipo=tipo,
        kit_id=body.kit_id,
        item_id=body.item_id,
        motivo=body.motivo,
        observacao=body.observacao,
        solicitante_id=int(payload["uid"]),
        status="PENDENTE",
    )

    db.add(solicitacao)
    db.commit()
    db.refresh(solicitacao)
    return solicitacao
