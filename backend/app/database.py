from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# Caminho do banco SQLite (arquivo na raiz do projeto)
DATABASE_URL = "sqlite:///./ferramental.db"

# Cria o engine de conexão com o banco
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}
)

# Cria a sessão de acesso ao banco
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base para todos os models (tabelas)
Base = declarative_base()
