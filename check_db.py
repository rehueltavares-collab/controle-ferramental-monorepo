import sqlite3, sys

db = sys.argv[1]
con = sqlite3.connect(db)
cur = con.cursor()

print("DB:", db)
tables = [r[0] for r in cur.execute("select name from sqlite_master where type='table' order by name").fetchall()]
print("tables:", tables)

for t in ["kits","setores","encarregados","itens","kit_itens","subresponsaveis","checklists_semanais","checklists_semanal"]:
    if t in tables:
        try:
            n = cur.execute(f"select count(1) from {t}").fetchone()[0]
        except Exception as e:
            n = f"ERR: {e}"
        print(f"{t}:", n)
    else:
        print(f"{t}: NO TABLE")

con.close()
