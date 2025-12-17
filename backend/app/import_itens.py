from pathlib import Path
import csv

from .database import SessionLocal
from . import models

# Caminho do CSV na raiz do projeto
CSV_PATH = Path(__file__).resolve().parent.parent / "itens_ferramental.csv"


def importar_itens():
    db = SessionLocal()
    try:
        # latin-1 lida bem com acentuação vinda do Excel
        with CSV_PATH.open(encoding="latin-1", newline="") as f:
            reader = csv.reader(f, delimiter=";")

            # Pula a primeira linha (cabeçalho)
            header = next(reader, None)

            inseridos = 0
            pulados = 0

            for row in reader:
                # Garantir que tem pelo menos 2 colunas
                if len(row) < 2:
                    continue

                patrimonio = (row[0] or "").strip()
                descricao = (row[1] or "").strip()

                if not patrimonio:
                    continue

                # Evita duplicar patrimônio
                existente = (
                    db.query(models.Item)
                    .filter(models.Item.patrimonio == patrimonio)
                    .first()
                )
                if existente:
                    pulados += 1
                    continue

                item = models.Item(
                    patrimonio=patrimonio,
                    descricao=descricao,
                )
                db.add(item)
                inseridos += 1

            db.commit()

        print(f"Itens inseridos: {inseridos}")
        print(f"Itens pulados (já existiam): {pulados}")

    finally:
        db.close()


if __name__ == "__main__":
    importar_itens()
