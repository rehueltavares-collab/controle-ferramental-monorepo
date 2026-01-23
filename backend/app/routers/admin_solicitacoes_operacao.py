from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..core.auth import require_roles
from ..database import get_db
from .. import models, schemas

router = APIRouter(prefix="/admin/solicitacoes/operacao", tags=["AdminSolicitacoesOperacao"])


@router.get("/", response_model=List[schemas.SolicitacaoOperacaoOut])
def listar_solicitacoes_operacao(
    status: Optional[str] = Query("PENDENTE"),
    db: Session = Depends(get_db),
    payload: dict = Depends(require_roles(["admin"])),
):
    query = db.query(models.SolicitacaoOperacao)
    if status:
        query = query.filter(models.SolicitacaoOperacao.status == status)
    return query.order_by(models.SolicitacaoOperacao.criado_em.desc()).all()


def _atualizar_status(request_id: int, novo_status: str, admin_id: int, db: Session):
    solicitacao = db.get(models.SolicitacaoOperacao, request_id)
    if not solicitacao:
        raise HTTPException(status_code=404, detail="Solicitacao nao encontrada")
    if solicitacao.status == novo_status:
        return solicitacao

    solicitacao.status = novo_status
    solicitacao.admin_id = admin_id
    solicitacao.concluido_em = datetime.utcnow()
    db.add(solicitacao)
    db.commit()
    db.refresh(solicitacao)
    return solicitacao


@router.post("/{solicitacao_id}/aprovar", response_model=schemas.SolicitacaoOperacaoOut)
def aprovar_solicitacao_operacao(
    solicitacao_id: int,
    db: Session = Depends(get_db),
    payload: dict = Depends(require_roles(["admin"])),
):
    return _atualizar_status(solicitacao_id, "APROVADA", int(payload["uid"]), db)


@router.post("/{solicitacao_id}/rejeitar", response_model=schemas.SolicitacaoOperacaoOut)
def rejeitar_solicitacao_operacao(
    solicitacao_id: int,
    db: Session = Depends(get_db),
    payload: dict = Depends(require_roles(["admin"])),
):
    return _atualizar_status(solicitacao_id, "REJEITADA", int(payload["uid"]), db)
