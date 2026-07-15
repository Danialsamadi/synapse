/** SQL schema for Mneme local store (MVP). */
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
