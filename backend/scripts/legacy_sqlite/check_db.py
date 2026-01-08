import sqlite3
from pathlib import Path

db = Path(__file__).resolve().parents[1] / "ferramental.db"
con = sqlite3.connect(db)
cur = con.cursor()

print("DB:", db)
print("Tabela existe:",
      cur.execute(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='subresponsaveis'"
      ).fetchone()
)

print("Quantidade:",
      cur.execute(
          "SELECT COUNT(*) FROM subresponsaveis"
      ).fetchone()
)

con.close()
