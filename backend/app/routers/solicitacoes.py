from __future__ import annotations

import re
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..core.auth import get_current_token, get_db, require_roles, get_user_row
from ..routers.movimentos import ensure_movimentos_columns
from ..utils.normalizer import normalize_desc
from ..utils.security import verify_pin


router = APIRouter(prefix="/solicitacoes", tags=["Solicitacoes"])


def ensure_tables(db: Session) -> None:
    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS solicitacoes_retirada (
              id INT AUTO_INCREMENT PRIMARY KEY,
              tipo VARCHAR(20) NOT NULL,
              kit_id INT NULL,
              termo_id INT NULL,
              solicitante_user_id INT NOT NULL,
              encarregado_id INT NULL,
              subresponsavel_id INT NULL,
              status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
              criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              entregue_em DATETIME NULL,
              admin_user_id INT NULL
            )
            """
        )
    )
    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS solicitacao_itens (
              id INT AUTO_INCREMENT PRIMARY KEY,
              solicitacao_id INT NOT NULL,
              item_id INT NULL,
              manual_item_id INT NULL,
              quantidade_solicitada INT NOT NULL DEFAULT 1,
              quantidade_entregue INT NULL,
              status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
              admin_user_id INT NULL,
              atualizado_em DATETIME NULL
            )
            """
        )
    )
    db.commit()


def ensure_operacoes_table(db: Session) -> None:
    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS solicitacoes_operacao (
              id INT AUTO_INCREMENT PRIMARY KEY,
              tipo VARCHAR(30) NOT NULL,
              kit_id INT NULL,
              item_id INT NULL,
              item_substituto_id INT NULL,
              pendente_key VARCHAR(120) NULL,
              solicitante_user_id INT NOT NULL,
              encarregado_id INT NULL,
              subresponsavel_id INT NULL,
              status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
              observacao TEXT NULL,
              criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              concluido_em DATETIME NULL,
              admin_user_id INT NULL
            )
            """
        )
    )
    try:
        db.execute(text("ALTER TABLE solicitacoes_operacao ADD COLUMN pendente_key VARCHAR(120) NULL"))
    except Exception:
        pass
    _dedupe_substituicoes_pendentes(db)
    _dedupe_devolucoes_pendentes(db)
    try:
        db.execute(
            text(
                "CREATE UNIQUE INDEX ux_solicitacoes_operacao_pendente_key ON solicitacoes_operacao (pendente_key)"
            )
        )
    except Exception:
        pass
    db.commit()


def ensure_itens_columns(db: Session) -> None:
    columns = [
        ("classe_tipo", "VARCHAR(50) NULL"),
        ("descricao_canonica", "VARCHAR(255) NULL"),
        ("disponivel", "INT NOT NULL DEFAULT 1"),
    ]
    for column, col_type in columns:
        try:
            db.execute(text(f"ALTER TABLE itens ADD COLUMN {column} {col_type}"))
        except Exception:
            pass
    rows = db.execute(
        text("SELECT id, descricao FROM itens WHERE descricao_canonica IS NULL AND descricao IS NOT NULL")
    ).mappings().all()
    for row in rows:
        canon = normalize_desc(row.get("descricao"))
        if not canon:
            continue
        db.execute(
            text("UPDATE itens SET descricao_canonica = :canon WHERE id = :id"),
            {"canon": canon, "id": row["id"]},
        )
    db.commit()


def _dedupe_substituicoes_pendentes(db: Session) -> None:
    rows = db.execute(
        text(
            """
            SELECT id, kit_id, item_id, pendente_key
            FROM solicitacoes_operacao
            WHERE tipo = 'SUBSTITUICAO_ITEM' AND status = 'PENDENTE'
            ORDER BY id ASC
            """
        )
    ).mappings().all()
    seen = set()
    for row in rows:
        kit_id = row.get("kit_id")
        item_id = row.get("item_id")
        if not kit_id or not item_id:
            continue
        key = f"SUBSTITUICAO_ITEM:{kit_id}:{item_id}"
        if key in seen:
            db.execute(text("DELETE FROM solicitacoes_operacao WHERE id = :id"), {"id": row["id"]})
            continue
        seen.add(key)
        if row.get("pendente_key") != key:
            # Evita violar UNIQUE quando existir histórico com a mesma chave
            db.execute(
                text(
                    """
                    UPDATE solicitacoes_operacao
                    SET pendente_key = NULL
                    WHERE pendente_key = :key AND status <> 'PENDENTE'
                    """
                ),
                {"key": key},
            )
            db.execute(
                text("UPDATE solicitacoes_operacao SET pendente_key = :key WHERE id = :id"),
                {"key": key, "id": row["id"]},
            )


def _dedupe_devolucoes_pendentes(db: Session) -> None:
    rows = db.execute(
        text(
            """
            SELECT id, tipo, kit_id, item_id, pendente_key
            FROM solicitacoes_operacao
            WHERE tipo IN ('DEVOLUCAO_KIT','DEVOLUCAO_AVULSO') AND status = 'PENDENTE'
            ORDER BY id ASC
            """
        )
    ).mappings().all()
    seen = set()
    for row in rows:
        if row.get("tipo") == "DEVOLUCAO_KIT" and row.get("kit_id"):
            key = f"DEVOLUCAO_KIT:{row['kit_id']}"
        elif row.get("tipo") == "DEVOLUCAO_AVULSO" and row.get("item_id"):
            key = f"DEVOLUCAO_AVULSO:{row['item_id']}"
        else:
            continue
        if key in seen:
            db.execute(text("DELETE FROM solicitacoes_operacao WHERE id = :id"), {"id": row["id"]})
            continue
        seen.add(key)
        if row.get("pendente_key") != key:
            # Evita violar UNIQUE quando existir histórico com a mesma chave
            db.execute(
                text(
                    """
                    UPDATE solicitacoes_operacao
                    SET pendente_key = NULL
                    WHERE pendente_key = :key AND status <> 'PENDENTE'
                    """
                ),
                {"key": key},
            )
            db.execute(
                text("UPDATE solicitacoes_operacao SET pendente_key = :key WHERE id = :id"),
                {"key": key, "id": row["id"]},
            )


def ensure_subresponsavel_pin_hash(db: Session) -> None:
    try:
        db.execute(text("ALTER TABLE subresponsaveis ADD COLUMN pin_hash TEXT NULL"))
    except Exception:
        pass
    rows = db.execute(
        text("SELECT id, pin FROM subresponsaveis WHERE pin_hash IS NULL AND pin IS NOT NULL")
    ).mappings().all()
    from ..utils.security import hash_pin
    for row in rows:
        try:
            db.execute(
                text("UPDATE subresponsaveis SET pin_hash=:ph, pin=NULL WHERE id=:id"),
                {"ph": hash_pin(str(row["pin"]).strip()), "id": row["id"]},
            )
        except Exception:
            pass
    db.commit()


def ensure_user_admin_pin(db: Session) -> None:
    try:
        db.execute(text("ALTER TABLE users ADD COLUMN admin_pin_hash TEXT NULL"))
    except Exception:
        pass
    try:
        db.execute(text("ALTER TABLE users ADD COLUMN precisa_definir_pin INT NOT NULL DEFAULT 1"))
    except Exception:
        pass
    db.commit()


def ensure_kit_pendencias(db: Session) -> None:
    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS kit_pendencias (
              id INT AUTO_INCREMENT PRIMARY KEY,
              kit_id INT NOT NULL,
              item_id INT NULL,
              descricao_canonica VARCHAR(255) NULL,
              motivo VARCHAR(50) NOT NULL,
              bo_ref TEXT NULL,
              termo_id INT NULL,
              responsavel_tipo VARCHAR(20) NULL,
              responsavel_id INT NULL,
              resolucao_acao VARCHAR(30) NULL,
              resolvido_por_item_id INT NULL,
              resolvido_em DATETIME NULL,
              resolvido_por_user_id INT NULL,
              observacao TEXT NULL,
              status VARCHAR(20) NOT NULL DEFAULT 'ABERTA',
              criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              encerrado_em DATETIME NULL
            )
            """
        )
    )
    columns = [
        ("bo_ref", "TEXT NULL"),
        ("termo_id", "INT NULL"),
        ("responsavel_tipo", "VARCHAR(20) NULL"),
        ("responsavel_id", "INT NULL"),
        ("resolucao_acao", "VARCHAR(30) NULL"),
        ("resolvido_por_item_id", "INT NULL"),
        ("resolvido_em", "DATETIME NULL"),
        ("resolvido_por_user_id", "INT NULL"),
    ]
    for column, col_type in columns:
        try:
            db.execute(text(f"ALTER TABLE kit_pendencias ADD COLUMN {column} {col_type}"))
        except Exception:
            pass
    db.commit()


def normalize_model(value: str) -> str:
    return normalize_desc(value)


class SolicitacaoManualItem(BaseModel):
    manual_item_id: int
    quantidade: int = Field(default=1, ge=1)


class SolicitacaoManualIn(BaseModel):
    termo_id: int
    itens: List[SolicitacaoManualItem]


class SolicitacaoEletricaIn(BaseModel):
    termo_id: int
    kit_id: int


class SolicitacaoOperacaoIn(BaseModel):
    tipo: str
    kit_id: Optional[int] = None
    item_id: Optional[int] = None
    item_substituto_id: Optional[int] = None
    observacao: Optional[str] = None
    pin: Optional[str] = None


class ConcluirOperacaoIn(BaseModel):
    item_id: Optional[int] = None
    item_substituto_id: Optional[int] = None
    admin_pin: Optional[str] = None
    motivo: Optional[str] = None
    bo_ref: Optional[str] = None
    termo_id: Optional[int] = None
    responsavel_tipo: Optional[str] = None
    responsavel_id: Optional[int] = None


class AdminPinIn(BaseModel):
    admin_pin: str


def require_admin_pin(db: Session, payload: dict, admin_pin: Optional[str]) -> None:
    ensure_user_admin_pin(db)
    pin = (admin_pin or "").strip()
    if not (pin.isdigit() and len(pin) == 4):
        raise HTTPException(status_code=400, detail="PIN admin deve ter 4 digitos")
    row = db.execute(
        text("SELECT admin_pin_hash FROM users WHERE id = :uid"),
        {"uid": int(payload["uid"])},
    ).mappings().first()
    if not row or not row.get("admin_pin_hash"):
        raise HTTPException(status_code=400, detail="PIN admin nao cadastrado")
    if not verify_pin(pin, row["admin_pin_hash"]):
        raise HTTPException(status_code=401, detail="PIN admin invalido")


@router.post("/manual", dependencies=[Depends(require_roles(["admin", "funcionario"]))])
def criar_solicitacao_manual(
    body: SolicitacaoManualIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    ensure_tables(db)
    ensure_subresponsavel_pin_hash(db)

    sub_id = payload.get("subresponsavel_id")
    enc_id = payload.get("encarregado_id")
    if sub_id is None and enc_id is None:
        user = get_user_row(db, payload.get("sub"))
        sub_id = user["subresponsavel_id"] if user else None
        enc_id = user.get("encarregado_id") if user else None

    if sub_id is None and enc_id is None:
        raise HTTPException(status_code=400, detail="Usuario sem subresponsavel_id ou encarregado_id")

    if tipo == "SUBSTITUICAO_ITEM":
        pin = (body.pin or "").strip()
        if not pin:
            raise HTTPException(status_code=400, detail="PIN obrigatorio para substituir item")
        if not sub_id:
            raise HTTPException(status_code=400, detail="Subresponsavel nao identificado para PIN")
        sub_row = db.execute(
            text("SELECT pin_hash FROM subresponsaveis WHERE id = :id"),
            {"id": int(sub_id)},
        ).mappings().first()
        if not sub_row or not verify_pin(pin, sub_row.get("pin_hash")):
            raise HTTPException(status_code=401, detail="PIN do subresponsavel invalido")

    db.execute(
        text(
            """
            INSERT INTO solicitacoes_retirada
              (tipo, kit_id, termo_id, solicitante_user_id, encarregado_id, subresponsavel_id, status)
            VALUES
              ('MANUAL', NULL, :termo_id, :uid, :enc_id, :sub_id, 'PENDENTE')
            """
        ),
        {
            "termo_id": int(body.termo_id),
            "uid": int(payload["uid"]),
            "enc_id": enc_id,
            "sub_id": sub_id,
        },
    )
    sol_id = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()

    for it in body.itens:
        db.execute(
            text(
                """
                INSERT INTO solicitacao_itens
                  (solicitacao_id, manual_item_id, quantidade_solicitada, status)
                VALUES
                  (:sid, :mid, :q, 'PENDENTE')
                """
            ),
            {"sid": int(sol_id), "mid": int(it.manual_item_id), "q": int(it.quantidade)},
        )

    db.commit()
    return {"ok": True, "solicitacao_id": sol_id}


@router.post("/eletrico", dependencies=[Depends(require_roles(["admin", "funcionario"]))])
def criar_solicitacao_eletrica(
    body: SolicitacaoEletricaIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    ensure_tables(db)

    sub_id = payload.get("subresponsavel_id")
    enc_id = payload.get("encarregado_id")
    if sub_id is None and enc_id is None:
        user = get_user_row(db, payload.get("sub"))
        sub_id = user["subresponsavel_id"] if user else None
        enc_id = user.get("encarregado_id") if user else None

    if sub_id is None and enc_id is None:
        raise HTTPException(status_code=400, detail="Usuario sem subresponsavel_id ou encarregado_id")

    db.execute(
        text(
            """
            INSERT INTO solicitacoes_retirada
              (tipo, kit_id, termo_id, solicitante_user_id, encarregado_id, subresponsavel_id, status)
            VALUES
              ('ELETRICO', :kit_id, :termo_id, :uid, :enc_id, :sub_id, 'PENDENTE')
            """
        ),
        {
            "kit_id": int(body.kit_id),
            "termo_id": int(body.termo_id),
            "uid": int(payload["uid"]),
            "enc_id": enc_id,
            "sub_id": sub_id,
        },
    )
    sol_id = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()

    kit_itens = db.execute(
        text(
            """
            SELECT ki.item_id, ki.quantidade
            FROM kit_itens ki
            WHERE ki.kit_id = :kit_id
            """
        ),
        {"kit_id": int(body.kit_id)},
    ).mappings().all()

    for it in kit_itens:
        db.execute(
            text(
                """
                INSERT INTO solicitacao_itens
                  (solicitacao_id, item_id, quantidade_solicitada, status)
                VALUES
                  (:sid, :item_id, :q, 'PENDENTE')
                """
            ),
            {"sid": int(sol_id), "item_id": int(it["item_id"]), "q": int(it["quantidade"] or 1)},
        )

    db.commit()
    return {"ok": True, "solicitacao_id": sol_id}


@router.post("/operacao", dependencies=[Depends(require_roles(["admin", "funcionario"]))])
def criar_solicitacao_operacao(
    body: SolicitacaoOperacaoIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    ensure_operacoes_table(db)

    tipo = (body.tipo or "").strip().upper()
    if tipo not in ("DEVOLUCAO_KIT", "DEVOLUCAO_AVULSO", "SUBSTITUICAO_ITEM", "ADICAO_AVULSO"):
        raise HTTPException(status_code=400, detail="Tipo de solicitacao invalido")

    sub_id = payload.get("subresponsavel_id")
    enc_id = payload.get("encarregado_id")
    if sub_id is None and enc_id is None:
        user = get_user_row(db, payload.get("sub"))
        sub_id = user["subresponsavel_id"] if user else None
        enc_id = user.get("encarregado_id") if user else None

    if sub_id is None and enc_id is None:
        raise HTTPException(status_code=400, detail="Usuario sem subresponsavel_id ou encarregado_id")

    pendente_key = None
    if tipo == "SUBSTITUICAO_ITEM" and body.kit_id and body.item_id:
        pendente_key = f"SUBSTITUICAO_ITEM:{int(body.kit_id)}:{int(body.item_id)}"
    elif tipo == "DEVOLUCAO_KIT" and body.kit_id:
        pendente_key = f"DEVOLUCAO_KIT:{int(body.kit_id)}"
    elif tipo == "DEVOLUCAO_AVULSO" and body.item_id:
        pendente_key = f"DEVOLUCAO_AVULSO:{int(body.item_id)}"

    if pendente_key:
        existing = db.execute(
            text(
                """
                SELECT id
                FROM solicitacoes_operacao
                WHERE pendente_key = :key AND status = 'PENDENTE'
                LIMIT 1
                """
            ),
            {"key": pendente_key},
        ).first()
        if existing:
            return {"ok": True, "solicitacao_id": existing[0], "duplicado": True}

    db.execute(
        text(
            """
            INSERT INTO solicitacoes_operacao
              (tipo, kit_id, item_id, item_substituto_id, pendente_key, solicitante_user_id,
               encarregado_id, subresponsavel_id, status, observacao)
            VALUES
              (:tipo, :kit_id, :item_id, :item_substituto_id, :pendente_key, :uid,
               :enc_id, :sub_id, 'PENDENTE', :obs)
            """
        ),
        {
            "tipo": tipo,
            "kit_id": body.kit_id,
            "item_id": body.item_id,
            "item_substituto_id": body.item_substituto_id,
            "pendente_key": pendente_key,
            "uid": int(payload["uid"]),
            "enc_id": enc_id,
            "sub_id": sub_id,
            "obs": (body.observacao or "").strip() or None,
        },
    )
    sol_id = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()
    db.commit()
    return {"ok": True, "solicitacao_id": sol_id}


@router.get("/operacao/minhas", dependencies=[Depends(require_roles(["admin", "funcionario"]))])
def listar_operacoes_minhas(
    status: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    ensure_operacoes_table(db)
    uid = int(payload["uid"])
    rows = db.execute(
        text(
            """
            SELECT id, tipo, kit_id, item_id, status, criado_em
            FROM solicitacoes_operacao
            WHERE solicitante_user_id = :uid
              AND (:status IS NULL OR status = :status)
            ORDER BY id DESC
            LIMIT 200
            """
        ),
        {"uid": uid, "status": status},
    ).mappings().all()
    return {"items": rows}


@router.get("/operacao/admin", dependencies=[Depends(require_roles(["admin"]))])
def listar_operacoes_admin(
    tipo: str = Query(default=""),
    status: Optional[str] = Query(default=None),
    query: str = Query(default=""),
    data_ini: Optional[str] = Query(default=None),
    data_fim: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    ensure_operacoes_table(db)
    q = query.strip()
    q_like = f"%{q}%"

    rows = db.execute(
        text(
            """
            SELECT
              o.*,
              u.nome AS solicitante_nome,
              k.nome AS kit_nome,
              i.patrimonio AS item_patrimonio,
              i.descricao AS item_descricao,
              isub.patrimonio AS item_sub_patrimonio,
              isub.descricao AS item_sub_descricao
            FROM solicitacoes_operacao o
            LEFT JOIN users u ON u.id = o.solicitante_user_id
            LEFT JOIN kits k ON k.id = o.kit_id
            LEFT JOIN itens i ON i.id = o.item_id
            LEFT JOIN itens isub ON isub.id = o.item_substituto_id
            WHERE (:tipo = '' OR o.tipo = :tipo)
              AND (:status IS NULL OR o.status = :status)
              AND (
                :q = '' OR
                u.nome LIKE :q_like OR
                k.nome LIKE :q_like OR
                i.patrimonio LIKE :q_like OR
                i.descricao LIKE :q_like OR
                o.observacao LIKE :q_like
              )
              AND (:data_ini IS NULL OR o.criado_em >= :data_ini)
              AND (:data_fim IS NULL OR o.criado_em <= :data_fim)
            ORDER BY o.id DESC
            LIMIT 200
            """
        ),
        {
            "tipo": tipo,
            "status": status,
            "q": q,
            "q_like": q_like,
            "data_ini": data_ini,
            "data_fim": data_fim,
        },
    ).mappings().all()

    return {"operacoes": rows}


@router.post("/operacao/admin/{operacao_id}/concluir", dependencies=[Depends(require_roles(["admin"]))])
def concluir_operacao(
    operacao_id: int,
    body: ConcluirOperacaoIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    ensure_operacoes_table(db)
    op = db.execute(
        text("SELECT * FROM solicitacoes_operacao WHERE id = :oid"),
        {"oid": operacao_id},
    ).mappings().first()
    if not op:
        raise HTTPException(status_code=404, detail="Operacao nao encontrada")

    if op["status"] == "CONCLUIDA":
        return {"ok": True, "status": "CONCLUIDA"}

    require_admin_pin(db, payload, body.admin_pin)

    tipo = (op["tipo"] or "").upper()
    if tipo == "SUBSTITUICAO_ITEM":
        ensure_movimentos_columns(db)
        ensure_itens_columns(db)
        if not body.item_substituto_id:
            raise HTTPException(status_code=400, detail="item_substituto_id obrigatorio")
        motivo = (body.motivo or "").strip().upper()
        bo_ref = (body.bo_ref or "").strip()
        termo_id = int(body.termo_id) if body.termo_id else None
        resp_tipo = (body.responsavel_tipo or "").strip().upper()
        resp_id = int(body.responsavel_id) if body.responsavel_id else None

        if motivo not in ("PERDA", "FURTO", "MANUTENCAO"):
            raise HTTPException(status_code=400, detail="motivo invalido (PERDA/FURTO/MANUTENCAO)")
        if motivo == "FURTO" and not bo_ref:
            raise HTTPException(status_code=400, detail="bo_ref obrigatorio para FURTO")
        if motivo == "PERDA":
            if resp_tipo not in ("USER", "SUBRESP"):
                raise HTTPException(status_code=400, detail="responsavel_tipo invalido (USER/SUBRESP)")
            if not resp_id or not termo_id:
                raise HTTPException(
                    status_code=400,
                    detail="responsavel_id e termo_id obrigatorios para PERDA",
                )

        original = db.execute(
            text("SELECT id, patrimonio, descricao, descricao_canonica, classe_tipo FROM itens WHERE id = :id"),
            {"id": op["item_id"]},
        ).mappings().first()
        substituto = db.execute(
            text(
                """
                SELECT i.id, i.patrimonio, i.descricao, i.descricao_canonica, i.classe_tipo,
                       i.ativo, i.disponivel, ki.item_id AS kit_item_id
                FROM itens i
                LEFT JOIN kit_itens ki ON ki.item_id = i.id
                WHERE i.id = :id
                """
            ),
            {"id": body.item_substituto_id},
        ).mappings().first()
        if not original or not substituto:
            raise HTTPException(status_code=404, detail="Item original/substituto nao encontrado")

        orig_desc = (original.get("descricao_canonica") or "").strip() or normalize_desc(
            original.get("descricao") or ""
        )
        sub_desc = (substituto.get("descricao_canonica") or "").strip() or normalize_desc(
            substituto.get("descricao") or ""
        )
        if orig_desc and sub_desc and orig_desc != sub_desc:
            raise HTTPException(status_code=400, detail="Substituto deve ter a mesma descricao_canonica")
        if int(substituto.get("ativo") or 0) != 1:
            raise HTTPException(status_code=409, detail="SUBSTITUTO_NOT_AVAILABLE")
        if int(substituto.get("disponivel") or 0) != 1:
            raise HTTPException(status_code=409, detail="SUBSTITUTO_NOT_AVAILABLE")
        if substituto.get("kit_item_id"):
            raise HTTPException(status_code=409, detail="SUBSTITUTO_NOT_AVAILABLE")

        # Atualiza composicao do kit: sai original, entra substituto
        if op.get("kit_id"):
            db.execute(
                text("DELETE FROM kit_itens WHERE kit_id = :kit_id AND item_id = :item_id"),
                {"kit_id": int(op.get("kit_id")), "item_id": int(original["id"])},
            )
            existing = db.execute(
                text("SELECT id FROM kit_itens WHERE kit_id = :kit_id AND item_id = :item_id LIMIT 1"),
                {"kit_id": int(op.get("kit_id")), "item_id": int(substituto["id"])},
            ).first()
            if not existing:
                db.execute(
                    text("INSERT INTO kit_itens (kit_id, item_id, quantidade) VALUES (:kit_id, :item_id, 1)"),
                    {"kit_id": int(op.get("kit_id")), "item_id": int(substituto["id"])},
                )

        db.execute(
            text("UPDATE itens SET disponivel = 0 WHERE id = :id"),
            {"id": int(body.item_substituto_id)},
        )
        db.execute(
            text("UPDATE itens SET disponivel = 1 WHERE id = :id"),
            {"id": int(original["id"])},
        )

        obs_extra = f"motivo={motivo}"
        if motivo == "FURTO":
            obs_extra += f" | bo_ref={bo_ref}"
        if motivo == "PERDA":
            obs_extra += f" | termo_id={termo_id} | responsavel={resp_tipo}:{resp_id}"

        db.execute(
            text(
                """
                UPDATE solicitacoes_operacao
                SET status = 'CONCLUIDA',
                    item_substituto_id = :sub_id,
                    motivo = :motivo,
                    observacao = :obs,
                    admin_user_id = :uid,
                    concluido_em = NOW(),
                    pendente_key = NULL
                WHERE id = :oid
                """
            ),
            {
                "sub_id": int(body.item_substituto_id),
                "uid": int(payload["uid"]),
                "oid": operacao_id,
                "motivo": motivo,
                "obs": obs_extra,
            },
        )
        enc_id = op.get("encarregado_id") or op.get("solicitante_user_id")
        obs_base = f"Substituicao: {original['patrimonio']} -> {substituto['patrimonio']} | {obs_extra}"
        db.execute(
            text(
                """
                INSERT INTO item_movimentos
                  (data_hora, kit_id, encarregado_id, item_id, acao, subresponsavel_id,
                   latitude, longitude, observacao, registrado_por_id, pin_tipo, pin_autor_id,
                   termo_id, item_substituto_id)
                VALUES
                  (NOW(), :kit_id, :enc_id, :item_id, 'SUBSTITUIR', NULL,
                   NULL, NULL, :obs, :reg_id, 'ADMIN_4', :pin_autor, NULL, :sub_item_id)
                """
            ),
            {
                "kit_id": op.get("kit_id"),
                "enc_id": enc_id,
                "item_id": original["id"],
                "obs": obs_base,
                "reg_id": int(payload["uid"]),
                "pin_autor": int(payload["uid"]),
                "sub_item_id": substituto["id"],
            },
        )
        db.execute(
            text(
                """
                INSERT INTO movimentos
                  (tipo, kit_id, patrimonio, encarregado_id, subresponsavel_id, quantidade, observacao,
                   registrado_por_id, pin_tipo, pin_autor_id, termo_id)
                VALUES
                  ('SUBSTITUIR', :kit_id, :pat, :enc_id, NULL, 1, :obs,
                   :reg_id, 'ADMIN_4', :pin_autor, NULL)
                """
            ),
            {
                "kit_id": op.get("kit_id"),
                "pat": original["patrimonio"],
                "enc_id": enc_id,
                "obs": obs_base,
                "reg_id": int(payload["uid"]),
                "pin_autor": int(payload["uid"]),
            },
        )
        db.execute(
            text(
                """
                INSERT INTO movimentos
                  (tipo, kit_id, patrimonio, encarregado_id, subresponsavel_id, quantidade, observacao,
                   registrado_por_id, pin_tipo, pin_autor_id, termo_id)
                VALUES
                  ('SUBSTITUIR_ENTRA', :kit_id, :pat, :enc_id, NULL, 1, :obs,
                   :reg_id, 'ADMIN_4', :pin_autor, NULL)
                """
            ),
            {
                "kit_id": op.get("kit_id"),
                "pat": substituto["patrimonio"],
                "enc_id": enc_id,
                "obs": f"Entrada por substituicao do {original['patrimonio']}",
                "reg_id": int(payload["uid"]),
                "pin_autor": int(payload["uid"]),
            },
        )
    else:
        update = {
            "oid": operacao_id,
            "uid": int(payload["uid"]),
            "item_id": int(body.item_id) if body.item_id else None,
        }
        db.execute(
            text(
                """
                UPDATE solicitacoes_operacao
                SET status = 'CONCLUIDA',
                    item_id = COALESCE(:item_id, item_id),
                    admin_user_id = :uid,
                    concluido_em = NOW(),
                    pendente_key = NULL
                WHERE id = :oid
                """
            ),
            update,
        )

    db.commit()
    return {"ok": True}


@router.get("/admin", dependencies=[Depends(require_roles(["admin"]))])
def listar_solicitacoes_admin(
    tipo: str = Query(default=""),
    status: Optional[str] = Query(default=None),
    query: str = Query(default=""),
    setor_id: Optional[int] = Query(default=None),
    pessoa_tipo: Optional[str] = Query(default=None),
    pessoa_id: Optional[int] = Query(default=None),
    data_ini: Optional[str] = Query(default=None),
    data_fim: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    ensure_tables(db)
    q = query.strip()
    q_like = f"%{q}%"

    rows = db.execute(
        text(
            """
            SELECT
              s.id,
              s.tipo,
              s.kit_id,
              s.termo_id,
              s.status,
              s.criado_em,
              s.entregue_em,
              s.solicitante_user_id,
              s.encarregado_id,
              s.subresponsavel_id,
              u.nome AS solicitante_nome,
              k.nome AS kit_nome,
              k.tipo AS kit_tipo,
              st.nome AS setor_nome,
              (
                SELECT COUNT(*) FROM solicitacao_itens si
                WHERE si.solicitacao_id = s.id
              ) AS total_itens,
              (
                SELECT COUNT(*) FROM solicitacao_itens si
                WHERE si.solicitacao_id = s.id AND si.status = 'AUSENTE'
              ) AS ausentes,
              (
                SELECT COUNT(*) FROM solicitacao_itens si
                WHERE si.solicitacao_id = s.id AND si.status = 'ENTREGUE'
              ) AS entregues
            FROM solicitacoes_retirada s
            LEFT JOIN users u ON u.id = s.solicitante_user_id
            LEFT JOIN kits k ON k.id = s.kit_id
            LEFT JOIN setores st ON st.id = k.setor_id
            LEFT JOIN termos_responsabilidade tr ON tr.id = s.termo_id
            WHERE (:tipo = '' OR s.tipo = :tipo)
              AND (:status IS NULL OR s.status = :status)
              AND (
                :q = '' OR
                u.nome LIKE :q_like OR
                k.nome LIKE :q_like
              )
              AND (:setor_id IS NULL OR k.setor_id = :setor_id)
              AND (
                :pessoa_tipo IS NULL OR
                (:pessoa_tipo = 'encarregado' AND s.encarregado_id = :pessoa_id) OR
                (:pessoa_tipo = 'subresponsavel' AND s.subresponsavel_id = :pessoa_id)
              )
              AND (:data_ini IS NULL OR COALESCE(tr.criado_em, s.criado_em) >= :data_ini)
              AND (:data_fim IS NULL OR COALESCE(tr.criado_em, s.criado_em) <= :data_fim)
            ORDER BY s.id DESC
            LIMIT 200
            """
        ),
        {
            "tipo": tipo,
            "status": status,
            "q": q,
            "q_like": q_like,
            "setor_id": setor_id,
            "pessoa_tipo": pessoa_tipo,
            "pessoa_id": pessoa_id,
            "data_ini": data_ini,
            "data_fim": data_fim,
        },
    ).mappings().all()

    return {"solicitacoes": rows}


@router.get("/admin/{solicitacao_id}", dependencies=[Depends(require_roles(["admin"]))])
def detalhe_solicitacao(
    solicitacao_id: int,
    db: Session = Depends(get_db),
):
    ensure_tables(db)
    sol = db.execute(
        text(
            """
            SELECT s.*, u.nome AS solicitante_nome, k.nome AS kit_nome, st.nome AS setor_nome
            FROM solicitacoes_retirada s
            LEFT JOIN users u ON u.id = s.solicitante_user_id
            LEFT JOIN kits k ON k.id = s.kit_id
            LEFT JOIN setores st ON st.id = k.setor_id
            WHERE s.id = :sid
            LIMIT 1
            """
        ),
        {"sid": solicitacao_id},
    ).mappings().first()
    if not sol:
        raise HTTPException(status_code=404, detail="Solicitacao nao encontrada")

    termo = None
    if sol.get("termo_id"):
        termo = db.execute(
            text(
                """
                SELECT id, texto_termo, assinatura_nome, latitude, longitude, criado_em, subresponsavel_id
                FROM termos_responsabilidade
                WHERE id = :tid
                """
            ),
            {"tid": sol["termo_id"]},
        ).mappings().first()

    if sol["tipo"] == "MANUAL":
        itens = db.execute(
            text(
                """
                SELECT si.id AS solicitacao_item_id, si.manual_item_id, si.quantidade_solicitada,
                       si.quantidade_entregue, si.status, mi.nome AS manual_item_nome
                FROM solicitacao_itens si
                JOIN manual_itens mi ON mi.id = si.manual_item_id
                WHERE si.solicitacao_id = :sid
                ORDER BY mi.nome
                """
            ),
            {"sid": solicitacao_id},
        ).mappings().all()
    else:
        itens = db.execute(
            text(
                """
                SELECT si.id AS solicitacao_item_id, si.item_id, si.quantidade_solicitada,
                       si.quantidade_entregue, si.status, i.patrimonio, i.descricao, i.descricao_canonica
                FROM solicitacao_itens si
                JOIN itens i ON i.id = si.item_id
                WHERE si.solicitacao_id = :sid
                ORDER BY i.patrimonio
                """
            ),
            {"sid": solicitacao_id},
        ).mappings().all()

    return {"solicitacao": sol, "itens": itens, "termo": termo}


@router.post("/admin/{solicitacao_id}/itens/{item_line_id}/ausente", dependencies=[Depends(require_roles(["admin"]))])
def marcar_item_ausente(
    solicitacao_id: int,
    item_line_id: int,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    ensure_tables(db)
    res = db.execute(
        text(
            """
            UPDATE solicitacao_itens
            SET status = 'AUSENTE',
                quantidade_entregue = 0,
                admin_user_id = :uid,
                atualizado_em = NOW()
            WHERE id = :iid AND solicitacao_id = :sid
            """
        ),
        {"uid": int(payload["uid"]), "iid": item_line_id, "sid": solicitacao_id},
    )
    db.commit()
    if res.rowcount == 0:
        raise HTTPException(status_code=404, detail="Item da solicitacao nao encontrado")
    return {"ok": True}


@router.post("/admin/{solicitacao_id}/concluir", dependencies=[Depends(require_roles(["admin"]))])
def concluir_solicitacao(
    solicitacao_id: int,
    body: AdminPinIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    ensure_tables(db)
    require_admin_pin(db, payload, body.admin_pin)
    sol = db.execute(
        text("SELECT * FROM solicitacoes_retirada WHERE id = :sid"),
        {"sid": solicitacao_id},
    ).mappings().first()
    if not sol:
        raise HTTPException(status_code=404, detail="Solicitacao nao encontrada")

    db.execute(
        text(
            """
            UPDATE solicitacoes_retirada
            SET status = 'ENTREGUE', entregue_em = NOW(), admin_user_id = :uid
            WHERE id = :sid
            """
        ),
        {"uid": int(payload["uid"]), "sid": solicitacao_id},
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
        {"uid": int(payload["uid"]), "sid": solicitacao_id},
    )

    # Atualiza posse manual quando for solicitacao manual
    if sol["tipo"] == "MANUAL":
        itens = db.execute(
            text(
                """
                SELECT manual_item_id, quantidade_solicitada, status
                FROM solicitacao_itens
                WHERE solicitacao_id = :sid
                """
            ),
            {"sid": solicitacao_id},
        ).mappings().all()

        for it in itens:
            if it["status"] == "AUSENTE":
                continue
            q = int(it["quantidade_solicitada"] or 1)
            if sol.get("subresponsavel_id"):
                existing = db.execute(
                    text(
                        """
                        SELECT id, quantidade FROM manual_posse
                        WHERE subresponsavel_id = :sub_id AND manual_item_id = :item_id
                        LIMIT 1
                        """
                    ),
                    {"sub_id": sol["subresponsavel_id"], "item_id": it["manual_item_id"]},
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
                    {"enc_id": sol.get("encarregado_id"), "item_id": it["manual_item_id"]},
                ).mappings().first()

            if existing:
                db.execute(
                    text(
                        """
                        UPDATE manual_posse
                        SET quantidade = :q, data_retirada = CURRENT_DATE()
                        WHERE id = :id
                        """
                    ),
                    {"q": int(existing["quantidade"]) + q, "id": existing["id"]},
                )
            else:
                db.execute(
                    text(
                        """
                        INSERT INTO manual_posse
                        (subresponsavel_id, encarregado_id, manual_item_id, quantidade, data_retirada)
                        VALUES
                        (:sub_id, :enc_id, :item_id, :q, CURRENT_DATE())
                        """
                    ),
                    {
                        "sub_id": sol.get("subresponsavel_id"),
                        "enc_id": sol.get("encarregado_id"),
                        "item_id": it["manual_item_id"],
                        "q": q,
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
                    "item_id": it["manual_item_id"],
                    "enc_id": sol.get("encarregado_id"),
                    "sub_id": sol.get("subresponsavel_id"),
                    "q": q,
                    "obs": "ADMIN_ENTREGA",
                },
            )

    db.commit()
    return {"ok": True}


@router.post("/admin/{solicitacao_id}/reset", dependencies=[Depends(require_roles(["admin"]))])
@router.post("/admin/{solicitacao_id}/reset/", dependencies=[Depends(require_roles(["admin"]))])
def reset_solicitacao(
    solicitacao_id: int,
    db: Session = Depends(get_db),
):
    ensure_tables(db)
    res = db.execute(
        text("SELECT id FROM solicitacoes_retirada WHERE id = :sid"),
        {"sid": solicitacao_id},
    ).mappings().first()
    if not res:
        raise HTTPException(status_code=404, detail="Solicitacao nao encontrada")

    db.execute(
        text(
            """
            UPDATE solicitacoes_retirada
            SET status = 'PENDENTE',
                entregue_em = NULL,
                admin_user_id = NULL
            WHERE id = :sid
            """
        ),
        {"sid": solicitacao_id},
    )
    db.execute(
        text(
            """
            UPDATE solicitacao_itens
            SET status = 'PENDENTE',
                quantidade_entregue = NULL,
                admin_user_id = NULL,
                atualizado_em = NULL
            WHERE solicitacao_id = :sid
            """
        ),
        {"sid": solicitacao_id},
    )
    db.commit()
    return {"ok": True}
