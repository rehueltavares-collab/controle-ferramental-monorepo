from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Optional, Any, Dict, List

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field


router = APIRouter(prefix="/movimentos-manuais", tags=["Movimentos Manuais"])


# =========================
# DB helpers (mesmo padrão)
# =========================

def _project_root() -> Path:
    return Path(__file__).resolve().parents[3]

def _db_path() -> Path:
    root = _project_root()
    data_db = root / "backend" / "data" / "ferramental.db"
    if data_db.exists():
        return data_db
    return root / "ferramental.db"

def _connect() -> sqlite3.Connection:
    con = sqlite3.connect(str(_db_path()))
    con.row_factory = sqlite3.Row
    return con

def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# =========================
# Schema (tabelas)
# =========================

def _ensure_schema() -> None:
    con = _connect()
    cur = con.cursor()

    # saldo atual por kit + item_nome
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS manual_saldos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kit_id INTEGER NOT NULL,
            item_nome TEXT NOT NULL,
            quantidade INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            UNIQUE(kit_id, item_nome)
        );
        """
    )

    # log/auditoria
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS manual_movimentos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kit_id INTEGER NOT NULL,
            item_nome TEXT NOT NULL,
            tipo TEXT NOT NULL, -- RETIRAR | DEVOLVER | AJUSTE
            quantidade INTEGER NOT NULL,
            encarregado_id INTEGER NOT NULL,
            subresponsavel_id INTEGER,
            created_at TEXT NOT NULL,
            observacao TEXT
        );
        """
    )

    # índices (performance)
    for stmt in [
        "CREATE INDEX IF NOT EXISTS idx_manual_mov_kit_created ON manual_movimentos(kit_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_manual_mov_item_created ON manual_movimentos(item_nome, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_manual_mov_sub_created ON manual_movimentos(subresponsavel_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_manual_saldo_kit ON manual_saldos(kit_id)",
    ]:
        try:
            cur.execute(stmt)
        except sqlite3.OperationalError:
            pass

    con.commit()
    con.close()

_ensure_schema()


# =========================
# Validações
# =========================

def _validate_pin(pin: str) -> None:
    if not (pin.isdigit() and len(pin) == 6):
        raise HTTPException(status_code=400, detail="PIN deve ter 6 dígitos numéricos")

def _get_subresponsavel(con: sqlite3.Connection, sub_id: int) -> sqlite3.Row:
    cur = con.cursor()
    row = cur.execute(
        "SELECT id, nome, secao, ativo, pin FROM subresponsaveis WHERE id=?",
        (int(sub_id),),
    ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Subresponsável não encontrado")

    if int(row["ativo"] or 0) != 1:
        raise HTTPException(status_code=400, detail="Subresponsável inativo")

    pin_db = (row["pin"] or "").strip()
    if not pin_db:
        raise HTTPException(status_code=400, detail="Subresponsável sem PIN cadastrado")

    return row

def _check_pin(pin_informado: str, pin_db: str) -> None:
    if str(pin_informado).strip() != str(pin_db).strip():
        raise HTTPException(status_code=401, detail="PIN incorreto")

def _norm_item(nome: str) -> str:
    # padrão simples: tira espaços extras
    n = (nome or "").strip()
    if not n:
        raise HTTPException(status_code=400, detail="item_nome obrigatório")
    return n


# =========================
# Helpers saldo
# =========================

def _get_saldo(con: sqlite3.Connection, kit_id: int, item_nome: str) -> int:
    cur = con.cursor()
    row = cur.execute(
        "SELECT quantidade FROM manual_saldos WHERE kit_id=? AND item_nome=?",
        (int(kit_id), item_nome),
    ).fetchone()
    return int(row["quantidade"]) if row else 0

def _set_saldo(con: sqlite3.Connection, kit_id: int, item_nome: str, new_qty: int) -> None:
    cur = con.cursor()
    now = _utc_now_iso()
    cur.execute(
        """
        INSERT INTO manual_saldos (kit_id, item_nome, quantidade, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(kit_id, item_nome)
        DO UPDATE SET quantidade=excluded.quantidade, updated_at=excluded.updated_at
        """,
        (int(kit_id), item_nome, int(new_qty), now),
    )

def _log_mov(con: sqlite3.Connection, kit_id: int, item_nome: str, tipo: str, quantidade: int,
             encarregado_id: int, subresponsavel_id: Optional[int], observacao: Optional[str]) -> int:
    cur = con.cursor()
    created_at = _utc_now_iso()
    cur.execute(
        """
        INSERT INTO manual_movimentos
        (kit_id, item_nome, tipo, quantidade, encarregado_id, subresponsavel_id, created_at, observacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            int(kit_id),
            item_nome,
            tipo,
            int(quantidade),
            int(encarregado_id),
            int(subresponsavel_id) if subresponsavel_id is not None else None,
            created_at,
            (observacao or "").strip() or None,
        ),
    )
    return int(cur.lastrowid)


# =========================
# Payloads
# =========================

class RetirarBody(BaseModel):
    kit_id: int
    item_nome: str = Field(min_length=1)
    quantidade: int = Field(ge=1)

    encarregado_id: int
    subresponsavel_id: int
    pin: str = Field(min_length=6, max_length=6)

    observacao: Optional[str] = None


class DevolverBody(BaseModel):
    kit_id: int
    item_nome: str = Field(min_length=1)
    quantidade: int = Field(ge=1)

    encarregado_id: int
    subresponsavel_id: Optional[int] = None  # pode devolver sem identificar
    observacao: Optional[str] = None


class AjusteBody(BaseModel):
    kit_id: int
    item_nome: str = Field(min_length=1)
    quantidade_nova: int = Field(ge=0)

    encarregado_id: int
    observacao: Optional[str] = None


# =========================
# Endpoints
# =========================

@router.get("/saldo")
def saldo_atual(kit_id: Optional[int] = None):
    """
    Retorna saldo atual. Se kit_id não vier, devolve todos.
    """
    con = _connect()
    try:
        cur = con.cursor()
        if kit_id is None:
            rows = cur.execute(
                "SELECT kit_id, item_nome, quantidade, updated_at FROM manual_saldos ORDER BY kit_id, item_nome"
            ).fetchall()
        else:
            rows = cur.execute(
                "SELECT kit_id, item_nome, quantidade, updated_at FROM manual_saldos WHERE kit_id=? ORDER BY item_nome",
                (int(kit_id),),
            ).fetchall()

        data = [
            {
                "kit_id": r["kit_id"],
                "item_nome": r["item_nome"],
                "quantidade": int(r["quantidade"]),
                "updated_at": r["updated_at"],
            }
            for r in rows
        ]
        return {"value": data, "Count": len(data), "db_path": str(_db_path())}
    finally:
        con.close()


@router.post("/retirar")
@router.post("/retirar/")
def retirar(body: RetirarBody):
    """
    Retira quantidade do saldo do kit e registra o movimento (exige PIN).
    """
    _validate_pin(body.pin)

    con = _connect()
    try:
        item_nome = _norm_item(body.item_nome)

        sub = _get_subresponsavel(con, body.subresponsavel_id)
        _check_pin(body.pin, sub["pin"])

        atual = _get_saldo(con, body.kit_id, item_nome)
        if body.quantidade > atual:
            raise HTTPException(
                status_code=400,
                detail=f"Saldo insuficiente para '{item_nome}'. Saldo atual={atual}, solicitado={body.quantidade}.",
            )

        novo = atual - int(body.quantidade)

        mov_id = _log_mov(
            con,
            kit_id=body.kit_id,
            item_nome=item_nome,
            tipo="RETIRAR",
            quantidade=body.quantidade,
            encarregado_id=body.encarregado_id,
            subresponsavel_id=body.subresponsavel_id,
            observacao=body.observacao or "PWA",
        )
        _set_saldo(con, body.kit_id, item_nome, novo)

        con.commit()

        return {
            "status": "ok",
            "movimento_id": mov_id,
            "tipo": "RETIRAR",
            "kit_id": body.kit_id,
            "item_nome": item_nome,
            "quantidade": body.quantidade,
            "saldo_antes": atual,
            "saldo_depois": novo,
            "subresponsavel_id": body.subresponsavel_id,
            "subresponsavel_nome": sub["nome"],
            "db_path": str(_db_path()),
        }
    finally:
        con.close()


@router.post("/devolver")
@router.post("/devolver/")
def devolver(body: DevolverBody):
    """
    Devolve quantidade pro saldo do kit e registra o movimento (não exige PIN).
    """
    con = _connect()
    try:
        item_nome = _norm_item(body.item_nome)

        atual = _get_saldo(con, body.kit_id, item_nome)
        novo = atual + int(body.quantidade)

        mov_id = _log_mov(
            con,
            kit_id=body.kit_id,
            item_nome=item_nome,
            tipo="DEVOLVER",
            quantidade=body.quantidade,
            encarregado_id=body.encarregado_id,
            subresponsavel_id=body.subresponsavel_id,
            observacao=body.observacao or "PWA",
        )
        _set_saldo(con, body.kit_id, item_nome, novo)

        con.commit()

        return {
            "status": "ok",
            "movimento_id": mov_id,
            "tipo": "DEVOLVER",
            "kit_id": body.kit_id,
            "item_nome": item_nome,
            "quantidade": body.quantidade,
            "saldo_antes": atual,
            "saldo_depois": novo,
            "db_path": str(_db_path()),
        }
    finally:
        con.close()


@router.post("/ajustar")
@router.post("/ajustar/")
def ajustar(body: AjusteBody):
    """
    Ajuste de inventário (almoxarifado): força saldo novo e registra log.
    Use quando fizer contagem física.
    """
    con = _connect()
    try:
        item_nome = _norm_item(body.item_nome)

        atual = _get_saldo(con, body.kit_id, item_nome)
        novo = int(body.quantidade_nova)

        mov_id = _log_mov(
            con,
            kit_id=body.kit_id,
            item_nome=item_nome,
            tipo="AJUSTE",
            quantidade=(novo - atual),  # delta (pode ser negativo)
            encarregado_id=body.encarregado_id,
            subresponsavel_id=None,
            observacao=body.observacao or "AJUSTE INVENTÁRIO",
        )
        _set_saldo(con, body.kit_id, item_nome, novo)

        con.commit()

        return {
            "status": "ok",
            "movimento_id": mov_id,
            "tipo": "AJUSTE",
            "kit_id": body.kit_id,
            "item_nome": item_nome,
            "saldo_antes": atual,
            "saldo_depois": novo,
            "db_path": str(_db_path()),
        }
    finally:
        con.close()


@router.get("/log")
def log_movimentos(
    kit_id: Optional[int] = None,
    item_nome: Optional[str] = None,
    subresponsavel_id: Optional[int] = None,
    limit: int = Query(default=200, ge=1, le=5000),
):
    """
    Auditoria (últimos movimentos).
    """
    con = _connect()
    try:
        cur = con.cursor()

        where = []
        params: List[Any] = []

        if kit_id is not None:
            where.append("kit_id = ?")
            params.append(int(kit_id))
        if item_nome:
            where.append("item_nome = ?")
            params.append(_norm_item(item_nome))
        if subresponsavel_id is not None:
            where.append("subresponsavel_id = ?")
            params.append(int(subresponsavel_id))

        sql = "SELECT * FROM manual_movimentos"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY datetime(created_at) DESC, id DESC LIMIT ?"
        params.append(int(limit))

        rows = cur.execute(sql, tuple(params)).fetchall()

        data = [
            {
                "id": r["id"],
                "kit_id": r["kit_id"],
                "item_nome": r["item_nome"],
                "tipo": r["tipo"],
                "quantidade": int(r["quantidade"]),
                "encarregado_id": r["encarregado_id"],
                "subresponsavel_id": r["subresponsavel_id"],
                "created_at": r["created_at"],
                "observacao": r["observacao"],
            }
            for r in rows
        ]

        return {"value": data, "Count": len(data), "db_path": str(_db_path())}
    finally:
        con.close()
@router.get("/posse-por-sub")
def posse_por_sub(
    kit_id: int,
    item_nome: Optional[str] = None,
    only_open: bool = True,        # true = só quem está com saldo > 0
    limit: int = Query(default=5000, ge=1, le=50000),
):
    """
    Calcula "posse" por subresponsável (quanto cada um está com ele) a partir do log:
      - RETIRAR soma
      - DEVOLVER subtrai (quando subresponsavel_id vier preenchido)
      - AJUSTE ignora (inventário do kit, não é posse de pessoa)

    Observação:
      - Se DEVOLVER vier sem subresponsavel_id, não dá pra atribuir devolução a alguém
        (fica no saldo do kit, mas não baixa a dívida de ninguém).
    """
    con = _connect()
    try:
        cur = con.cursor()

        where = ["kit_id = ?"]
        params: List[Any] = [int(kit_id)]

        if item_nome:
            where.append("item_nome = ?")
            params.append(_norm_item(item_nome))

        # só movimentos vinculáveis a pessoas
        where.append("subresponsavel_id IS NOT NULL")
        where.append("tipo IN ('RETIRAR','DEVOLVER')")

        sql = f"""
        SELECT
            subresponsavel_id,
            item_nome,
            SUM(
                CASE
                    WHEN tipo='RETIRAR' THEN quantidade
                    WHEN tipo='DEVOLVER' THEN -quantidade
                    ELSE 0
                END
            ) AS em_posse
        FROM manual_movimentos
        WHERE {" AND ".join(where)}
        GROUP BY subresponsavel_id, item_nome
        HAVING 1=1
        """

        if only_open:
            sql += " AND em_posse > 0"

        sql += " ORDER BY em_posse DESC, item_nome ASC LIMIT ?"
        params.append(int(limit))

        rows = cur.execute(sql, tuple(params)).fetchall()

        # puxa nomes (melhor UX)
        sub_ids = sorted({int(r["subresponsavel_id"]) for r in rows})
        sub_map: Dict[int, Dict[str, Any]] = {}
        if sub_ids:
            placeholders = ",".join(["?"] * len(sub_ids))
            sub_rows = cur.execute(
                f"SELECT id, nome, secao, ativo FROM subresponsaveis WHERE id IN ({placeholders})",
                tuple(sub_ids),
            ).fetchall()
            for s in sub_rows:
                sub_map[int(s["id"])] = {
                    "id": int(s["id"]),
                    "nome": s["nome"],
                    "secao": s["secao"],
                    "ativo": int(s["ativo"] or 0),
                }

        data = []
        for r in rows:
            sid = int(r["subresponsavel_id"])
            data.append(
                {
                    "kit_id": int(kit_id),
                    "subresponsavel_id": sid,
                    "subresponsavel_nome": (sub_map.get(sid) or {}).get("nome"),
                    "subresponsavel_secao": (sub_map.get(sid) or {}).get("secao"),
                    "ativo": (sub_map.get(sid) or {}).get("ativo"),
                    "item_nome": r["item_nome"],
                    "quantidade_em_posse": int(r["em_posse"] or 0),
                }
            )

        return {"value": data, "Count": len(data), "db_path": str(_db_path())}
    finally:
        con.close()
