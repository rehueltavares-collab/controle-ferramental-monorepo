import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from jose import JWTError, jwt
from passlib.context import CryptContext

JWT_SECRET = os.getenv("JWT_SECRET", "troque-por-uma-chave-grande")
JWT_EXPIRES_MIN = int(os.getenv("JWT_EXPIRES_MIN", "480"))
JWT_ALG = "HS256"

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return _pwd.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _pwd.verify(password, password_hash)
    except Exception:
        return False


def validate_password(password: str) -> None:
    if not password:
        raise ValueError("Senha obrigatoria")
    if len(password) > 8:
        raise ValueError("Senha deve ter no maximo 8 caracteres")
    if not password.isalnum():
        raise ValueError("Senha deve ser alfanumerica")


def create_token(payload: Dict[str, Any], expires_min: Optional[int] = None) -> str:
    minutes = expires_min if expires_min is not None else JWT_EXPIRES_MIN
    exp = datetime.now(timezone.utc) + timedelta(minutes=minutes)

    data = dict(payload)
    data["exp"] = exp
    return jwt.encode(data, JWT_SECRET, algorithm=JWT_ALG)


def decode_token(token: str) -> Dict[str, Any]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError as exc:
        raise ValueError("Invalid token") from exc
