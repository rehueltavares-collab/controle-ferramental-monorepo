from __future__ import annotations

import argparse
import re
from pathlib import Path

import pandas as pd

from backend.app.database import SessionLocal
from backend.app import models


def only_digits(s: str) -> str:
    return re.sub(r"\D+", "", (s or "").strip())


def norm_text(s: str) -> str:
    return (s or "").strip()


def find_col(df: pd.DataFrame, *candidates: str) -> str | None:
    cols = {str(c).strip().lower(): c for c in df.columns}
    for cand in candidates:
        key = cand.strip().lower()
        if key in cols:
            return cols[key]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", required=True, help="Caminho do .xlsx")
    ap.add_argument("--sheet", default=None, help="Nome da aba (opcional). Se vazio, usa a 1ª.")
    ap.add_argument("--dry", action="store_true", help="Não grava no banco (só simula).")
    args = ap.parse_args()

    xlsx_path = Path(args.xlsx)
    if not xlsx_path.exists():
        raise SystemExit(f"[ERRO] Arquivo não encontrado: {xlsx_path}")

    # Lê a planilha (se não passar sheet, pega a primeira)
    if args.sheet:
        df = pd.read_excel(xlsx_path, sheet_name=args.sheet)
    else:
        df = pd.read_excel(xlsx_path)

    # tenta achar colunas (com variações)
    col_area = find_col(df, "área", "area")
    col_funcao = find_col(df, "função", "funcao", "funçao")
    col_nome = find_col(df, "responsavel", "responsável", "responsavel ", "responsável ")
    col_tel = find_col(df, "contato", "telefone", "celular")

    # fallback por posição se vier “torto”
    if not all([col_area, col_funcao, col_nome, col_tel]) and df.shape[1] >= 4:
        # assume: 0=área,1=função,2=responsável,3=contato
        col_area = col_area or df.columns[0]
        col_funcao = col_funcao or df.columns[1]
        col_nome = col_nome or df.columns[2]
        col_tel = col_tel or df.columns[3]

    db = SessionLocal()
    try:
        setores_criados = 0
        encarregados_criados = 0
        encarregados_pulados = 0

        # cache setor_nome -> setor_id
        setor_cache: dict[str, int] = {}

        for _, row in df.iterrows():
            area = norm_text(str(row.get(col_area, "")))
            funcao = norm_text(str(row.get(col_funcao, "")))
            nome = norm_text(str(row.get(col_nome, "")))
            tel = only_digits(str(row.get(col_tel, "")))

            if not area or not nome:
                continue

            # setor
            if area not in setor_cache:
                setor = db.query(models.Setor).filter(models.Setor.nome == area).first()
                if not setor:
                    setor = models.Setor(nome=area)
                    db.add(setor)
                    if not args.dry:
                        db.commit()
                        db.refresh(setor)
                    setores_criados += 1
                setor_cache[area] = setor.id

            setor_id = setor_cache[area]

            # encarregado (dedupe por setor+nome)
            exists = (
                db.query(models.Encarregado)
                .filter(models.Encarregado.setor_id == setor_id)
                .filter(models.Encarregado.nome == nome)
                .first()
            )
            if exists:
                encarregados_pulados += 1
                continue

            novo = models.Encarregado(
                setor_id=setor_id,
                funcao=funcao or "Encarregado",
                nome=nome,
                telefone=tel,
            )
            db.add(novo)
            if not args.dry:
                db.commit()
                db.refresh(novo)
            encarregados_criados += 1

        print("✅ IMPORTAÇÃO DE ENCARREGADOS FINALIZADA")
        print(f"   Setores criados (ou novos encontrados): {setores_criados}")
        print(f"   Encarregados criados: {encarregados_criados}")
        print(f"   Encarregados pulados (já existiam): {encarregados_pulados}")

    finally:
        db.close()


if __name__ == "__main__":
    main()
