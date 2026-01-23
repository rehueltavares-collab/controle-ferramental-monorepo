from datetime import datetime

from sqlalchemy import Column, Integer, String, ForeignKey, DateTime, Float, Text, func
from sqlalchemy.orm import relationship

from .database import Base


class Setor(Base):
    __tablename__ = "setores"

    id = Column(Integer, primary_key=True, index=True)
    nome = Column(String, unique=True, nullable=False)

    kits = relationship("Kit", back_populates="setor", cascade="all, delete-orphan")
    encarregados = relationship("Encarregado", back_populates="setor", cascade="all, delete-orphan")


class Item(Base):
    __tablename__ = "itens"

    id = Column(Integer, primary_key=True, index=True)
    patrimonio = Column(String, unique=True, nullable=False, index=True)
    descricao = Column(String, nullable=False)

    kit_itens = relationship("KitItem", back_populates="item", cascade="all, delete-orphan")


class Kit(Base):
    __tablename__ = "kits"

    id = Column(Integer, primary_key=True, index=True)
    nome = Column(String, nullable=False, index=True)
    tipo = Column(String, nullable=True)

    setor_id = Column(Integer, ForeignKey("setores.id"), nullable=False)
    setor = relationship("Setor", back_populates="kits")

    itens = relationship("KitItem", back_populates="kit", cascade="all, delete-orphan")
    checklists = relationship("ChecklistSemanal", back_populates="kit", cascade="all, delete-orphan")


class KitItem(Base):
    __tablename__ = "kit_itens"

    id = Column(Integer, primary_key=True, index=True)
    kit_id = Column(Integer, ForeignKey("kits.id"), nullable=False)
    item_id = Column(Integer, ForeignKey("itens.id"), nullable=False)

    quantidade = Column(Integer, nullable=False, default=1)

    kit = relationship("Kit", back_populates="itens")
    item = relationship("Item", back_populates="kit_itens")


class Encarregado(Base):
    __tablename__ = "encarregados"

    id = Column(Integer, primary_key=True, index=True)
    setor_id = Column(Integer, ForeignKey("setores.id"), nullable=False)

    funcao = Column(String, nullable=False)  # Supervisor / Encarregado Turma / etc
    nome = Column(String, nullable=False, index=True)
    telefone = Column(String, nullable=True)

    setor = relationship("Setor", back_populates="encarregados")
    checklists = relationship("ChecklistSemanal", back_populates="encarregado", cascade="all, delete-orphan")


class ChecklistSemanal(Base):
    __tablename__ = "checklists_semanais"

    id = Column(Integer, primary_key=True, index=True)

    kit_id = Column(Integer, ForeignKey("kits.id"), nullable=False)
    encarregado_id = Column(Integer, ForeignKey("encarregados.id"), nullable=False)

    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)

    patrimonios_declarados = Column(Text, nullable=True)
    data_hora = Column(DateTime, default=datetime.utcnow, nullable=False)

    kit = relationship("Kit", back_populates="checklists")
    encarregado = relationship("Encarregado", back_populates="checklists")


class SolicitacaoOperacao(Base):
    __tablename__ = "solicitacoes_operacao"

    id = Column(Integer, primary_key=True, index=True)
    tipo = Column(String(30), nullable=False)

    kit_id = Column(Integer, ForeignKey("kits.id"), nullable=True)
    item_id = Column(Integer, ForeignKey("itens.id"), nullable=True)

    motivo = Column(String(255), nullable=True)
    observacao = Column(Text, nullable=True)

    solicitante_id = Column("solicitante_user_id", Integer, nullable=False)

    status = Column(String(20), nullable=False, default="PENDENTE")

    criado_em = Column(DateTime, server_default=func.current_timestamp(), nullable=False)
    concluido_em = Column(DateTime, nullable=True)

    admin_id = Column("admin_user_id", Integer, nullable=True)
