# backend/app/main.py
import os
from typing import List, Optional

from dotenv import load_dotenv

# Carrega .env antes de qualquer coisa que dependa de env (JWT / DB / etc.)
load_dotenv()

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import bindparam, text

# ✅ IMPORTS CERTOS (sem "backend.app...")
from .database import SessionLocal, Base, engine
from . import models, schemas
from .routers import (
    subresponsaveis,
    movimentos,
    auth,
    termos,
    manuais,
    admin,
    avulsos,
    posses,
    solicitacoes,
    solicitacoes_operacao,
    admin_solicitacoes_operacao,
    status_overview,
)
from .core.auth import get_current_token, require_roles
from .core import security

# ======================================================
# APP
# ======================================================
app = FastAPI(
    title="Controle de Ferramental – Backend",
    version="1.0.0",
)

# ======================================================
# DEBUG JWT (pra matar "Invalid token" sem adivinhação)
# ======================================================
@app.get("/debug/jwt")
def debug_jwt():
    s = os.getenv("JWT_SECRET") or ""
    return {"env_len": len(s), "env_head": s[:6]}


@app.get("/debug/jwt2")
def debug_jwt2():
    s_env = os.getenv("JWT_SECRET") or ""
    s_mod = getattr(security, "JWT_SECRET", "") or ""
    return {
        "env_len": len(s_env),
        "env_head": s_env[:6],
        "mod_len": len(s_mod),
        "mod_head": s_mod[:6],
        "eq": s_env == s_mod,
    }

# ======================================================
# CORS / TrustedHost (ALLOWED_HOSTS)
# Opção A: Front chama /api (mesmo host) -> quase zero dor de CORS
# ======================================================

def _parse_env_list(name: str) -> list[str]:
    raw = os.getenv(name, "")
    return [entry.strip() for entry in raw.split(",") if entry.strip()]

ENV = os.getenv("ENV", "dev").lower()

DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://localhost:5173",
    "https://127.0.0.1:5173",
    "https://api-ferramental.local:5173",
    "http://api-ferramental.local:5173",
]

origins = _parse_env_list("CORS_ORIGINS") or DEFAULT_CORS_ORIGINS

DEFAULT_ALLOWED_HOSTS = [
    "localhost",
    "127.0.0.1",
    "api-ferramental.local",
    "ferramental.local",
    "ferramentas.perfilx.com.br",
]

allowed_hosts = _parse_env_list("ALLOWED_HOSTS") or DEFAULT_ALLOWED_HOSTS
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)

cors_kwargs = dict(
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Coloca CORS por último para garantir headers mesmo em respostas geradas
# por middlewares internos (ex: TrustedHost).
app.add_middleware(CORSMiddleware, **cors_kwargs)

# ======================================================
# DATABASE
# ======================================================
Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ======================================================
# ROUTERS
# ======================================================
# auth + termos (MariaDB direto) e o resto (SQLAlchemy / MySQL)
app.include_router(auth.router, tags=["Auth"])
app.include_router(termos.router, tags=["Termos"])
app.include_router(subresponsaveis.router, tags=["Subresponsáveis"])
app.include_router(movimentos.router, tags=["Movimentos"])
app.include_router(manuais.router, tags=["Manuais"])
app.include_router(admin.router, tags=["Admin"])
app.include_router(avulsos.router, tags=["Avulsos"])
app.include_router(posses.router)
app.include_router(solicitacoes.router)
app.include_router(solicitacoes_operacao.router)
app.include_router(admin_solicitacoes_operacao.router)
app.include_router(status_overview.router)

# ======================================================
# HEALTHCHECK
# ======================================================
@app.get("/")
def healthcheck():
    return {
        "status": "ok",
        "mensagem": "API Controle de Ferramental rodando",
    }

# ======================================================
# ME (token check)
# ======================================================
@app.get("/me")
def me(payload: dict = Depends(get_current_token)):
    return {"user": payload.get("sub"), "role": payload.get("role")}

# ======================================================
# ITENS
# ======================================================
@app.post(
    "/itens/",
    response_model=schemas.Item,
    dependencies=[Depends(require_roles(["admin", "manutencao"]))],
)
def criar_item(payload: schemas.ItemCreate, db: Session = Depends(get_db)):
    item = models.Item(
        patrimonio=payload.patrimonio,
        descricao=payload.descricao,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@app.get("/itens/", response_model=List[schemas.Item])
def listar_itens(db: Session = Depends(get_db)):
    return db.query(models.Item).all()

# ======================================================
# SETORES
# ======================================================
@app.post(
    "/setores/",
    response_model=schemas.Setor,
    dependencies=[Depends(require_roles(["admin", "manutencao"]))],
)
def criar_setor(payload: schemas.SetorCreate, db: Session = Depends(get_db)):
    setor = models.Setor(nome=payload.nome)
    db.add(setor)
    db.commit()
    db.refresh(setor)
    return setor


@app.get("/setores/", response_model=List[schemas.Setor])
def listar_setores(db: Session = Depends(get_db)):
    return db.query(models.Setor).all()

# ======================================================
# ENCARREGADOS
# ======================================================
@app.post(
    "/encarregados/",
    response_model=schemas.Encarregado,
    dependencies=[Depends(require_roles(["admin", "manutencao"]))],
)
def criar_encarregado(payload: schemas.EncarregadoCreate, db: Session = Depends(get_db)):
    enc = models.Encarregado(
        setor_id=payload.setor_id,
        nome=payload.nome,
        funcao=payload.funcao,
        telefone=payload.telefone,
    )
    db.add(enc)
    db.commit()
    db.refresh(enc)
    return enc


@app.get("/encarregados/", response_model=List[schemas.Encarregado])
def listar_encarregados(
    setor_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    q = db.query(models.Encarregado)
    if setor_id is not None:
        q = q.filter(models.Encarregado.setor_id == setor_id)
    return q.all()

# ======================================================
# KITS
# ======================================================
@app.post(
    "/kits/",
    response_model=schemas.Kit,
    dependencies=[Depends(require_roles(["admin", "manutencao"]))],
)
def criar_kit(payload: schemas.KitCreate, db: Session = Depends(get_db)):
    kit = models.Kit(
        nome=payload.nome,
        setor_id=payload.setor_id,
        tipo=payload.tipo,
    )
    db.add(kit)
    db.commit()
    db.refresh(kit)
    return kit


@app.get("/kits/", response_model=List[schemas.Kit])
def listar_kits(
    setor_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    q = db.query(models.Kit)
    if setor_id is not None:
        q = q.filter(models.Kit.setor_id == setor_id)
    return q.all()


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


@app.get("/kits/pendencias")
def listar_kits_pendencias(db: Session = Depends(get_db), _: dict = Depends(require_roles(["admin", "manutencao", "funcionario"]))):
    ensure_kit_pendencias(db)
    rows = db.execute(
        text(
            """
            SELECT kit_id
            FROM kit_pendencias
            WHERE status = 'ABERTA'
            """
        )
    ).mappings().all()
    return {"kits": [r["kit_id"] for r in rows]}

# ======================================================
# KIT x ITENS
# ======================================================
@app.post(
    "/kits/itens/",
    response_model=schemas.KitItem,
    dependencies=[Depends(require_roles(["admin", "manutencao"]))],
)
def adicionar_item_kit(payload: schemas.KitItemCreate, db: Session = Depends(get_db)):
    ki = models.KitItem(
        kit_id=payload.kit_id,
        item_id=payload.item_id,
        quantidade=payload.quantidade,
    )
    db.add(ki)
    db.commit()
    db.refresh(ki)
    return ki


@app.get("/kits/{kit_id}/itens/", response_model=List[schemas.KitItem])
def listar_itens_kit(kit_id: int, db: Session = Depends(get_db)):
    return (
        db.query(models.KitItem)
        .filter(models.KitItem.kit_id == kit_id)
        .all()
    )

# ======================================================
# ITENS DETALHADOS (PWA)
# ======================================================
@app.get("/kits/{kit_id}/itens-detalhados/")
def listar_itens_kit_detalhados(kit_id: int, db: Session = Depends(get_db)):
    q = (
        db.query(
            models.KitItem.id.label("kit_item_id"),
            models.KitItem.kit_id,
            models.KitItem.item_id,
            models.KitItem.quantidade,
            models.Item.patrimonio,
            models.Item.descricao,
        )
        .join(models.Item, models.Item.id == models.KitItem.item_id)
        .filter(models.KitItem.kit_id == kit_id)
        .order_by(models.Item.patrimonio.asc())
    )

    rows = q.all()
    item_ids = [r.item_id for r in rows]

    last_movs = {}
    if item_ids:
        mov_rows = (
            db.execute(
                text(
                    """
                    SELECT last.item_id, last.acao, last.data_hora, last.subresponsavel_id
                    FROM item_movimentos last
                    JOIN (
                        SELECT item_id, MAX(id) AS max_id
                        FROM item_movimentos
                        WHERE item_id IN :item_ids
                        GROUP BY item_id
                    ) sub ON sub.item_id = last.item_id AND sub.max_id = last.id
                    """
                ).bindparams(bindparam("item_ids", expanding=True)),
                {"item_ids": item_ids},
            )
            .mappings()
            .all()
        )

        for m in mov_rows:
            last_movs[int(m["item_id"])] = {
                "acao": m["acao"],
                "data_hora": m["data_hora"],
                "subresponsavel_id": m["subresponsavel_id"],
            }

    def _status_from_acao(acao: Optional[str]) -> str:
        a = (acao or "").strip().upper()
        if a.startswith("DISTRIBU"):
            return "DISTRIBUIDO"
        if a.startswith("RECOLH") or a == "PRESENTE":
            return "PRESENTE"
        return "PRESENTE"

    payload = []
    for r in rows:
        last = last_movs.get(int(r.item_id))
        status_item = _status_from_acao(last["acao"] if last else None)
        payload.append(
            {
                "kit_item_id": r.kit_item_id,
                "kit_id": r.kit_id,
                "item_id": r.item_id,
                "quantidade": r.quantidade,
                "patrimonio": r.patrimonio,
                "descricao": r.descricao,
                "status_item": status_item,
                "ultimo_movimento": last,
            }
        )

    return payload

# ======================================================
# CHECKLIST SEMANAL
# ======================================================
@app.post(
    "/checklists-semanais/",
    response_model=schemas.ChecklistSemanal,
    dependencies=[Depends(require_roles(["admin", "manutencao", "funcionario"]))],
)
def criar_checklist(payload: schemas.ChecklistSemanalCreate, db: Session = Depends(get_db)):
    chk = models.ChecklistSemanal(
        kit_id=payload.kit_id,
        encarregado_id=payload.encarregado_id,
        latitude=payload.latitude,
        longitude=payload.longitude,
        patrimonios_declarados=payload.patrimonios_declarados,
    )
    db.add(chk)
    db.commit()
    db.refresh(chk)
    return chk


@app.get("/checklists-semanais/", response_model=List[schemas.ChecklistSemanal])
def listar_checklists(db: Session = Depends(get_db)):
    return db.query(models.ChecklistSemanal).all()
