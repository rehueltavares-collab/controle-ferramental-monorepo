import sqlite3
import pandas as pd
from pathlib import Path

DB_PATH = "ferramental.db"

def main():
    # AJUSTE ESTE CAMINHO PARA O SEU ARQUIVO
    xlsx = Path(r"C:\Users\rehuel.tavares\Projetos\controle-ferramental\Projetos\controle-ferramental\ATIVOS 09-12 - MONITORAMENTO.xls")

    df = pd.read_excel(xlsx)
    df.columns = [c.strip() for c in df.columns]

    # tenta nomes de colunas mais prováveis
    nome_col = "Nome" if "Nome" in df.columns else None
    secao_col = "Descrição Seção" if "Descrição Seção" in df.columns else ("Descricao Secao" if "Descricao Secao" in df.columns else None)

    if not nome_col:
        raise RuntimeError(f"Coluna 'Nome' não encontrada. Colunas: {list(df.columns)}")

    df[nome_col] = df[nome_col].astype(str).str.strip().str.upper()
    if secao_col:
        df[secao_col] = df[secao_col].astype(str).str.strip()
    else:
        df["Descrição Seção"] = ""
        secao_col = "Descrição Seção"

    df = df[(df[nome_col]!="") & (df[nome_col].str.lower()!="nan")]

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    # evita duplicar se rodar 2x: usa nome+secao como chave “prática”
    for _, r in df.iterrows():
        cur.execute(
            "SELECT 1 FROM subresponsaveis WHERE nome=? AND IFNULL(secao,'')=IFNULL(?, '')",
            (r[nome_col], r[secao_col]),
        )
        if cur.fetchone():
            continue
        cur.execute(
            "INSERT INTO subresponsaveis (nome, secao, ativo) VALUES (?, ?, 1)",
            (r[nome_col], r[secao_col]),
        )

    con.commit()
    con.close()
    print("OK: import concluído. Linhas lidas:", len(df))

if __name__ == "__main__":
    main()
