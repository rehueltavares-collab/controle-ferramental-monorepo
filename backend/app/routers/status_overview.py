from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db

router = APIRouter(prefix="/status", tags=["Status"])


def _table_exists(db: Session, table_name: str) -> bool:
    row = db.execute(
        text(
            """
            SELECT COUNT(*) AS c
            FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_name = :t
            """
        ),
        {"t": table_name},
    ).fetchone()
    return bool(row and row[0] > 0)


def _count_last_movements_mariadb(db: Session) -> Dict[str, int]:
    if not _table_exists(db, "item_movimentos"):
        return {"PRESENTE": 0, "DISTRIBUIDO": 0}

    rows = db.execute(
        text(
            """
            SELECT last.acao AS acao, COUNT(*) AS total
            FROM item_movimentos last
            JOIN (
                SELECT item_id, MAX(id) AS max_id
                FROM item_movimentos
                GROUP BY item_id
            ) sub ON sub.item_id = last.item_id AND sub.max_id = last.id
            GROUP BY last.acao
            """
        )
    ).fetchall()

    acao_presente = {"RECOLHER", "RECOLHIDO", "PRESENTE"}
    acao_distrib = {"DISTRIBUIR", "DISTRIBUIDO", "DISTRIBUÍDO"}

    presente = 0
    distribuido = 0

    for acao, total in rows:
        a = (acao or "").strip().upper()
        if a in acao_presente:
            presente += int(total)
        elif a in acao_distrib:
            distribuido += int(total)

    return {"PRESENTE": presente, "DISTRIBUIDO": distribuido}


@router.get("/overview")
def status_overview(db: Session = Depends(get_db)) -> Dict[str, Any]:
    total_items = db.query(models.KitItem).count()

    mv = _count_last_movements_mariadb(db)
    present = int(mv.get("PRESENTE", 0))
    distributed = int(mv.get("DISTRIBUIDO", 0))
    pending_items = max(total_items - distributed - present, 0)

    pending_devolucao = (
        db.query(models.SolicitacaoOperacao)
        .filter(models.SolicitacaoOperacao.status == "PENDENTE")
        .filter(models.SolicitacaoOperacao.tipo == "DEVOLUCAO_KIT")
        .count()
    )

    pending_substituicao = (
        db.query(models.SolicitacaoOperacao)
        .filter(models.SolicitacaoOperacao.status == "PENDENTE")
        .filter(models.SolicitacaoOperacao.tipo == "SUBSTITUICAO_ITEM")
        .count()
    )

    pending_terms = db.query(models.ChecklistSemanal).count()

    return {
        "total_items": total_items,
        "present": present,
        "distributed": distributed,
        "pending_items": pending_items,
        "pending_devolucao": pending_devolucao,
        "pending_substituicao": pending_substituicao,
        "pending_termo": pending_terms,
    }
