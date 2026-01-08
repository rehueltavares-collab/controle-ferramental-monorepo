from typing import Optional

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from .database import SessionLocal, Base, engine
from . import models, schemas
from .routers import subresponsaveis, movimentos

app = FastAPI(title="Controle de Ferramental – Backend", version="1.0.0")

# =========================================================
# CORS (DEV / REDE INTERNA)
# =========================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        # se abrir o PWA via IP também (fixo) — opcional
        "http://192.168.1.108:5173",
    ],
    # libera QUALQUER host local/lan em dev (resolve celular/PC sem ficar caçando IP)
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================================================
# DB / Tabelas
# =========================================================
Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# =========================================================
# Routers
# =========================================================
app.include_router(subresponsaveis.router, tags=["Subresponsáveis"])
app.include_router(movimentos.router, tags=["Movimentos"])


# =========================================================
# Health
# =========================================================
@app.get("/")
def healthcheck():
    return {"status": "ok", "mensagem": "API Controle de Ferramental rodando"}


# =========================================================
# ITENS
# =========================================================
@app.post("/itens/", response_model=schemas.Item)
def create_item(payload: schemas.ItemCreate, db: Session = Depends(get_db)):
    item = models.Item(patrimonio=payload.patrimonio, descricao=payload.descricao)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@app.get("/itens/")
def list_itens(db: Session = Depends(get_db)):
    itens = db.query(models.Item).all()
    return {"value": itens, "Count": len(itens)}


# =========================================================
# SETORES
# =========================================================
@app.post("/setores/", response_model=schemas.Setor)
def create_setor(payload: schemas.SetorCreate, db: Session = Depends(get_db)):
    setor = models.Setor(nome=payload.nome)
    db.add(setor)
    db.commit()
    db.refresh(setor)
    return setor


@app.get("/setores/")
def list_setores(db: Session = Depends(get_db)):
    setores = db.query(models.Setor).all()
    return {"value": setores, "Count": len(setores)}


# =========================================================
# ENCARREGADOS
# =========================================================
@app.post("/encarregados/", response_model=schemas.Encarregado)
def create_encarregado(payload: schemas.EncarregadoCreate, db: Session = Depends(get_db)):
    enc = models.Encarregado(
        setor_id=payload.setor_id,
        funcao=payload.funcao,
        nome=payload.nome,
        telefone=payload.telefone,
    )
    db.add(enc)
    db.commit()
    db.refresh(enc)
    return enc


@app.get("/encarregados/")
def list_encarregados(setor_id: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(models.Encarregado)
    if setor_id is not None:
        q = q.filter(models.Encarregado.setor_id == setor_id)
    encs = q.all()
    return {"value": encs, "Count": len(encs)}


# =========================================================
# KITS
# =========================================================
@app.post("/kits/", response_model=schemas.Kit)
def create_kit(payload: schemas.KitCreate, db: Session = Depends(get_db)):
    kit = models.Kit(nome=payload.nome, setor_id=payload.setor_id, tipo=payload.tipo)
    db.add(kit)
    db.commit()
    db.refresh(kit)
    return kit


@app.get("/kits/")
def list_kits(setor_id: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(models.Kit)
    if setor_id is not None:
        q = q.filter(models.Kit.setor_id == setor_id)
    kits = q.all()
    return {"value": kits, "Count": len(kits)}


# =========================================================
# KIT x ITENS
# =========================================================
@app.post("/kits/itens/", response_model=schemas.KitItem)
def add_item_to_kit(payload: schemas.KitItemCreate, db: Session = Depends(get_db)):
    ki = models.KitItem(
        kit_id=payload.kit_id,
        item_id=payload.item_id,
        quantidade=payload.quantidade,
    )
    db.add(ki)
    db.commit()
    db.refresh(ki)
    return ki


@app.get("/kits/{kit_id}/itens/")
def list_kit_itens(kit_id: int, db: Session = Depends(get_db)):
    rows = db.query(models.KitItem).filter(models.KitItem.kit_id == kit_id).all()
    return {"value": rows, "Count": len(rows)}


# =========================================================
# ITENS DETALHADOS (PWA)
# =========================================================
@app.get("/kits/{kit_id}/itens-detalhados/")
def list_itens_kit_detalhados(kit_id: int, db: Session = Depends(get_db)):
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

    rows = [
        {
            "kit_item_id": r.kit_item_id,
            "kit_id": r.kit_id,
            "item_id": r.item_id,
            "quantidade": r.quantidade,
            "patrimonio": r.patrimonio,
            "descricao": r.descricao,
        }
        for r in q.all()
    ]

    return {"value": rows, "Count": len(rows)}


# =========================================================
# CHECKLIST SEMANAL
# =========================================================
@app.post("/checklists-semanais/")
def create_checklist(payload: schemas.ChecklistSemanalCreate, db: Session = Depends(get_db)):
    """
    Não bloqueia operação por GPS 0,0.
    Mantém auditável:
      - latitude/longitude persistidos
      - gps_ok devolvido na resposta
    """
    lat = float(payload.latitude or 0)
    lng = float(payload.longitude or 0)
    gps_ok = not (lat == 0.0 and lng == 0.0)

    chk = models.ChecklistSemanal(
        kit_id=payload.kit_id,
        encarregado_id=payload.encarregado_id,
        latitude=lat,
        longitude=lng,
        patrimonios_declarados=payload.patrimonios_declarados,
    )
    db.add(chk)
    db.commit()
    db.refresh(chk)

    return {
        "id": chk.id,
        "kit_id": chk.kit_id,
        "encarregado_id": chk.encarregado_id,
        "latitude": chk.latitude,
        "longitude": chk.longitude,
        "patrimonios_declarados": chk.patrimonios_declarados,
        "data_hora": chk.data_hora,
        "gps_ok": gps_ok,
    }


@app.get("/checklists-semanais/")
def list_checklists(db: Session = Depends(get_db)):
    rows = db.query(models.ChecklistSemanal).all()
    return {"value": rows, "Count": len(rows)}
