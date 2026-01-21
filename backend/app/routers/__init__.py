from .subresponsaveis import router as subresponsaveis_router
from .movimentos import router as movimentos_router
from .auth import router as auth_router
from .termos import router as termos_router
from .manuais import router as manuais_router
from .admin import router as admin_router
from .avulsos import router as avulsos_router

__all__ = [
    "subresponsaveis_router",
    "movimentos_router",
    "auth_router",
    "termos_router",
    "manuais_router",
    "admin_router",
    "avulsos_router",
]
