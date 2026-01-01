from datetime import datetime
from pydantic import BaseModel
from typing import Optional


# ========= ITENS =========

class ItemBase(BaseModel):
    patrimonio: str
    descricao: str


class ItemCreate(ItemBase):
    pass


class Item(ItemBase):
    id: int

    class Config:
        from_attributes = True


# ========= SETORES =========

class SetorBase(BaseModel):
    nome: str


class SetorCreate(SetorBase):
    pass


class Setor(SetorBase):
    id: int

    class Config:
        from_attributes = True


# ========= KITS =========

class KitBase(BaseModel):
    nome: str
    tipo: Optional[str] = None
    setor_id: int


class KitCreate(KitBase):
    pass


class Kit(KitBase):
    id: int

    class Config:
        from_attributes = True


# ========= KIT x ITEM =========

class KitItemBase(BaseModel):
    kit_id: int
    item_id: int
    quantidade: int = 1


class KitItemCreate(KitItemBase):
    pass


class KitItem(KitItemBase):
    id: int

    class Config:
        from_attributes = True


# ========= ENCARREGADOS =========

class EncarregadoBase(BaseModel):
    setor_id: int
    funcao: str
    nome: str
    telefone: Optional[str] = None


class EncarregadoCreate(EncarregadoBase):
    pass


class Encarregado(EncarregadoBase):
    id: int

    class Config:
        from_attributes = True


# ========= CHECKLIST SEMANAL =========

class ChecklistSemanalBase(BaseModel):
    kit_id: int
    encarregado_id: int
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    patrimonios_declarados: Optional[str] = None


class ChecklistSemanalCreate(ChecklistSemanalBase):
    pass


class ChecklistSemanal(ChecklistSemanalBase):
    id: int
    data_hora: datetime

    class Config:
        from_attributes = True


# ========= SUBRESPONSÁVEIS =========

class SubresponsavelBase(BaseModel):
    nome: str
    secao: Optional[str] = None
    ativo: Optional[bool] = True


class Subresponsavel(SubresponsavelBase):
    id: int

    class Config:
        from_attributes = True


class DefinirPinRequest(BaseModel):
    pin: str


# ========= MOVIMENTOS (payloads) =========

class MovimentoDistribuirRequest(BaseModel):
    kit_id: int
    patrimonio: str
    encarregado_id: int
    subresponsavel_id: int
    pin: str

    lat: Optional[float] = None
    lng: Optional[float] = None
    accuracy_m: Optional[float] = None
    gps_timestamp: Optional[str] = None
    observacao: Optional[str] = None


class MovimentoRecolherRequest(BaseModel):
    kit_id: int
    patrimonio: str
    encarregado_id: int

    lat: Optional[float] = None
    lng: Optional[float] = None
    accuracy_m: Optional[float] = None
    gps_timestamp: Optional[str] = None
    observacao: Optional[str] = None
