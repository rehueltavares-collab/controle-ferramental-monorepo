from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..core.auth import require_roles


router = APIRouter(prefix="/usuario", tags=["Usuario"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/posse-eletrica")
def listar_posse_eletrica_minha(
    db: Session = Depends(get_db),
    payload: dict = Depends(require_roles(["funcionario", "admin"])),
):
    enc_id = payload.get("encarregado_id")
    if not enc_id:
        raise HTTPException(status_code=400, detail="Usuario nao possui encarregado_id")

    rows = db.execute(
        text(
            """
            SELECT
                im.id AS item_movimento_id,
                im.data_hora,
                im.kit_id,
                im.item_id,
                im.acao,
                im.encarregado_id,
                im.subresponsavel_id,
                i.patrimonio,
                i.descricao,
                k.nome AS kit_nome,
                s.nome AS setor_nome,
                sr.nome AS subresponsavel_nome
            FROM item_movimentos im
            JOIN (
                SELECT item_id, MAX(id) AS max_id
                FROM item_movimentos
                GROUP BY item_id
            ) t ON t.item_id = im.item_id AND t.max_id = im.id
            JOIN itens i ON i.id = im.item_id
            LEFT JOIN kits k ON k.id = im.kit_id
            LEFT JOIN setores s ON s.id = k.setor_id
            LEFT JOIN subresponsaveis sr ON sr.id = im.subresponsavel_id
            WHERE im.acao = 'DISTRIBUIR'
              AND im.encarregado_id = :enc_id
            ORDER BY im.id DESC
            LIMIT 500
            """
        ),
        {"enc_id": int(enc_id)},
    ).mappings().all()

    return {"posse": rows}
