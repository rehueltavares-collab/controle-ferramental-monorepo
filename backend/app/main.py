from typing import List, Optional

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.database import SessionLocal, Base, engine
from app import models, schemas

# =========================
# Bootstrap do banco
# =========================
# Cria tabelas que não existirem
Base.metadata.create_all(bind=engine)


def ensure_sqlite_schema():
    """
    SQLite não faz migration automática.
    Esse "patch" garante que a coluna kit_id exista na tabela checklists_semanais.
    """
    with engine.connect() as conn:
        # Confere se a tabela existe
        tables = [r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()]
        if "checklists_semanais" not in tables:
            return

        # Lista colunas existentes
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(checklists_semanais)")).fetchall()]

        # Se faltar kit_id, adiciona
        if "kit_id" not in cols:
            conn.execute(text("ALTER TABLE checklists_semanais ADD COLUMN kit_id INTEGER"))
            conn.commit()


# roda no startup do app
ensure_sqlite_schema()

# =========================
# App
# =========================
app = FastAPI(title="Controle de Ferramental – Kits")

# ---------- CORS (PWA) ----------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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

@app.get("/health/")
def health():
    return {"status": "healthy"}

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
"http://localhost:5174",
"http://127.0.0.1:5174",
