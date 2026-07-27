import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { HashEmbeddingProvider } from "@synapse/embeddings";
import { MemoryRepository, buildMatchExpr } from "./memory-repository.js";
import { RetrievalService } from "./retrieval.js";
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

  it("backfill does not corrupt bm25 ranking stats on migration replay", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATIONS[0]!);
    db.exec(MIGRATIONS[1]!);
    db.pragma("user_version = 2");
    db.prepare(
      `INSERT INTO memories (id, user_id, type, status, content, importance, confidence,
        decay_half_life_days, created_at, updated_at, source_refs_json, links_json,
        tags_json, retention_json)
       VALUES ('mem_bm25', 'local', 'semantic', 'active', 'stable bm25 ranking fact', 0.5, 0.7,
        90, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '[]', '[]', '[]', '{"mode":"default"}')`,
    ).run();
    runMigrations(db); // applies V3, backfills the one row
    const rankAfterFirst = (
      db
        .prepare(`SELECT bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH '"stable"'`)
        .get() as { rank: number }
    ).rank;
    // Replay migrations from scratch (legacy-adoption re-entry, same path the reviewer flagged).
    for (let i = 0; i < 3; i++) {
      db.pragma("user_version = 0");
      runMigrations(db);
    }
    const rankAfterReplay = (
      db
        .prepare(`SELECT bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH '"stable"'`)
        .get() as { rank: number }
    ).rank;
    assert.ok(
      Math.abs(rankAfterFirst - rankAfterReplay) < 1e-6,
      `bm25 rank must be stable across replay: first=${rankAfterFirst} afterReplay=${rankAfterReplay}`,
    );
    // Row presence/no-duplication guard (belt-and-suspenders alongside the existing test).
    const rowCount = (db.prepare(`SELECT COUNT(*) AS c FROM memories_fts`).get() as { c: number }).c;
    assert.equal(rowCount, 1);
    db.close();
  });
});

describe("searchKeyword", () => {
  it("scores stemmed matches and normalizes best hit to 1.0", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const a = repo.create({ userId: "local", type: "semantic", content: "loves running and running clubs" });
    repo.create({ userId: "local", type: "semantic", content: "prefers cycling" });
    const ranks = repo.searchKeyword("run");
    assert.ok(ranks instanceof Map);
    assert.equal(ranks!.get(a.id), 1.0); // only/best hit normalizes to 1
    assert.equal(ranks!.size, 1);
  });

  it("interpolates multi-hit ranks linearly, with the worst hit floored to exactly 0", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    // Vary term frequency + doc length to force genuine bm25 rank separation.
    const best = repo.create({ userId: "local", type: "semantic", content: "marathon marathon marathon" });
    const middle = repo.create({
      userId: "local",
      type: "semantic",
      content: "trained for months and finally ran a marathon this year",
    });
    const worst = repo.create({
      userId: "local",
      type: "semantic",
      content:
        "the city council met on tuesday to discuss zoning permits road repairs " +
        "budget allocations and a brief unrelated mention of a marathon event " +
        "before adjourning for lunch and further unrelated committee business",
    });
    const ranks = repo.searchKeyword("marathon");
    assert.ok(ranks instanceof Map);
    assert.equal(ranks!.size, 3);
    assert.equal(ranks!.get(best.id), 1);
    // Known interpolation-floor property (the reviewer's flagged concern): the single
    // worst-ranked hit in a multi-hit set normalizes to exactly 0, identical to a
    // non-match. This pins that behavior down so it can't silently drift.
    assert.equal(ranks!.get(worst.id), 0);
    const middleRank = ranks!.get(middle.id)!;
    assert.ok(middleRank > 0 && middleRank < 1, `middle rank must strictly interpolate, got ${middleRank}`);
  });

  it("is safe against FTS operator injection", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    repo.create({ userId: "local", type: "semantic", content: "plain fact" });
    for (const q of ['foo OR bar', 'a-b', '"quoted"', 'x*', 'NEAR(a b)', '(paren']) {
      const ranks = repo.searchKeyword(q);
      assert.ok(ranks instanceof Map, `query ${JSON.stringify(q)} must not fail`);
    }
  });

  it("prefix-matches the last token", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const m = repo.create({ userId: "local", type: "semantic", content: "lives in Toronto" });
    const ranks = repo.searchKeyword("lives in toro");
    assert.ok(ranks!.has(m.id));
  });

  it("returns empty Map for no matches and for token-less queries", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    repo.create({ userId: "local", type: "semantic", content: "something" });
    assert.equal(repo.searchKeyword("zzzqqq")!.size, 0);
    assert.equal(repo.searchKeyword("!!! ???")!.size, 0);
  });

  it("returns null when the FTS table is broken", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    // @ts-expect-error test reaches into the private db handle
    (repo.db as Database.Database).exec("DROP TABLE memories_fts");
    assert.equal(repo.searchKeyword("anything"), null);
  });
});

describe("buildMatchExpr", () => {
  it("quotes tokens, ORs them, prefixes every token", () => {
    assert.equal(buildMatchExpr("red running shoes"), '"red"* OR "running"* OR "shoes"*');
  });
  it("returns null when nothing tokenizes", () => {
    assert.equal(buildMatchExpr("!!!"), null);
  });
});

describe("B′ union candidacy", () => {
  it("a vector-only hit (zero token overlap) still surfaces", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const retrieval = new RetrievalService(repo, embedder);
    const m = repo.create({ userId: "local", type: "semantic", content: "alpha beta gamma" });
    const [vec] = await embedder.embed(["totally different words"]);
    repo.replaceEmbedding(m.id, vec!, "hash"); // force high cosine with the query
    const { memories } = await retrieval.retrieve({
      query: "totally different words",
      userId: "local",
      limit: 8,
    });
    assert.ok(memories.some((r) => r.id === m.id), "vector-only hit must be a candidate");
  });

  it("keyword hits beyond vector top-K still surface, scored by bm25", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const retrieval = new RetrievalService(repo, embedder);
    const target = repo.create({ userId: "local", type: "semantic", content: "the xylophone recital" });
    const [tv] = await embedder.embed([target.content]);
    repo.saveEmbedding(target.id, tv!, "hash");
    const { memories } = await retrieval.retrieve({ query: "xylophone", userId: "local", limit: 8 });
    const hit = memories.find((r) => r.id === target.id);
    assert.ok(hit);
    assert.ok((hit!.scoreBreakdown?.keyword ?? 0) > 0, "keyword component must come from bm25");
  });

  it("falls back to legacy scoring when FTS is broken, and audits it", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const retrieval = new RetrievalService(repo, embedder);
    const m = repo.create({ userId: "local", type: "semantic", content: "fallback fact about pottery" });
    const [v] = await embedder.embed([m.content]);
    repo.saveEmbedding(m.id, v!, "hash");
    // @ts-expect-error test reaches into the private db handle
    (repo.db as Database.Database).exec("DROP TABLE memories_fts");
    const { memories } = await retrieval.retrieve({ query: "pottery", userId: "local", limit: 8 });
    assert.ok(memories.some((r) => r.id === m.id), "fallback path must still retrieve");
    const audit = repo.listAudit("retrieve", 1)[0]!;
    assert.ok(JSON.parse(audit.detail).ftsFallback === true);
  });

  it("caps candidates at K without error when eligible >> K", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const retrieval = new RetrievalService(repo, embedder);
    for (let i = 0; i < 50; i++) {
      const m = repo.create({ userId: "local", type: "semantic", content: `note number ${i} about things` });
      const [v] = await embedder.embed([m.content]);
      repo.saveEmbedding(m.id, v!, "hash");
    }
    const { memories, stats } = await retrieval.retrieve({ query: "note", userId: "local", limit: 1 });
    assert.equal(memories.length, 1); // limit respected
    assert.ok(stats.candidateCount <= 50); // no blowup; union bounded by eligible
  });

  it("audit records eligibleCount and stats reports union size", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const retrieval = new RetrievalService(repo, embedder);
    for (let i = 0; i < 5; i++) {
      const m = repo.create({ userId: "local", type: "semantic", content: `filler memory ${i}` });
      const [v] = await embedder.embed([m.content]);
      repo.saveEmbedding(m.id, v!, "hash");
    }
    const { stats } = await retrieval.retrieve({ query: "filler", userId: "local", limit: 2 });
    const detail = JSON.parse(repo.listAudit("retrieve", 1)[0]!.detail);
    assert.equal(detail.eligibleCount, 5);
    assert.ok(stats.candidateCount <= 5 && stats.candidateCount >= 1);
  });

  it("a memory in neither keyword hits nor vector top-K is dropped from candidacy", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const retrieval = new RetrievalService(repo, embedder);
    const query = "quokka snorkeling festival";
    const total = 45; // limit:1 -> K = max(1*4, 40) = 40, so 45 eligible guarantees a K-shortfall
    // 44 memories textually close to the query: high hash-embedding cosine sim (competes
    // for vector top-K) and share query tokens (keyword hits via FTS bm25).
    for (let i = 0; i < total - 1; i++) {
      const m = repo.create({ userId: "local", type: "semantic", content: `${query} note ${i}` });
      const [v] = await embedder.embed([m.content]);
      repo.saveEmbedding(m.id, v!, "hash");
    }
    // One memory sharing zero query tokens, with unrelated filler content whose
    // hash-embedding is dissimilar enough to the query to rank outside the top 40 by
    // cosine similarity (validated: ~0.80 vs ~0.84-0.88 for the near-duplicate set above).
    const excludedContent =
      "the municipal zoning board convened tuesday to review parking permit renewals " +
      "budget line items road resurfacing schedules and unrelated committee " +
      "correspondence before adjourning for the evening recess";
    const excluded = repo.create({ userId: "local", type: "semantic", content: excludedContent });
    const [ev] = await embedder.embed([excludedContent]);
    repo.saveEmbedding(excluded.id, ev!, "hash");

    const { memories, stats } = await retrieval.retrieve({ query, userId: "local", limit: 1 });
    assert.ok(!memories.some((r) => r.id === excluded.id));
    assert.ok(
      stats.candidateCount < total,
      `expected candidacy to drop the neither-hit memory, got candidateCount=${stats.candidateCount} of ${total} eligible`,
    );
    const detail = JSON.parse(repo.listAudit("retrieve", 1)[0]!.detail);
    assert.equal(detail.eligibleCount, total);
    assert.ok(
      stats.candidateCount < detail.eligibleCount,
      "candidateCount must be strictly smaller than eligibleCount, proving a memory was dropped before scoring",
    );
    assert.equal(detail.unionDropped, detail.eligibleCount - stats.candidateCount);
    assert.ok(detail.unionDropped >= 1);
  });

  it("mid-query partial token matches via all-token prefixing", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    // "roas" is a prefix of "roast", and it is NOT the last query token —
    // the old last-token-only prefixing would miss it.
    repo.create({ userId: "local", type: "semantic", content: "prefers dark roast coffee" });
    const ranks = repo.searchKeyword("roas beans");
    assert.ok(ranks && ranks.size === 1);
  });
});
