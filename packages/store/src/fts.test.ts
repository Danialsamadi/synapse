import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { MemoryRepository } from "./memory-repository.js";
import { MIGRATIONS, runMigrations } from "./schema.js";

/** Raw FTS hits for a MATCH expression — test helper hitting the table directly. */
function ftsIds(repo: MemoryRepository, match: string): string[] {
  // @ts-expect-error test reaches into the private db handle
  const db = repo.db as Database.Database;
  return (
    db
      .prepare(
        `SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ?`,
      )
      .all(match) as Array<{ id: string }>
  ).map((r) => r.id);
}

describe("MIGRATION_V3: memories_fts", () => {
  it("indexes new memories via the insert trigger, with porter stemming", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const m = repo.create({ userId: "local", type: "semantic", content: "I love running marathons" });
    assert.deepEqual(ftsIds(repo, '"run"'), [m.id]); // porter: running → run
  });

  it("keeps the index in sync on content update and delete", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const m = repo.create({ userId: "local", type: "semantic", content: "favorite city is Toronto" });
    repo.update(m.id, { content: "favorite city is Lisbon" });
    assert.deepEqual(ftsIds(repo, '"toronto"'), []);
    assert.deepEqual(ftsIds(repo, '"lisbon"'), [m.id]);
    repo.softDelete(m.id); // soft delete keeps the row → still indexed
    assert.deepEqual(ftsIds(repo, '"lisbon"'), [m.id]);
    repo.purgeDeleted(); // hard delete → delete trigger removes it
    assert.deepEqual(ftsIds(repo, '"lisbon"'), []);
  });

  it("matches non-English tokens exactly", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const m = repo.create({ userId: "local", type: "semantic", content: "شهر مورد علاقه تهران است" });
    assert.deepEqual(ftsIds(repo, '"تهران"'), [m.id]);
  });

  it("backfills rows written before V3 (legacy adoption path)", () => {
    // Build a DB with V1+V2 only, insert a row, then run full migrations.
    const db = new Database(":memory:");
    db.exec(MIGRATIONS[0]!);
    db.exec(MIGRATIONS[1]!);
    db.pragma("user_version = 2");
    db.prepare(
      `INSERT INTO memories (id, user_id, type, status, content, importance, confidence,
        decay_half_life_days, created_at, updated_at, source_refs_json, links_json,
        tags_json, retention_json)
       VALUES ('mem_legacy', 'local', 'semantic', 'active', 'legacy Toronto fact', 0.5, 0.7,
        90, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '[]', '[]', '[]', '{"mode":"default"}')`,
    ).run();
    runMigrations(db);
    const hits = db
      .prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH '"toronto"'`)
      .all();
    assert.equal(hits.length, 1);
    // replaying migrations (legacy user_version=0 adoption) must not duplicate
    db.pragma("user_version = 0");
    runMigrations(db);
    const again = db
      .prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH '"toronto"'`)
      .all();
    assert.equal(again.length, 1);
    db.close();
  });
});
