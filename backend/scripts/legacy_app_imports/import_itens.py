from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from sqlalchemy.orm import Session

from .database import SessionLocal
from . import models


def parse_args():
    p = argparse.ArgumentParser(description="Importa itens (patrimônio/descrição) para o SQLite.")
    p.add_argument(
        "--csv",
        dest="csv_path",
        default="itens_ferramental.csv",
        help="Caminho do CSV (default: itens_ferramental.csv na raiz do repo)",
    )
    p.add_argument(
        "--delimiter",
        default=";",
        help="Delimitador do CSV (default: ';')",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Só mostra o que faria, sem gravar no banco",
    )
    return p.parse_args()


def normalize(s: str) -> str:
    return (s or "").strip()


def get_or_create_item(db: Session, patrimonio: str, descricao: str) -> tuple[models.Item, bool]:
    existing = db.query(models.Item).filter(models.Item.patrimonio == patrimonio).first()
    if existing:
        # opcional: atualizar descrição se vier diferente e não-vazia
        if descricao and (existing.descricao or "").strip() != descricao:
            existing.descricao = descricao
            return existing, False
        return existing, False

    obj = models.Item(patrimonio=patrimonio, descricao=descricao)
    db.add(obj)
    return obj, True


def main():
    args = parse_args()
    csv_file = Path(args.csv_path).resolve()

    if not csv_file.exists():
        print(f"[ERRO] CSV não encontrado: {csv_file}")
        sys.exit(1)

    created = 0
    updated = 0
    skipped = 0
    total = 0

    db = SessionLocal()
    try:
        with csv_file.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f, delimiter=args.delimiter)
            rows = list(reader)

        if not rows:
            print("[ERRO] CSV vazio.")
            sys.exit(1)

        # tenta detectar cabeçalho
        start_idx = 0
        header = [normalize(x).lower() for x in rows[0]]
        if len(header) >= 2 and ("ident" in header[0] or "patr" in header[0]) and ("equip" in header[1] or "desc" in header[1]):
            start_idx = 1  # pula cabeçalho

        for r in rows[start_idx:]:
            total += 1
            if len(r) < 2:
                skipped += 1
                continue

            patrimonio = normalize(r[0])
            descricao = normalize(r[1])

            if not patrimonio:
                skipped += 1
                continue

            obj, was_created = get_or_create_item(db, patrimonio, descricao)
            if was_created:
                created += 1
            else:
                # se caiu aqui por update de descrição
                if descricao and (obj.descricao or "").strip() == descricao:
                    # pode ser update ou nada; não dá pra diferenciar perfeito sem flag
                    updated += 0
                else:
                    updated += 0

        if args.dry_run:
            db.rollback()
            print(f"[DRY-RUN] Total linhas: {total} | Criados: {created} | Pulados: {skipped}")
            return

        db.commit()
        print(f"[OK] Import finalizado.")
        print(f"     Total linhas: {total}")
        print(f"     Criados:      {created}")
        print(f"     Pulados:      {skipped}")

    except Exception as e:
        db.rollback()
        print(f"[ERRO] Falha no import: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
