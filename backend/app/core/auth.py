from typing import Dict, List

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import SessionLocal
from .security import decode_token

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_token(token: str = Depends(oauth2_scheme)) -> Dict:
    try:
        payload = decode_token(token)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token invalido")

    if not payload.get("sub") or not payload.get("role") or not payload.get("uid"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token invalido")

    return payload


def require_roles(roles: List[str]):
    def _guard(payload: Dict = Depends(get_current_token)) -> Dict:
        if payload.get("role") not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissao")
        return payload

    return _guard


def get_user_row(db: Session, username: str):
    return db.execute(
        text(
            """
            SELECT id, username, nome, subresponsavel_id, encarregado_id, role, password_hash, ativo, precisa_definir_senha
            FROM users
            WHERE username = :u
            LIMIT 1
            """
        ),
        {"u": username},
    ).mappings().first()
