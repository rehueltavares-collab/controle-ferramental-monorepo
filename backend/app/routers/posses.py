from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import text

from ..database import SessionLocal

router = APIRouter(prefix="/posses", tags=["Posses"])


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/kits/disponiveis")
def kits_disponiveis(db: Session = Depends(get_db)):
    rows = db.execute(
        text(
            """
            SELECT k.*
            FROM kits k
            LEFT JOIN posses p
              ON p.tipo='KIT' AND p.kit_id=k.id AND p.is_ativa=1
            WHERE p.id IS NULL
            ORDER BY k.id
            """
        )
    ).mappings().all()
    return rows


@router.get("/kits/minha")
def meus_kits(encarregado_id: int = Query(...), db: Session = Depends(get_db)):
    rows = db.execute(
        text(
            """
            SELECT k.id, k.nome, k.tipo, k.setor_id, p.status
            FROM posses p
            JOIN kits k ON k.id = p.kit_id
            WHERE p.tipo='KIT'
              AND p.is_ativa=1
              AND p.encarregado_id=:enc
              AND COALESCE(p.status,'ATIVA') = 'ATIVA'
            ORDER BY k.id
            """
        ),
        {"enc": encarregado_id},
    ).mappings().all()
    return rows


@router.get("/avulsos/disponiveis")
def avulsos_disponiveis(db: Session = Depends(get_db)):
    rows = db.execute(
        text(
            """
            SELECT i.id, i.patrimonio, i.descricao
            FROM itens i
            LEFT JOIN kit_itens ki ON ki.item_id = i.id
            LEFT JOIN posses p
              ON p.tipo='AVULSO' AND p.patrimonio=i.patrimonio AND p.is_ativa=1
            WHERE ki.item_id IS NULL
              AND i.ativo=1
              AND p.id IS NULL
            ORDER BY i.descricao
            """
        )
    ).mappings().all()
    return rows


@router.get("/avulsos/minha")
def meus_avulsos(encarregado_id: int = Query(...), db: Session = Depends(get_db)):
    rows = db.execute(
        text(
            """
            SELECT i.id, i.patrimonio, i.descricao, p.status
            FROM posses p
            JOIN itens i ON i.patrimonio = p.patrimonio
            WHERE p.tipo='AVULSO'
              AND p.is_ativa=1
              AND p.encarregado_id=:enc
              AND COALESCE(p.status,'ATIVA') = 'ATIVA'
            ORDER BY i.descricao
            """
        ),
        {"enc": encarregado_id},
    ).mappings().all()
    return rows
