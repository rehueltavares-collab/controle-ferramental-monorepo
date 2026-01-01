import pandas as pd
import sqlite3
import secrets

XLS = r"C:\Users\Rehuel\ATIVOS 09-12 - MONITORAMENTO.xls"
DB  = r"C:\Users\Rehuel\controle-ferramental-monorepo\ferramental.db"

con = sqlite3.connect(DB)
cur = con.cursor()
cur.execute("PRAGMA foreign_keys=ON")

# garantir colunas
cur.execute("PRAGMA table_info(subresponsaveis)")
cols = [c[1].lower() for c in cur.fetchall()]

def addcol(name, ddl):
    global cols
    if name not in cols:
        cur.execute(f"ALTER TABLE subresponsaveis ADD COLUMN {ddl}")
        con.commit()
        cur.execute("PRAGMA table_info(subresponsaveis)")
        cols[:] = [c[1].lower() for c in cur.fetchall()]

addcol("nome",  "nome TEXT")
addcol("setor", "setor TEXT")
addcol("pin",   "pin TEXT")
addcol("ativo", "ativo INTEGER DEFAULT 1")

# ler XLS
df = pd.read_excel(XLS, engine="xlrd")
df = df[["Nome", "Descrição Seção"]].dropna(subset=["Nome"])
df["Nome"] = df["Nome"].astype(str).str.strip()
df["Descrição Seção"] = df["Descrição Seção"].astype(str).str.strip()

# existentes
cur.execute("SELECT nome, COALESCE(setor,'') FROM subresponsaveis")
exist = set((n.strip().upper(), s.strip().upper()) for n, s in cur.fetchall())

cur.execute("SELECT pin FROM subresponsaveis WHERE pin IS NOT NULL AND TRIM(pin)<>''")
pins = set(p[0] for p in cur.fetchall())

def new_pin():
    while True:
        p = f"{secrets.randbelow(1000000):06d}"
        if p not in pins:
            pins.add(p)
            return p

ins = upd = total = 0

for nome, setor in zip(df["Nome"], df["Descrição Seção"]):
    total += 1
    key = (nome.upper(), setor.upper())

    if key in exist:
        cur.execute(
            "SELECT id, pin FROM subresponsaveis WHERE UPPER(nome)=? AND UPPER(COALESCE(setor,''))=? LIMIT 1",
            key
        )
        row = cur.fetchone()
        if row and (row[1] is None or str(row[1]).strip() == ""):
            cur.execute("UPDATE subresponsaveis SET pin=? WHERE id=?", (new_pin(), row[0]))
            upd += 1
        continue

    cur.execute(
        "INSERT INTO subresponsaveis (nome, setor, pin, ativo) VALUES (?,?,?,1)",
        (nome, setor, new_pin())
    )
    exist.add(key)
    ins += 1

con.commit()

# índices
cur.execute("CREATE INDEX IF NOT EXISTS idx_subresp_nome ON subresponsaveis(nome)")
cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_subresp_pin ON subresponsaveis(pin)")
con.commit()

cur.execute("SELECT COUNT(*) FROM subresponsaveis")
total_db = cur.fetchone()[0]

cur.execute("SELECT COUNT(*) FROM subresponsaveis WHERE pin IS NOT NULL AND TRIM(pin)<>''")
total_pin = cur.fetchone()[0]

con.close()

print("Linhas lidas do XLS:", total)
print("Inseridos novos:", ins)
print("PINs preenchidos/atualizados:", upd)
print("Total na tabela subresponsaveis:", total_db)
print("Total com PIN:", total_pin)
