from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..core.auth import get_current_token, require_roles, get_user_row
from ..core.security import create_token, verify_password, hash_password, validate_password
from ..database import get_db

router = APIRouter(prefix="/auth", tags=["Auth"])


class LoginIn(BaseModel):
    username: str
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    must_change_password: bool = False


@router.post("/login", response_model=TokenOut)
def login(payload: LoginIn, db: Session = Depends(get_db)):
    user = get_user_row(db, payload.username)

    if not user or int(user["ativo"]) != 1:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciais invalidas")

    if not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciais invalidas")

    tok = create_token(
        {
            "sub": user["username"],
            "uid": user["id"],
            "role": user["role"],
            "subresponsavel_id": user["subresponsavel_id"],
            "encarregado_id": user.get("encarregado_id"),
            "must_change_password": bool(user.get("precisa_definir_senha")),
            "nome": user["nome"],
        }
    )
    return TokenOut(access_token=tok, must_change_password=bool(user.get("precisa_definir_senha")))


@router.get("/me")
def me(payload: dict = Depends(get_current_token)):
    return payload


class CreateUserIn(BaseModel):
    username: str
    password: Optional[str] = None
    role: str
    nome: Optional[str] = None
    subresponsavel_id: Optional[int] = None
    encarregado_id: Optional[int] = None
    ativo: int = 1
    precisa_definir_senha: int = 1


@router.post("/users")
def create_user(
    body: CreateUserIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_roles(["admin"])),
):
    if body.role not in ("admin", "manutencao", "funcionario"):
        raise HTTPException(status_code=400, detail="role invalida")

    exists = db.execute(
        text("SELECT 1 FROM users WHERE username = :u LIMIT 1"),
        {"u": body.username},
    ).first()

    if exists:
        raise HTTPException(status_code=409, detail="username ja existe")

    temp_password = (body.password or "123456").strip()
    try:
        validate_password(temp_password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    pwd_hash = hash_password(temp_password)

    db.execute(
        text(
            """
            INSERT INTO users (username, nome, subresponsavel_id, encarregado_id, role, password_hash, ativo, precisa_definir_senha)
            VALUES (:username, :nome, :subresponsavel_id, :encarregado_id, :role, :password_hash, :ativo, :precisa_definir_senha)
            """
        ),
        {
            "username": body.username,
            "nome": body.nome,
            "subresponsavel_id": body.subresponsavel_id,
            "encarregado_id": body.encarregado_id,
            "role": body.role,
            "password_hash": pwd_hash,
            "ativo": body.ativo,
            "precisa_definir_senha": 1 if body.precisa_definir_senha else 0,
        },
    )
    db.commit()

    return {"ok": True, "username": body.username, "role": body.role}


class DefinirSenhaIn(BaseModel):
    nova_senha: str


@router.post("/definir-senha", response_model=TokenOut)
def definir_senha(
    body: DefinirSenhaIn,
    db: Session = Depends(get_db),
    payload: dict = Depends(get_current_token),
):
    try:
        validate_password(body.nova_senha)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    pwd_hash = hash_password(body.nova_senha)

    db.execute(
        text(
            """
            UPDATE users
            SET password_hash = :ph, precisa_definir_senha = 0
            WHERE id = :uid
            """
        ),
        {"ph": pwd_hash, "uid": payload["uid"]},
    )
    db.commit()

    user = get_user_row(db, payload.get("sub"))
    tok = create_token(
        {
            "sub": user["username"],
            "uid": user["id"],
            "role": user["role"],
            "subresponsavel_id": user["subresponsavel_id"],
            "encarregado_id": user.get("encarregado_id"),
            "must_change_password": False,
            "nome": user["nome"],
        }
    )
    return TokenOut(access_token=tok, must_change_password=False)
