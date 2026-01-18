from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..core.auth import get_current_token, get_db, require_roles, get_user_row
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
    db.commit()


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


class AdminPinIn(BaseModel):
    admin_pin: str


def require_admin_pin(db: Session, payload: dict, admin_pin: Optional[str]) -> None:
    pin = (admin_pin or "").strip()
    if not (pin.isdigit() and len(pin) == 6):
        raise HTTPException(status_code=400, detail="PIN admin deve ter 6 digitos")
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
    if tipo not in ("DEVOLUCAO_KIT", "SUBSTITUICAO_ITEM", "ADICAO_AVULSO"):
        raise HTTPException(status_code=400, detail="Tipo de solicitacao invalido")

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
            INSERT INTO solicitacoes_operacao
              (tipo, kit_id, item_id, item_substituto_id, solicitante_user_id,
               encarregado_id, subresponsavel_id, status, observacao)
            VALUES
              (:tipo, :kit_id, :item_id, :item_substituto_id, :uid,
               :enc_id, :sub_id, 'PENDENTE', :obs)
            """
        ),
        {
            "tipo": tipo,
            "kit_id": body.kit_id,
            "item_id": body.item_id,
            "item_substituto_id": body.item_substituto_id,
            "uid": int(payload["uid"]),
            "enc_id": enc_id,
            "sub_id": sub_id,
            "obs": (body.observacao or "").strip() or None,
        },
    )
    sol_id = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()
    db.commit()
    return {"ok": True, "solicitacao_id": sol_id}


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
        if not body.item_substituto_id:
            raise HTTPException(status_code=400, detail="item_substituto_id obrigatorio")

        original = db.execute(
            text("SELECT id, descricao FROM itens WHERE id = :id"),
            {"id": op["item_id"]},
        ).mappings().first()
        substituto = db.execute(
            text("SELECT id, descricao FROM itens WHERE id = :id"),
            {"id": body.item_substituto_id},
        ).mappings().first()
        if not original or not substituto:
            raise HTTPException(status_code=404, detail="Item original/substituto nao encontrado")

        if (original["descricao"] or "").strip() != (substituto["descricao"] or "").strip():
            raise HTTPException(status_code=400, detail="Substituto deve ter o mesmo modelo/descricao")

        res = db.execute(
            text(
                """
                UPDATE kit_itens
                SET item_id = :novo_item
                WHERE kit_id = :kit_id AND item_id = :item_id
                """
            ),
            {"novo_item": int(body.item_substituto_id), "kit_id": int(op["kit_id"]), "item_id": int(op["item_id"])},
        )
        if res.rowcount == 0:
            raise HTTPException(status_code=400, detail="Item nao encontrado no kit para substituicao")

        db.execute(
            text(
                """
                UPDATE solicitacoes_operacao
                SET status = 'CONCLUIDA',
                    item_substituto_id = :sub_id,
                    admin_user_id = :uid,
                    concluido_em = NOW()
                WHERE id = :oid
                """
            ),
            {"sub_id": int(body.item_substituto_id), "uid": int(payload["uid"]), "oid": operacao_id},
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
                    concluido_em = NOW()
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
                       si.quantidade_entregue, si.status, i.patrimonio, i.descricao
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
