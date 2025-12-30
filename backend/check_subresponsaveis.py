import sqlite3
from pathlib import Path

db = Path(__file__).resolve().parents[1] / "ferramental.db"
print("DB:", db)

con = sqlite3.connect(db)
cur = con.cursor()

print("\nESTRUTURA DA TABELA:")
for col in cur.execute("PRAGMA table_info(subresponsaveis)").fetchall():
    print(col)

print("\nAMOSTRA DE DADOS:")
for row in cur.execute("SELECT * FROM subresponsaveis LIMIT 5").fetchall():
    print(row)

con.close()
