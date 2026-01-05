import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# =========================================================
# DATABASE CONFIG
# =========================================================

# Raiz do projeto: .../controle-ferramental-monorepo
BASE_DIR = Path(__file__).resolve().parents[2]

# Tenta ler do ambiente (.env / variável do sistema)
DATABASE_URL = os.getenv("DATABASE_URL")

# Fallback seguro (DEV): backend/data/ferramental.db
if not DATABASE_URL:
    data_dir = BASE_DIR / "backend" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    db_path = data_dir / "ferramental.db"
    DATABASE_URL = f"sqlite:///{db_path.as_posix()}"

# =========================================================
# SQLALCHEMY ENGINE
# =========================================================

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)

Base = declarative_base()

# =========================================================
# DEPENDENCY (FastAPI)
# =========================================================

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
