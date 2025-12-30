import sqlite3

db = r".\..\ferramental.db"
con = sqlite3.connect(db)
cur = con.cursor()

q = "%ADA%"
rows = cur.execute(
    "SELECT id, nome, secao FROM subresponsaveis WHERE ativo=1 AND nome LIKE ? LIMIT 5",
    (q,)
).fetchall()

print("DB:", db)
print("Resultados:", len(rows))
for r in rows:
    print(r)

con.close()
