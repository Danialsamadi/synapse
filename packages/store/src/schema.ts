/** SQL schema for Synapse local store (MVP). */
export const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  content TEXT NOT NULL,
  structured_json TEXT,
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  decay_half_life_days REAL NOT NULL,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  links_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  retention_json TEXT NOT NULL,
  content_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_user_status
  ON memories(user_id, status);

CREATE INDEX IF NOT EXISTS idx_memories_user_type
  ON memories(user_id, type);

CREATE TABLE IF NOT EXISTS embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  dims INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const MIGRATION_V2 = `
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  rel TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(from_id, to_id, rel)
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);

CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  error TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export const MIGRATION_V3 = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
`;

/** Ordered migrations; index+1 = schema version stored in PRAGMA user_version. */
export const MIGRATIONS: readonly string[] = [MIGRATION_V1, MIGRATION_V2, MIGRATION_V3];

import type DatabaseType from "better-sqlite3";

/**
 * Applies pending migrations inside a transaction and stamps user_version.
 * Fails closed if the DB was written by a newer version of the code.
 * Legacy DBs (tables present, user_version 0) adopt safely: migrations are idempotent.
 */
export function runMigrations(db: DatabaseType.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${MIGRATIONS.length}). ` +
        `Upgrade synapse instead of downgrading the database.`,
    );
  }
  db.transaction(() => {
    for (let v = current; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]!);
    db.pragma(`user_version = ${MIGRATIONS.length}`);
  })();
}
