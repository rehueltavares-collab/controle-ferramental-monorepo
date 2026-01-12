from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..core.auth import require_roles
from ..database import SessionLocal


router = APIRouter(prefix="/admin", tags=["Admin"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/pessoas", dependencies=[Depends(require_roles(["admin"]))])
def listar_pessoas(query: str = Query(default=""), db: Session = Depends(get_db)):
    q = query.strip()
    q_like = f"%{q}%"

    enc_rows = db.execute(
        text(
            """
            SELECT 'encarregado' AS tipo, e.id, e.nome, e.funcao, s.nome AS setor_nome
            FROM encarregados e
            JOIN setores s ON s.id = e.setor_id
            WHERE (:q = '' OR e.nome LIKE :q_like)
            ORDER BY e.nome
            LIMIT 200
            """
        ),
        {"q": q, "q_like": q_like},
    ).mappings().all()

    sub_rows = db.execute(
        text(
            """
            SELECT 'subresponsavel' AS tipo, id, nome, secao AS funcao, NULL AS setor_nome
            FROM subresponsaveis
            WHERE (:q = '' OR nome LIKE :q_like)
            ORDER BY nome
            LIMIT 200
            """
        ),
        {"q": q, "q_like": q_like},
    ).mappings().all()

    return {"encarregados": enc_rows, "subresponsaveis": sub_rows}


@router.get("/busca", dependencies=[Depends(require_roles(["admin"]))])
def busca_global(
    query: str = Query(default=""),
    setor_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
):
    q = query.strip()
    q_like = f"%{q}%"
    q_id = int(q) if q.isdigit() else 0

    kits = db.execute(
        text(
            """
            SELECT DISTINCT k.id, k.nome, k.tipo, k.setor_id, s.nome AS setor_nome
            FROM kits k
            JOIN setores s ON s.id = k.setor_id
            LEFT JOIN kit_itens ki ON ki.kit_id = k.id
            LEFT JOIN itens i ON i.id = ki.item_id
            WHERE (:q = '' OR k.nome LIKE :q_like OR k.id = :q_id
                   OR i.patrimonio LIKE :q_like OR i.descricao LIKE :q_like)
              AND (:setor_id IS NULL OR k.setor_id = :setor_id)
            ORDER BY k.nome
            LIMIT 100
            """
        ),
        {"q": q, "q_like": q_like, "q_id": q_id, "setor_id": setor_id},
    ).mappings().all()

    itens = db.execute(
        text(
            """
            SELECT i.id, i.patrimonio, i.descricao, k.id AS kit_id, k.nome AS kit_nome
            FROM itens i
            LEFT JOIN kit_itens ki ON ki.item_id = i.id
            LEFT JOIN kits k ON k.id = ki.kit_id
            WHERE (:q = '' OR i.patrimonio LIKE :q_like OR i.descricao LIKE :q_like)
            ORDER BY i.patrimonio
            LIMIT 100
            """
        ),
        {"q": q, "q_like": q_like},
    ).mappings().all()

    pessoas_enc = db.execute(
        text(
            """
            SELECT 'encarregado' AS tipo, e.id, e.nome, e.funcao, s.nome AS setor_nome
            FROM encarregados e
            JOIN setores s ON s.id = e.setor_id
            WHERE (:q = '' OR e.nome LIKE :q_like)
              AND (:setor_id IS NULL OR e.setor_id = :setor_id)
            ORDER BY e.nome
            LIMIT 100
            """
        ),
        {"q": q, "q_like": q_like, "setor_id": setor_id},
    ).mappings().all()

    pessoas_sub = db.execute(
        text(
            """
            SELECT 'subresponsavel' AS tipo, id, nome, secao AS funcao, NULL AS setor_nome
            FROM subresponsaveis
            WHERE (:q = '' OR nome LIKE :q_like)
            ORDER BY nome
            LIMIT 100
            """
        ),
        {"q": q, "q_like": q_like},
    ).mappings().all()

    manuais = db.execute(
        text(
            """
            SELECT id, nome
            FROM manual_itens
            WHERE ativo = 1 AND (:q = '' OR nome LIKE :q_like)
            ORDER BY nome
            LIMIT 100
            """
        ),
        {"q": q, "q_like": q_like},
    ).mappings().all()

    return {
        "kits": kits,
        "itens": itens,
        "pessoas": pessoas_enc + pessoas_sub,
        "manuais": manuais,
    }


@router.get("/manual-posse", dependencies=[Depends(require_roles(["admin"]))])
def listar_manual_posse(
    query: str = Query(default=""),
    setor_id: Optional[int] = Query(default=None),
    pessoa_tipo: Optional[str] = Query(default=None),
    pessoa_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
):
    q = query.strip()
    q_like = f"%{q}%"

    rows = db.execute(
        text(
            """
            SELECT
                mp.id,
                mp.quantidade,
                mp.data_retirada,
                mi.id AS manual_item_id,
                mi.nome AS manual_item_nome,
                mp.encarregado_id,
                mp.subresponsavel_id,
                e.nome AS encarregado_nome,
                s.nome AS setor_nome,
                sr.nome AS subresponsavel_nome,
                sr.secao AS sub_secao
            FROM manual_posse mp
            JOIN manual_itens mi ON mi.id = mp.manual_item_id
            LEFT JOIN encarregados e ON e.id = mp.encarregado_id
            LEFT JOIN setores s ON s.id = e.setor_id
            LEFT JOIN subresponsaveis sr ON sr.id = mp.subresponsavel_id
            WHERE (:q = '' OR mi.nome LIKE :q_like OR e.nome LIKE :q_like OR sr.nome LIKE :q_like)
              AND (:setor_id IS NULL OR e.setor_id = :setor_id)
              AND (
                :pessoa_tipo IS NULL OR
                (:pessoa_tipo = 'encarregado' AND mp.encarregado_id = :pessoa_id) OR
                (:pessoa_tipo = 'subresponsavel' AND mp.subresponsavel_id = :pessoa_id)
              )
            ORDER BY mp.id DESC
            LIMIT 200
            """
        ),
        {
            "q": q,
            "q_like": q_like,
            "setor_id": setor_id,
            "pessoa_tipo": pessoa_tipo,
            "pessoa_id": pessoa_id,
        },
    ).mappings().all()

    return {"posse": rows}


@router.get("/trilha/kit/{kit_id}", dependencies=[Depends(require_roles(["admin"]))])
def trilha_kit(kit_id: int, db: Session = Depends(get_db)):
    checklists = db.execute(
        text(
            """
            SELECT id, data_hora, encarregado_id, latitude, longitude, patrimonios_declarados
            FROM checklists_semanais
            WHERE kit_id = :kit_id
            ORDER BY id DESC
            LIMIT 50
            """
        ),
        {"kit_id": kit_id},
    ).mappings().all()

    movimentos = db.execute(
        text(
            """
            SELECT *
            FROM movimentos
            WHERE kit_id = :kit_id
            ORDER BY id DESC
            LIMIT 200
            """
        ),
        {"kit_id": kit_id},
    ).mappings().all()

    termos = db.execute(
        text(
            """
            SELECT *
            FROM termos_responsabilidade
            WHERE referencia_tipo = 'KIT' AND referencia_id = :kit_id
            ORDER BY id DESC
            LIMIT 50
            """
        ),
        {"kit_id": kit_id},
    ).mappings().all()

    return {"checklists": checklists, "movimentos": movimentos, "termos": termos}


@router.get("/trilha/patrimonio/{patrimonio}", dependencies=[Depends(require_roles(["admin"]))])
def trilha_patrimonio(patrimonio: str, db: Session = Depends(get_db)):
    movs = db.execute(
        text(
            """
            SELECT *
            FROM movimentos
            WHERE patrimonio = :pat
            ORDER BY id DESC
            LIMIT 200
            """
        ),
        {"pat": patrimonio},
    ).mappings().all()

    item_id_row = db.execute(
        text("SELECT id FROM itens WHERE patrimonio = :pat LIMIT 1"),
        {"pat": patrimonio},
    ).first()
    item_id = item_id_row[0] if item_id_row else None

    item_movs = []
    if item_id:
        item_movs = db.execute(
            text(
                """
                SELECT *
                FROM item_movimentos
                WHERE item_id = :item_id
                ORDER BY id DESC
                LIMIT 200
                """
            ),
            {"item_id": item_id},
        ).mappings().all()

    return {"movimentos": movs, "item_movimentos": item_movs}
