CREATE TABLE IF NOT EXISTS subresponsaveis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  secao TEXT,
  pin_hash TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subresp_nome ON subresponsaveis(nome);

CREATE TABLE IF NOT EXISTS item_movimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id INTEGER NOT NULL,
  patrimonio TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('DISTRIBUIR','RECOLHER')),
  encarregado_id INTEGER NOT NULL,
  subresponsavel_id INTEGER,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL,
  gps_timestamp TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  observacao TEXT
);

CREATE INDEX IF NOT EXISTS idx_mov_kit ON item_movimentos(kit_id);
CREATE INDEX IF NOT EXISTS idx_mov_patrimonio ON item_movimentos(patrimonio);
