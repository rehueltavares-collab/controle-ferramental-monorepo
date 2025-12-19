from typing import List, Optional

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from .database import SessionLocal, Base, engine
from . import models, schemas
from .routers import subresponsaveis, movimentos

app = FastAPI(title="Controle de Ferramental – Monorepo (Backend FastAPI)")

# ---------- CORS (PWA) ----------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- ROUTERS (NOVOS) ----------
app.include_router(subresponsaveis.router)
app.include_router(movimentos.router)

# ---------- TABELAS ----------
# Garante tabelas (cria novas, não altera colunas antigas)
Base.metadata.create_all(bind=engine)

# ---------- DEPENDÊNCIA DB ----------
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ---------- SAÚDE ----------
@app.get("/")
def read_root():
    return {"status": "ok", "mensagem": "API Controle de Ferramental rodando"}

# ---------- ITENS ----------
@app.post("/itens/", response_model=schemas.Item)
def create_item(item: schemas.ItemCreate, db: Session = Depends(get_db)):
    db_item = models.Item(patrimonio=item.patrimonio, descricao=item.descricao)
    db.add(db_item)
    db.commit()
    db.refresh(db_item)
    return db_item

@app.get("/itens/", response_model=List[schemas.Item])
def list_itens(db: Session = Depends(get_db)):
    return db.query(models.Item).all()

# ---------- SETORES ----------
@app.post("/setores/", response_model=schemas.Setor)
def criar_setor(payload: schemas.SetorCreate, db: Session = Depends(get_db)):
    novo = models.Setor(nome=payload.nome)
    db.add(novo)
    db.commit()
    db.refresh(novo)
    return novo

@app.get("/setores/", response_model=List[schemas.Setor])
def listar_setores(db: Session = Depends(get_db)):
    return db.query(models.Setor).all()

# ---------- ENCARREGADOS ----------
@app.post("/encarregados/", response_model=schemas.Encarregado)
def criar_encarregado(payload: schemas.EncarregadoCreate, db: Session = Depends(get_db)):
    novo = models.Encarregado(
        setor_id=payload.setor_id,
        funcao=payload.funcao,
        nome=payload.nome,
        telefone=payload.telefone,
    )
    db.add(novo)
    db.commit()
    db.refresh(novo)
    return novo

@app.get("/encarregados/", response_model=List[schemas.Encarregado])
def listar_encarregados(setor_id: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(models.Encarregado)
    if setor_id is not None:
        q = q.filter(models.Encarregado.setor_id == setor_id)
    return q.all()

# ---------- KITS ----------
@app.post("/kits/", response_model=schemas.Kit)
def criar_kit(payload: schemas.KitCreate, db: Session = Depends(get_db)):
    novo = models.Kit(nome=payload.nome, setor_id=payload.setor_id, tipo=payload.tipo)
    db.add(novo)
    db.commit()
    db.refresh(novo)
    return novo

@app.get("/kits/", response_model=List[schemas.Kit])
def listar_kits(setor_id: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(models.Kit)
    if setor_id is not None:
        q = q.filter(models.Kit.setor_id == setor_id)
    return q.all()

# ---------- KIT x ITENS ----------
@app.post("/kits/itens/", response_model=schemas.KitItem)
def adicionar_item_kit(payload: schemas.KitItemCreate, db: Session = Depends(get_db)):
    novo = models.KitItem(
        kit_id=payload.kit_id,
        item_id=payload.item_id,
        quantidade=payload.quantidade,
    )
    db.add(novo)
    db.commit()
    db.refresh(novo)
    return novo

@app.get("/kits/{kit_id}/itens/", response_model=List[schemas.KitItem])
def listar_itens_kit(kit_id: int, db: Session = Depends(get_db)):
    return db.query(models.KitItem).filter(models.KitItem.kit_id == kit_id).all()

# >>> ESTE É O QUE O PWA PRECISA: PATRIMÔNIO + DESCRIÇÃO
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

# ---------- CHECKLIST SEMANAL ----------
@app.post("/checklists-semanais/", response_model=schemas.ChecklistSemanal)
def create_checklist(payload: schemas.ChecklistSemanalCreate, db: Session = Depends(get_db)):
    db_check = models.ChecklistSemanal(
        kit_id=payload.kit_id,
        encarregado_id=payload.encarregado_id,
        latitude=payload.latitude,
        longitude=payload.longitude,
        patrimonios_declarados=payload.patrimonios_declarados,
    )
    db.add(db_check)
    db.commit()
    db.refresh(db_check)
    return db_check

@app.get("/checklists-semanais/", response_model=List[schemas.ChecklistSemanal])
def list_checklists(db: Session = Depends(get_db)):
    return db.query(models.ChecklistSemanal).all()
