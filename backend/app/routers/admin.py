from __future__ import annotations

import os
from typing import Optional

from pydantic import BaseModel

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..core.auth import require_roles, get_current_token
from ..core.security import hash_password
from ..database import SessionLocal
from ..routers.solicitacoes import (
    ensure_tables as ensure_solicitacoes_tables,
    ensure_operacoes_table,
    ensure_itens_columns,
    ensure_subresponsavel_pin_hash,
    require_admin_pin,
    ConcluirOperacaoIn,
    concluir_operacao,
    detalhe_solicitacao,
)
from ..routers.movimentos import ensure_movimentos_columns
from ..utils.security import hash_pin
from ..utils.security import verify_pin
from ..utils.normalizer import normalize_desc


router = APIRouter(prefix="/admin", tags=["Admin"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class AdminPinOnlyIn(BaseModel):
    admin_pin: str


class AdminAprovarSubstituicaoIn(BaseModel):
    admin_pin: str
    substituto_item_id: int


class ConferenciaItemIn(BaseModel):
    solicitacao_item_id: int
    status: str
    acao: Optional[str] = None
    motivo: Optional[str] = None
    observacao: Optional[str] = None


class ConferenciaEntregaIn(BaseModel):
    admin_pin: str
    itens: list[ConferenciaItemIn]


class DevolucaoItemIn(BaseModel):
    item_id: int
    status: str
    motivo: Optional[str] = None
    anexo_path: Optional[str] = None


class ConferenciaDevolucaoIn(BaseModel):
    admin_pin: str
    itens: list[DevolucaoItemIn]


class AdminResetSenhaIn(BaseModel):
    user_id: int
    admin_pin: str


class AdminAlterarPinSubrespIn(BaseModel):
    subresponsavel_id: int
    novo_pin: str
    confirmar_pin: str
    admin_pin: str


class AdminUsuarioCreateIn(BaseModel):
    nome_completo: str
    username: str
    perfil: str
    subresponsavel_id: Optional[int] = None
    encarregado_id: Optional[int] = None
    ativo: bool = True


class AdminSubresponsavelCreateIn(BaseModel):
    nome: str
    secao: Optional[str] = None
    ativo: bool = True


def _map_operacao_tipo(tipo: str) -> str:
    t = (tipo or "").strip().upper()
    if t == "SUBSTITUICAO_ITEM":
        return "SUBSTITUICAO"
    if t.startswith("DEVOLUCAO"):
        return "DEVOLUCAO"
    if t == "ADICAO_AVULSO":
        return "SOLICITACAO"
    return t or "OPERACAO"


def _infer_categoria(kit_id: Optional[int], item_id: Optional[int]) -> str:
    if kit_id:
        return "KIT"
    if item_id:
        return "AVULSO"
    return "KIT"


def _ensure_users_columns(db: Session) -> None:
    try:
        db.execute(text("ALTER TABLE users ADD COLUMN admin_pin_hash TEXT NULL"))
    except Exception:
        pass
    try:
        db.execute(text("ALTER TABLE users ADD COLUMN precisa_definir_pin INT NOT NULL DEFAULT 1"))
    except Exception:
        pass
    db.commit()


def _ensure_kit_pendencias(db: Session) -> None:
    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS kit_pendencias (
              id INT AUTO_INCREMENT PRIMARY KEY,
              kit_id INT NOT NULL,
              item_id INT NULL,
              descricao_canonica VARCHAR(255) NULL,
              motivo VARCHAR(50) NOT NULL,
              observacao TEXT NULL,
              status VARCHAR(20) NOT NULL DEFAULT 'ABERTA',
              criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              encerrado_em DATETIME NULL
            )
            """
        )
    )
    db.commit()


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
    ensure_movimentos_columns(db)
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
            SELECT
              m.*,
              ru.nome AS registrado_por_nome,
              ru.role AS registrado_por_role,
              CASE
                WHEN m.pin_tipo = 'SUBRESP_6' THEN sr.nome
                WHEN m.pin_tipo = 'ADMIN_4' THEN au.nome
                ELSE NULL
              END AS pin_autor_nome,
              CASE
                WHEN m.pin_tipo = 'SUBRESP_6' THEN 'SUBRESPONSAVEL'
                WHEN m.pin_tipo = 'ADMIN_4' THEN 'ADMIN'
                ELSE NULL
              END AS pin_autor_tipo,
              tr.tipo AS termo_tipo,
              tr.assinatura_nome AS termo_assinatura_nome,
              tr.criado_em AS termo_criado_em,
              tr.texto_termo AS termo_texto
            FROM movimentos m
            LEFT JOIN users ru ON ru.id = m.registrado_por_id
            LEFT JOIN subresponsaveis sr ON sr.id = m.pin_autor_id
            LEFT JOIN users au ON au.id = m.pin_autor_id
            LEFT JOIN termos_responsabilidade tr ON tr.id = m.termo_id
            WHERE m.kit_id = :kit_id
            ORDER BY m.id DESC
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
    ensure_movimentos_columns(db)
    movs = db.execute(
        text(
            """
            SELECT
              m.*,
              ru.nome AS registrado_por_nome,
              ru.role AS registrado_por_role,
              CASE
                WHEN m.pin_tipo = 'SUBRESP_6' THEN sr.nome
                WHEN m.pin_tipo = 'ADMIN_4' THEN au.nome
                ELSE NULL
              END AS pin_autor_nome,
              CASE
                WHEN m.pin_tipo = 'SUBRESP_6' THEN 'SUBRESPONSAVEL'
                WHEN m.pin_tipo = 'ADMIN_4' THEN 'ADMIN'
                ELSE NULL
              END AS pin_autor_tipo,
              tr.tipo AS termo_tipo,
              tr.assinatura_nome AS termo_assinatura_nome,
              tr.criado_em AS termo_criado_em,
              tr.texto_termo AS termo_texto
            FROM movimentos m
            LEFT JOIN users ru ON ru.id = m.registrado_por_id
            LEFT JOIN subresponsaveis sr ON sr.id = m.pin_autor_id
            LEFT JOIN users au ON au.id = m.pin_autor_id
            LEFT JOIN termos_responsabilidade tr ON tr.id = m.termo_id
            WHERE m.patrimonio = :pat
            ORDER BY m.id DESC
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


@router.get("/solicitacoes/operacao", dependencies=[Depends(require_roles(["admin"]))])
def listar_fila_operacional(
    tipo: str = Query(default=""),
    status: Optional[str] = Query(default=None),
    categoria: Optional[str] = Query(default=None),
    query: str = Query(default=""),
    data_ini: Optional[str] = Query(default=None),
    data_fim: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    ensure_solicitacoes_tables(db)
    ensure_operacoes_table(db)
    ensure_itens_columns(db)

    t = (tipo or "").strip().upper()
    cat = (categoria or "").strip().upper()
    q = query.strip()
    q_like = f"%{q}%"

    items = []

    if t in ("", "SOLICITACAO"):
        rows = db.execute(
            text(
                """
                SELECT
                  s.id,
                  s.status,
                  s.criado_em,
                  s.solicitante_user_id,
                  s.kit_id,
                  u.nome AS solicitante_nome,
                  u.username AS solicitante_username,
                  k.nome AS kit_nome
                FROM solicitacoes_retirada s
                LEFT JOIN users u ON u.id = s.solicitante_user_id
                LEFT JOIN kits k ON k.id = s.kit_id
                WHERE s.tipo = 'ELETRICO'
                  AND (:status IS NULL OR s.status = :status)
                  AND (:q = '' OR u.nome LIKE :q_like OR k.nome LIKE :q_like)
                  AND (:data_ini IS NULL OR s.criado_em >= :data_ini)
                  AND (:data_fim IS NULL OR s.criado_em <= :data_fim)
                ORDER BY s.id DESC
                LIMIT 200
                """
            ),
            {"status": status, "q": q, "q_like": q_like, "data_ini": data_ini, "data_fim": data_fim},
        ).mappings().all()

        for row in rows:
            categoria_item = _infer_categoria(row.get("kit_id"), None)
            if cat and cat != categoria_item:
                continue
            items.append(
                {
                    "id": row["id"],
                    "tipo": "SOLICITACAO",
                    "categoria": categoria_item,
                    "status": row["status"],
                    "criado_em": row["criado_em"],
                    "solicitante": {
                        "id": row["solicitante_user_id"],
                        "nome": row.get("solicitante_nome"),
                        "username": row.get("solicitante_username"),
                    },
                    "kit": {"id": row.get("kit_id"), "nome": row.get("kit_nome")},
                    "item": None,
                    "origem": "SOLICITACAO",
                }
            )

    if t in ("", "SUBSTITUICAO", "DEVOLUCAO"):
        where_tipo = ""
        if t == "SUBSTITUICAO":
            where_tipo = "AND o.tipo = 'SUBSTITUICAO_ITEM'"
        elif t == "DEVOLUCAO":
            where_tipo = "AND o.tipo IN ('DEVOLUCAO_KIT','DEVOLUCAO_AVULSO')"

        rows = db.execute(
            text(
                f"""
                SELECT
                  o.*,
                  u.nome AS solicitante_nome,
                  u.username AS solicitante_username,
                  k.nome AS kit_nome,
                  i.patrimonio AS item_patrimonio,
                  i.descricao AS item_descricao
                FROM solicitacoes_operacao o
                LEFT JOIN users u ON u.id = o.solicitante_user_id
                LEFT JOIN kits k ON k.id = o.kit_id
                LEFT JOIN itens i ON i.id = o.item_id
                WHERE (:status IS NULL OR o.status = :status)
                  AND (:q = '' OR u.nome LIKE :q_like OR k.nome LIKE :q_like OR i.patrimonio LIKE :q_like)
                  AND (:data_ini IS NULL OR o.criado_em >= :data_ini)
                  AND (:data_fim IS NULL OR o.criado_em <= :data_fim)
                  {where_tipo}
                ORDER BY o.id DESC
                LIMIT 200
                """
            ),
            {
                "status": status,
                "q": q,
                "q_like": q_like,
                "data_ini": data_ini,
                "data_fim": data_fim,
            },
        ).mappings().all()

        for row in rows:
            categoria_item = _infer_categoria(row.get("kit_id"), row.get("item_id"))
            if cat and cat != categoria_item:
                continue
            items.append(
                {
                    "id": row["id"],
                    "tipo": _map_operacao_tipo(row.get("tipo")),
                    "categoria": categoria_item,
                    "status": row.get("status"),
                    "criado_em": row.get("criado_em"),
                    "solicitante": {
                        "id": row.get("solicitante_user_id"),
                        "nome": row.get("solicitante_nome"),
                        "username": row.get("solicitante_username"),
                    },
                    "kit": {"id": row.get("kit_id"), "nome": row.get("kit_nome")},
                    "item": {
                        "id": row.get("item_id"),
                        "patrimonio": row.get("item_patrimonio"),
                        "descricao": row.get("item_descricao"),
                    }
                    if row.get("item_id")
                    else None,
                    "origem": "OPERACAO",
                }
            )

    items.sort(key=lambda x: x.get("criado_em") or "", reverse=True)
    return {"items": items}


@router.get("/solicitacoes/operacao/{operacao_id}", dependencies=[Depends(require_roles(["admin"]))])
def detalhe_fila_operacional(
    operacao_id: int,
    origem: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    ensure_solicitacoes_tables(db)
    ensure_operacoes_table(db)
    ensure_itens_columns(db)
    origem_norm = (origem or "").strip().upper()

    if origem_norm in ("", "OPERACAO"):
        op = db.execute(
            text(
                """
                SELECT
                  o.*,
                  u.nome AS solicitante_nome,
                  u.username AS solicitante_username,
                  k.nome AS kit_nome,
                  i.patrimonio AS item_patrimonio,
                  i.descricao AS item_descricao,
                  i.descricao_canonica AS item_desc_canonica,
                  i.classe_tipo AS item_classe_tipo,
                  isub.patrimonio AS item_sub_patrimonio,
                  isub.descricao AS item_sub_descricao,
                  isub.descricao_canonica AS item_sub_desc_canonica,
                  isub.classe_tipo AS item_sub_classe_tipo
                FROM solicitacoes_operacao o
                LEFT JOIN users u ON u.id = o.solicitante_user_id
                LEFT JOIN kits k ON k.id = o.kit_id
                LEFT JOIN itens i ON i.id = o.item_id
                LEFT JOIN itens isub ON isub.id = o.item_substituto_id
                WHERE o.id = :oid
                LIMIT 1
                """
            ),
            {"oid": operacao_id},
        ).mappings().first()

        if op:
            categoria_item = _infer_categoria(op.get("kit_id"), op.get("item_id"))
            contexto = {
                "kit": {"id": op.get("kit_id"), "nome": op.get("kit_nome")},
                "item_original": {
                    "id": op.get("item_id"),
                    "patrimonio": op.get("item_patrimonio"),
                    "descricao": op.get("item_descricao"),
                    "descricao_canonica": op.get("item_desc_canonica"),
                    "classe_tipo": op.get("item_classe_tipo"),
                }
                if op.get("item_id")
                else None,
                "item_substituto": {
                    "id": op.get("item_substituto_id"),
                    "patrimonio": op.get("item_sub_patrimonio"),
                    "descricao": op.get("item_sub_descricao"),
                    "descricao_canonica": op.get("item_sub_desc_canonica"),
                    "classe_tipo": op.get("item_sub_classe_tipo"),
                }
                if op.get("item_substituto_id")
                else None,
            }

            if _map_operacao_tipo(op.get("tipo")) == "DEVOLUCAO" and op.get("kit_id"):
                itens = db.execute(
                    text(
                        """
                        SELECT i.id AS item_id, i.patrimonio, i.descricao
                        FROM kit_itens ki
                        JOIN itens i ON i.id = ki.item_id
                        WHERE ki.kit_id = :kit_id
                        ORDER BY i.patrimonio
                        """
                    ),
                    {"kit_id": int(op.get("kit_id"))},
                ).mappings().all()
                contexto["itens"] = itens

            return {
                "id": op["id"],
                "origem": "OPERACAO",
                "tipo": _map_operacao_tipo(op.get("tipo")),
                "categoria": categoria_item,
                "status": op.get("status"),
                "criado_em": op.get("criado_em"),
                "solicitante": {
                    "id": op.get("solicitante_user_id"),
                    "nome": op.get("solicitante_nome"),
                    "username": op.get("solicitante_username"),
                },
                "contexto": contexto,
                "termos": [],
                "trilha_resumo": {},
            }

    if origem_norm in ("", "SOLICITACAO"):
        sol = detalhe_solicitacao(operacao_id, db=db)
        solicitacao = sol.get("solicitacao") or {}
        if solicitacao:
            return {
                "id": solicitacao.get("id"),
                "origem": "SOLICITACAO",
                "tipo": "SOLICITACAO",
                "categoria": _infer_categoria(solicitacao.get("kit_id"), None),
                "status": solicitacao.get("status"),
                "criado_em": solicitacao.get("criado_em"),
                "solicitante": {
                    "id": solicitacao.get("solicitante_user_id"),
                    "nome": solicitacao.get("solicitante_nome"),
                    "username": solicitacao.get("solicitante_username"),
                },
                "contexto": {
                    "kit": {"id": solicitacao.get("kit_id"), "nome": solicitacao.get("kit_nome")},
                    "itens": sol.get("itens") or [],
                },
                "termos": [sol["termo"]] if sol.get("termo") else [],
                "trilha_resumo": {},
            }

    raise HTTPException(status_code=404, detail="Solicitacao/operacao nao encontrada")


@router.post("/solicitacoes/operacao/{operacao_id}/concluir-entrega", dependencies=[Depends(require_roles(["admin"]))])
def concluir_entrega_admin(
    operacao_id: int,
    body: AdminPinOnlyIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    ensure_solicitacoes_tables(db)
    require_admin_pin(db, payload, body.admin_pin)

    sol = db.execute(
        text("SELECT * FROM solicitacoes_retirada WHERE id = :sid"),
        {"sid": operacao_id},
    ).mappings().first()
    if not sol:
        raise HTTPException(status_code=404, detail="Solicitacao nao encontrada")

    if sol.get("tipo") != "ELETRICO":
        raise HTTPException(status_code=400, detail="Solicitacao nao eletrica")

    db.execute(
        text(
            """
            UPDATE solicitacoes_retirada
            SET status = 'ENTREGUE', entregue_em = NOW(), admin_user_id = :uid
            WHERE id = :sid
            """
        ),
        {"uid": int(payload["uid"]), "sid": operacao_id},
    )

    # Registra posse do kit para o encarregado
    if sol.get("kit_id") and sol.get("encarregado_id"):
        db.execute(
            text(
                """
                UPDATE posses
                SET status = 'ENCERRADA', updated_at = NOW()
                WHERE tipo = 'KIT' AND kit_id = :kit_id AND is_ativa = 1
                """
            ),
            {"kit_id": int(sol.get("kit_id"))},
        )
        db.execute(
            text(
                """
                INSERT INTO posses (tipo, kit_id, encarregado_id, status, created_at)
                VALUES ('KIT', :kit_id, :enc_id, 'ATIVA', NOW())
                """
            ),
            {"kit_id": int(sol.get("kit_id")), "enc_id": int(sol.get("encarregado_id"))},
        )

    db.execute(
        text(
            """
            UPDATE solicitacao_itens
            SET status = 'ENTREGUE',
                quantidade_entregue = quantidade_solicitada,
                admin_user_id = :uid,
                atualizado_em = NOW()
            WHERE solicitacao_id = :sid AND status = 'PENDENTE'
            """
        ),
        {"uid": int(payload["uid"]), "sid": operacao_id},
    )

    db.commit()
    return {"ok": True}


@router.post("/solicitacoes/operacao/{operacao_id}/conferir-entrega", dependencies=[Depends(require_roles(["admin"]))])
def conferir_entrega_admin(
    operacao_id: int,
    body: ConferenciaEntregaIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    ensure_solicitacoes_tables(db)
    ensure_operacoes_table(db)
    ensure_itens_columns(db)
    _ensure_kit_pendencias(db)
    require_admin_pin(db, payload, body.admin_pin)

    sol = db.execute(
        text("SELECT * FROM solicitacoes_retirada WHERE id = :sid"),
        {"sid": operacao_id},
    ).mappings().first()
    if not sol:
        raise HTTPException(status_code=404, detail="Solicitacao nao encontrada")
    if sol.get("tipo") != "ELETRICO":
        raise HTTPException(status_code=400, detail="Solicitacao nao eletrica")

    sub_id = sol.get("subresponsavel_id")

    itens_rows = db.execute(
        text(
            """
            SELECT si.id AS solicitacao_item_id, si.item_id, si.quantidade_solicitada,
                   i.patrimonio, i.descricao, i.descricao_canonica
            FROM solicitacao_itens si
            JOIN itens i ON i.id = si.item_id
            WHERE si.solicitacao_id = :sid
            """
        ),
        {"sid": operacao_id},
    ).mappings().all()
    if not itens_rows:
        raise HTTPException(status_code=400, detail="Solicitacao sem itens")

    itens_map = {int(r["solicitacao_item_id"]): r for r in itens_rows}
    payload_itens = {int(i.solicitacao_item_id): i for i in (body.itens or [])}

    pendencias = []

    for sol_item_id, row in itens_map.items():
        item_payload = payload_itens.get(sol_item_id)
        status = (item_payload.status if item_payload else "PRESENTE").upper()
        acao = (item_payload.acao or "").upper() if item_payload else ""
        motivo = (item_payload.motivo or "").strip() if item_payload else None
        obs = (item_payload.observacao or "").strip() if item_payload else None

        if status not in ("PRESENTE", "AUSENTE", "DEFEITO"):
            raise HTTPException(status_code=400, detail="Status invalido")

        if status == "PRESENTE":
            db.execute(
                text(
                    """
                    UPDATE solicitacao_itens
                    SET status = 'ENTREGUE',
                        quantidade_entregue = quantidade_solicitada,
                        admin_user_id = :uid,
                        atualizado_em = NOW()
                    WHERE id = :sid
                    """
                ),
                {"uid": int(payload["uid"]), "sid": sol_item_id},
            )
            continue

        # AUSENTE/DEFEITO
        db.execute(
            text(
                """
                UPDATE solicitacao_itens
                SET status = 'AUSENTE',
                    quantidade_entregue = 0,
                    admin_user_id = :uid,
                    atualizado_em = NOW()
                WHERE id = :sid
                """
            ),
            {"uid": int(payload["uid"]), "sid": sol_item_id},
        )

        if acao == "SUBSTITUICAO":
            pendente_key = f"SUBSTITUICAO_ITEM:{int(sol.get('kit_id') or 0)}:{int(row['item_id'])}"
            existing = db.execute(
                text(
                    """
                    SELECT id
                    FROM solicitacoes_operacao
                    WHERE pendente_key = :key
                      AND status = 'PENDENTE'
                    LIMIT 1
                    """
                ),
                {"key": pendente_key},
            ).first()
            if not existing:
                db.execute(
                    text(
                        """
                        INSERT INTO solicitacoes_operacao
                          (tipo, kit_id, item_id, pendente_key, solicitante_user_id, encarregado_id, subresponsavel_id, status, observacao)
                        VALUES
                          ('SUBSTITUICAO_ITEM', :kit_id, :item_id, :pendente_key, :uid, :enc_id, :sub_id, 'PENDENTE', :obs)
                        """
                    ),
                    {
                        "kit_id": int(sol.get("kit_id") or 0),
                        "item_id": int(row["item_id"]),
                        "pendente_key": pendente_key,
                        "uid": int(sol.get("solicitante_user_id") or 0),
                        "enc_id": sol.get("encarregado_id"),
                        "sub_id": sub_id,
                        "obs": obs or "GERADO_POR_CONFERENCIA",
                    },
                )
        else:
            canon = row.get("descricao_canonica") or normalize_desc(row.get("descricao"))
            db.execute(
                text(
                    """
                    INSERT INTO kit_pendencias
                      (kit_id, item_id, descricao_canonica, motivo, observacao, status)
                    VALUES
                      (:kit_id, :item_id, :canon, :motivo, :obs, 'ABERTA')
                    """
                ),
                {
                    "kit_id": int(sol.get("kit_id") or 0),
                    "item_id": int(row["item_id"]),
                    "canon": canon,
                    "motivo": (motivo or "AUSENTE").upper(),
                    "obs": obs,
                },
            )
            pendencias.append(f"{row.get('descricao') or row.get('patrimonio')}")

    db.execute(
        text(
            """
            UPDATE solicitacoes_retirada
            SET status = 'ENTREGUE', entregue_em = NOW(), admin_user_id = :uid
            WHERE id = :sid
            """
        ),
        {"uid": int(payload["uid"]), "sid": operacao_id},
    )

    # Registra posse do kit para o encarregado
    if sol.get("kit_id") and sol.get("encarregado_id"):
        db.execute(
            text(
                """
                UPDATE posses
                SET status = 'ENCERRADA', updated_at = NOW()
                WHERE tipo = 'KIT' AND kit_id = :kit_id AND is_ativa = 1
                """
            ),
            {"kit_id": int(sol.get("kit_id"))},
        )
        db.execute(
            text(
                """
                INSERT INTO posses (tipo, kit_id, encarregado_id, status, created_at)
                VALUES ('KIT', :kit_id, :enc_id, 'ATIVA', NOW())
                """
            ),
            {"kit_id": int(sol.get("kit_id")), "enc_id": int(sol.get("encarregado_id"))},
        )

    if pendencias and sol.get("termo_id"):
        termo_row = db.execute(
            text("SELECT texto_termo FROM termos_responsabilidade WHERE id = :tid"),
            {"tid": int(sol.get("termo_id"))},
        ).mappings().first()
        if termo_row:
            bloco = "\n\nKIT ENTREGUE COM PENDENCIA:\n" + "\n".join(
                f"- {p}" for p in pendencias
            )
            novo_texto = (termo_row.get("texto_termo") or "") + bloco
            db.execute(
                text(
                    "UPDATE termos_responsabilidade SET texto_termo = :txt WHERE id = :tid"
                ),
                {"txt": novo_texto, "tid": int(sol.get("termo_id"))},
            )

    db.commit()
    return {"ok": True}


@router.post("/solicitacoes/operacao/{operacao_id}/aprovar-substituicao", dependencies=[Depends(require_roles(["admin"]))])
def aprovar_substituicao_admin(
    operacao_id: int,
    body: AdminAprovarSubstituicaoIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    req = ConcluirOperacaoIn(admin_pin=body.admin_pin, item_substituto_id=body.substituto_item_id)
    return concluir_operacao(operacao_id, req, db=db, payload=payload)


@router.post("/solicitacoes/operacao/{operacao_id}/confirmar-devolucao", dependencies=[Depends(require_roles(["admin"]))])
def confirmar_devolucao_admin(
    operacao_id: int,
    body: AdminPinOnlyIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    req = ConcluirOperacaoIn(admin_pin=body.admin_pin)
    return concluir_operacao(operacao_id, req, db=db, payload=payload)


@router.post("/solicitacoes/operacao/{operacao_id}/conferir-devolucao", dependencies=[Depends(require_roles(["admin"]))])
def conferir_devolucao_admin(
    operacao_id: int,
    body: ConferenciaDevolucaoIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    ensure_operacoes_table(db)
    ensure_itens_columns(db)
    _ensure_kit_pendencias(db)
    require_admin_pin(db, payload, body.admin_pin)

    op = db.execute(
        text("SELECT * FROM solicitacoes_operacao WHERE id = :oid"),
        {"oid": operacao_id},
    ).mappings().first()
    if not op:
        raise HTTPException(status_code=404, detail="Operacao nao encontrada")
    if (op.get("tipo") or "").upper() not in ("DEVOLUCAO_KIT", "DEVOLUCAO_AVULSO"):
        raise HTTPException(status_code=400, detail="Operacao nao eh devolucao")

    itens = body.itens or []
    for it in itens:
        status = (it.status or "").upper()
        if status == "PRESENTE":
            continue
        motivo = (it.motivo or "PERDA").upper()
        obs = (it.anexo_path or "").strip() or None
        canon_row = db.execute(
            text("SELECT descricao_canonica, descricao FROM itens WHERE id = :id"),
            {"id": int(it.item_id)},
        ).mappings().first()
        canon = (canon_row.get("descricao_canonica") if canon_row else None) or normalize_desc(
            canon_row.get("descricao") if canon_row else ""
        )
        db.execute(
            text(
                """
                INSERT INTO kit_pendencias
                  (kit_id, item_id, descricao_canonica, motivo, observacao, status)
                VALUES
                  (:kit_id, :item_id, :canon, :motivo, :obs, 'ABERTA')
                """
            ),
            {
                "kit_id": int(op.get("kit_id") or 0),
                "item_id": int(it.item_id),
                "canon": canon,
                "motivo": motivo,
                "obs": obs,
            },
        )

    db.execute(
        text(
            """
            UPDATE solicitacoes_operacao
            SET status = 'CONCLUIDA',
                admin_user_id = :uid,
                concluido_em = NOW(),
                pendente_key = NULL
            WHERE id = :oid
            """
        ),
        {"uid": int(payload["uid"]), "oid": operacao_id},
    )

    # Encerrar posse ativa do kit devolvido
    if op.get("kit_id"):
        db.execute(
            text(
                """
                UPDATE posses
                SET status = 'ENCERRADA', updated_at = NOW()
                WHERE tipo = 'KIT' AND kit_id = :kit_id AND is_ativa = 1
                """
            ),
            {"kit_id": int(op.get("kit_id"))},
        )

        # Se existir coluna disponivel em kits, atualiza conforme pendencias
        has_disponivel = db.execute(
            text("SHOW COLUMNS FROM kits LIKE 'disponivel'")
        ).first()
        if has_disponivel:
            pend_count = db.execute(
                text(
                    """
                    SELECT COUNT(*) AS c
                    FROM kit_pendencias
                    WHERE kit_id = :kit_id AND status = 'ABERTA'
                    """
                ),
                {"kit_id": int(op.get("kit_id"))},
            ).scalar() or 0
            db.execute(
                text("UPDATE kits SET disponivel = :d WHERE id = :kit_id"),
                {"d": 0 if pend_count else 1, "kit_id": int(op.get("kit_id"))},
            )

    db.commit()
    return {"ok": True}


@router.post("/credenciais/reset-senha", dependencies=[Depends(require_roles(["admin"]))])
def reset_senha_admin(
    body: AdminResetSenhaIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    _ensure_users_columns(db)
    require_admin_pin(db, payload, body.admin_pin)
    default_pwd = os.getenv("DEFAULT_PASSWORD", "Perfil@2026")
    pwd_hash = hash_password(default_pwd)
    db.execute(
        text(
            """
            UPDATE users
            SET password_hash = :ph, precisa_definir_senha = 1
            WHERE id = :uid
            """
        ),
        {"ph": pwd_hash, "uid": int(body.user_id)},
    )
    db.commit()
    return {"ok": True}


@router.post("/credenciais/alterar-pin-subresponsavel", dependencies=[Depends(require_roles(["admin"]))])
def alterar_pin_subresponsavel(
    body: AdminAlterarPinSubrespIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    require_admin_pin(db, payload, body.admin_pin)
    pin = (body.novo_pin or "").strip()
    if pin != (body.confirmar_pin or "").strip():
        raise HTTPException(status_code=400, detail="PINs nao conferem")
    if not (pin.isdigit() and len(pin) == 6):
        raise HTTPException(status_code=400, detail="PIN deve ter 6 digitos")
    db.execute(
        text("UPDATE subresponsaveis SET pin_hash=:ph, pin=NULL WHERE id=:id"),
        {"ph": hash_pin(pin), "id": int(body.subresponsavel_id)},
    )
    db.commit()
    return {"ok": True}


@router.get("/avulsos/disponiveis", dependencies=[Depends(require_roles(["admin"]))])
def listar_avulsos_disponiveis(
    classe_tipo: Optional[str] = Query(default=None),
    query: str = Query(default=""),
    db: Session = Depends(get_db),
):
    ensure_itens_columns(db)
    q = (query or "").strip()
    q_like = f"%{q}%"
    rows = db.execute(
        text(
            """
            SELECT i.id, i.patrimonio, i.descricao, i.descricao_canonica, i.classe_tipo
            FROM itens i
            LEFT JOIN kit_itens ki ON ki.item_id = i.id
            WHERE ki.item_id IS NULL
              AND i.ativo = 1
              AND i.disponivel = 1
              AND (:classe_tipo IS NULL OR i.classe_tipo = :classe_tipo)
              AND (:q = '' OR i.patrimonio LIKE :q_like OR i.descricao LIKE :q_like)
            ORDER BY i.descricao, i.patrimonio
            LIMIT 200
            """
        ),
        {"classe_tipo": classe_tipo, "q": q, "q_like": q_like},
    ).mappings().all()
    return {"items": rows}


@router.get("/substituicao/candidatos", dependencies=[Depends(require_roles(["admin"]))])
def listar_candidatos_substituicao(
    descricao_canonica: str = Query(default=""),
    kit_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
):
    ensure_itens_columns(db)
    canon = (descricao_canonica or "").strip()
    if not canon:
        return {"avulsos": [], "kits": []}

    avulsos = db.execute(
        text(
            """
            SELECT i.id, i.patrimonio, i.descricao, i.descricao_canonica, i.classe_tipo
            FROM itens i
            LEFT JOIN kit_itens ki ON ki.item_id = i.id
            WHERE ki.item_id IS NULL
              AND i.ativo = 1
              AND i.disponivel = 1
              AND i.descricao_canonica = :canon
            ORDER BY i.patrimonio
            LIMIT 200
            """
        ),
        {"canon": canon},
    ).mappings().all()

    kits = db.execute(
        text(
            """
            SELECT i.id, i.patrimonio, i.descricao, i.descricao_canonica, i.classe_tipo,
                   k.id AS kit_id, k.nome AS kit_nome
            FROM kit_itens ki
            JOIN itens i ON i.id = ki.item_id
            JOIN kits k ON k.id = ki.kit_id
            WHERE i.ativo = 1
              AND i.disponivel = 1
              AND i.descricao_canonica = :canon
              AND (:kit_id IS NULL OR k.id <> :kit_id)
            ORDER BY k.nome, i.patrimonio
            LIMIT 200
            """
        ),
        {"canon": canon, "kit_id": kit_id},
    ).mappings().all()

    return {"avulsos": avulsos, "kits": kits}


@router.get("/kits/pendencias", dependencies=[Depends(require_roles(["admin"]))])
def listar_kits_pendencias(db: Session = Depends(get_db)):
    _ensure_kit_pendencias(db)
    rows = db.execute(
        text(
            """
            SELECT kp.*, k.nome AS kit_nome
            FROM kit_pendencias kp
            LEFT JOIN kits k ON k.id = kp.kit_id
            WHERE kp.status = 'ABERTA'
            ORDER BY kp.id DESC
            LIMIT 200
            """
        )
    ).mappings().all()
    return {"items": rows}


@router.post("/kits/pendencias/{pendencia_id}/resolver", dependencies=[Depends(require_roles(["admin"]))])
def resolver_kit_pendencia(pendencia_id: int, db: Session = Depends(get_db)):
    _ensure_kit_pendencias(db)
    res = db.execute(
        text(
            """
            UPDATE kit_pendencias
            SET status = 'RESOLVIDA', encerrado_em = NOW()
            WHERE id = :pid
            """
        ),
        {"pid": pendencia_id},
    )
    db.commit()
    if res.rowcount == 0:
        raise HTTPException(status_code=404, detail="Pendencia nao encontrada")
    return {"ok": True}


@router.get("/usuarios", dependencies=[Depends(require_roles(["admin"]))])
def listar_usuarios(
    query: str = Query(default=""),
    db: Session = Depends(get_db),
):
    _ensure_users_columns(db)
    q = (query or "").strip().lower()
    q_like = f"%{q}%"
    rows = db.execute(
        text(
            """
            SELECT id, username, nome, role, ativo, subresponsavel_id, encarregado_id
            FROM users
            WHERE (:q = '' OR LOWER(username) LIKE :q_like OR LOWER(nome) LIKE :q_like)
            ORDER BY nome
            LIMIT 200
            """
        ),
        {"q": q, "q_like": q_like},
    ).mappings().all()
    return {"items": rows}


@router.post("/usuarios", dependencies=[Depends(require_roles(["admin"]))])
def criar_usuario(
    body: AdminUsuarioCreateIn,
    db: Session = Depends(get_db),
):
    _ensure_users_columns(db)
    username = (body.username or "").strip()
    nome = (body.nome_completo or "").strip()
    perfil = (body.perfil or "").strip().upper()
    if not username or not nome:
        raise HTTPException(status_code=400, detail="Nome e username obrigatorios")

    role_map = {
        "ENCARREGADO": "funcionario",
        "SUPERVISOR": "funcionario",
        "FUNCIONARIO": "funcionario",
        "ADMIN": "admin",
        "MANUTENCAO": "manutencao",
    }
    role = role_map.get(perfil)
    if not role:
        raise HTTPException(status_code=400, detail="perfil invalido")

    exists = db.execute(
        text("SELECT 1 FROM users WHERE LOWER(username) = :u LIMIT 1"),
        {"u": username.lower()},
    ).first()
    if exists:
        raise HTTPException(status_code=409, detail="username ja existe")

    default_pwd = os.getenv("DEFAULT_PASSWORD", "Perfil@2026")
    pwd_hash = hash_password(default_pwd)
    precisa_pin = 1 if role == "admin" else 0

    db.execute(
        text(
            """
            INSERT INTO users
              (username, nome, subresponsavel_id, encarregado_id, role,
               password_hash, ativo, precisa_definir_senha, precisa_definir_pin)
            VALUES
              (:username, :nome, :sub_id, :enc_id, :role,
               :pwd_hash, :ativo, 1, :precisa_pin)
            """
        ),
        {
            "username": username,
            "nome": nome,
            "sub_id": body.subresponsavel_id,
            "enc_id": body.encarregado_id,
            "role": role,
            "pwd_hash": pwd_hash,
            "ativo": 1 if body.ativo else 0,
            "precisa_pin": precisa_pin,
        },
    )
    db.commit()
    return {"ok": True, "username": username}


@router.post("/usuarios/{user_id}/ativar", dependencies=[Depends(require_roles(["admin"]))])
def ativar_usuario(user_id: int, db: Session = Depends(get_db)):
    db.execute(text("UPDATE users SET ativo = 1 WHERE id = :uid"), {"uid": user_id})
    db.commit()
    return {"ok": True}


@router.post("/usuarios/{user_id}/desativar", dependencies=[Depends(require_roles(["admin"]))])
def desativar_usuario(user_id: int, db: Session = Depends(get_db)):
    db.execute(text("UPDATE users SET ativo = 0 WHERE id = :uid"), {"uid": user_id})
    db.commit()
    return {"ok": True}


@router.post("/subresponsaveis", dependencies=[Depends(require_roles(["admin"]))])
def criar_subresponsavel(
    body: AdminSubresponsavelCreateIn,
    db: Session = Depends(get_db),
):
    nome = (body.nome or "").strip()
    if not nome:
        raise HTTPException(status_code=400, detail="Nome obrigatorio")
    db.execute(
        text(
            """
            INSERT INTO subresponsaveis (nome, secao, ativo)
            VALUES (:nome, :secao, :ativo)
            """
        ),
        {
            "nome": nome,
            "secao": (body.secao or "").strip() or None,
            "ativo": 1 if body.ativo else 0,
        },
    )
    db.commit()
    return {"ok": True}
