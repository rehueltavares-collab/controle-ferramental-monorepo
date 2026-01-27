from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, Query
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
def status_overview(
    encarregado_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    if encarregado_id:
        total_items = db.execute(
            text(
                """
                SELECT COUNT(*) AS c
                FROM kit_itens ki
                JOIN posses p ON p.tipo='KIT' AND p.kit_id = ki.kit_id AND p.status='ATIVA'
                WHERE p.encarregado_id = :enc
                """
            ),
            {"enc": encarregado_id},
        ).scalar() or 0

        rows = db.execute(
            text(
                """
                SELECT last.acao AS acao, COUNT(*) AS total
                FROM item_movimentos last
                JOIN (
                    SELECT im.item_id, MAX(im.id) AS max_id
                    FROM item_movimentos im
                    JOIN kit_itens ki ON ki.item_id = im.item_id
                    JOIN posses p ON p.tipo='KIT' AND p.kit_id = ki.kit_id AND p.status='ATIVA'
                    WHERE p.encarregado_id = :enc
                    GROUP BY im.item_id
                ) sub ON sub.item_id = last.item_id AND sub.max_id = last.id
                GROUP BY last.acao
                """
            ),
            {"enc": encarregado_id},
        ).fetchall()

        acao_presente = {"RECOLHER", "RECOLHIDO", "PRESENTE"}
        acao_distrib = {"DISTRIBUIR", "DISTRIBUIDO", "DISTRIBUÍDO"}
        present = 0
        distributed = 0
        for acao, total in rows:
            a = (acao or "").strip().upper()
            if a in acao_presente:
                present += int(total)
            elif a in acao_distrib:
                distributed += int(total)

        # Se não há movimentos, considera tudo presente
        present = max(int(total_items) - distributed, 0)
        pending_items = 0

        pending_devolucao = (
            db.execute(
                text(
                    """
                    SELECT COUNT(*) AS c
                    FROM solicitacoes_operacao
                    WHERE status = 'PENDENTE'
                      AND tipo = 'DEVOLUCAO_KIT'
                      AND encarregado_id = :enc
                    """
                ),
                {"enc": encarregado_id},
            ).scalar()
            or 0
        )

        pending_substituicao = (
            db.execute(
                text(
                    """
                    SELECT COUNT(*) AS c
                    FROM solicitacoes_operacao
                    WHERE status = 'PENDENTE'
                      AND tipo = 'SUBSTITUICAO_ITEM'
                      AND encarregado_id = :enc
                    """
                ),
                {"enc": encarregado_id},
            ).scalar()
            or 0
        )

        pending_terms = (
            db.query(models.ChecklistSemanal)
            .filter(models.ChecklistSemanal.encarregado_id == encarregado_id)
            .count()
        )
    else:
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
        "total_items": int(total_items),
        "present": present,
        "distributed": distributed,
        "pending_items": pending_items,
        "pending_devolucao": pending_devolucao,
        "pending_substituicao": pending_substituicao,
        "pending_termo": pending_terms,
    }
