from typing import List, Optional

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from backend.app.database import SessionLocal, Base, engine
from backend.app import models, schemas
from backend.app.routers import subresponsaveis, movimentos

# ======================================================
# APP
# ======================================================
app = FastAPI(
    title="Controle de Ferramental – Backend",
    version="1.0.0",
)

# ======================================================
# CORS – LIBERADO PARA REDE (DEV INTERNO)
# ======================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://192.168.0.130:5173",  # seu IP atual
        # se mudar de rede, ajuste aqui
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
# ROUTERS (NOVOS)
# ======================================================
app.include_router(subresponsaveis.router, tags=["Subresponsáveis"])
app.include_router(movimentos.router, tags=["Movimentos"])

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
# ITENS
# ======================================================
@app.post("/itens/", response_model=schemas.Item)
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
@app.post("/setores/", response_model=schemas.Setor)
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
@app.post("/encarregados/", response_model=schemas.Encarregado)
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
@app.post("/kits/", response_model=schemas.Kit)
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

# ======================================================
# KIT x ITENS
# ======================================================
@app.post("/kits/itens/", response_model=schemas.KitItem)
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

    return [
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

# ======================================================
# CHECKLIST SEMANAL
# ======================================================
@app.post("/checklists-semanais/", response_model=schemas.ChecklistSemanal)
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
