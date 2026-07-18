import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider } from "@mneme/embeddings";
import { MemoryRepository } from "./memory-repository.js";
import { RetrievalService, qualifierFor } from "./retrieval.js";
import type { Memory } from "@mneme/core";

async function seeded() {
  const repo = new MemoryRepository({ path: ":memory:" });
  const embedder = new HashEmbeddingProvider();
  const svc = new RetrievalService(repo, embedder);
  const add = async (type: "semantic" | "procedural" | "episodic", content: string, tags: string[] = []) => {
    const m = repo.create({ userId: "local", type, content, tags });
    const [v] = await embedder.embed([content]);
    if (v) repo.saveEmbedding(m.id, v, embedder.model);
    return m;
  };
  return { repo, svc, add };
}

describe("RetrievalService", () => {
  it("ranks a relevant memory above noise and returns score breakdown", async () => {
    const { repo, svc, add } = await seeded();
    const hit = await add("procedural", "Prefer concise bullet answers with tradeoffs", ["style"]);
    await add("episodic", "Ordered a tuna sandwich for lunch on Tuesday");
    const res = await svc.retrieve({ query: "how should you format answers", userId: "local", limit: 5 });
    assert.equal(res.memories[0]?.id, hit.id);
    assert.ok(res.memories[0]?.scoreBreakdown);
    assert.equal(res.stats.candidateCount, 2);
    repo.close();
  });

  it("excludes superseded by default and filters by type/tags", async () => {
    const { repo, svc, add } = await seeded();
    const old = await add("semantic", "User lives in Toronto", ["location"]);
    await add("semantic", "User lives in Vancouver", ["location"]);
    repo.update(old.id, { status: "superseded" });
    const res = await svc.retrieve({ query: "where does the user live", userId: "local", limit: 5 });
    assert.ok(!res.memories.some((m) => m.id === old.id));
    const tagRes = await svc.retrieve({ query: "user", userId: "local", limit: 5, tags: ["nope"] });
    assert.equal(tagRes.memories.length, 0);
    repo.close();
  });

  it("respects token budget", async () => {
    const { repo, svc, add } = await seeded();
    await add("semantic", "A".repeat(400)); // ~100 tokens
    await add("semantic", "B".repeat(400));
    const res = await svc.retrieve({ query: "AAAA", userId: "local", limit: 5, tokenBudget: 120 });
    assert.equal(res.memories.length, 1);
    repo.close();
  });

  it("positive tag filter returns only matching tags", async () => {
    const { repo, svc, add } = await seeded();
    const style = await add("procedural", "Always cite sources", ["style"]);
    const work = await add("semantic", "User works at a startup", ["work"]);
    await add("episodic", "User watched a movie", ["personal"]);
    const res = await svc.retrieve({ query: "user preferences", userId: "local", limit: 10, tags: ["style"] });
    assert.ok(res.memories.some((m) => m.id === style.id));
    assert.ok(!res.memories.some((m) => m.id === work.id));
    assert.ok(res.memories.length >= 1);
    repo.close();
  });

  it("types filter returns only matching types", async () => {
    const { repo, svc, add } = await seeded();
    const sem = await add("semantic", "User lives in Vancouver", ["location"]);
    await add("procedural", "Always cite sources", ["style"]);
    await add("episodic", "User went to a conference", ["work"]);
    const res = await svc.retrieve({ query: "user info", userId: "local", limit: 10, types: ["semantic"] });
    assert.equal(res.memories.length, 1);
    assert.equal(res.memories[0]?.id, sem.id);
    repo.close();
  });

  it("retrieve touches lastAccessedAt on returned memories", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const svc = new RetrievalService(repo, embedder);
    const m = repo.create({ userId: "local", type: "semantic", content: "user prefers typescript" });
    const [v] = await embedder.embed([m.content]);
    if (v) repo.saveEmbedding(m.id, v, embedder.model);
    await svc.retrieve({ query: "typescript preference", userId: "local", limit: 5 });
    assert.ok(repo.get(m.id)!.lastAccessedAt);
    repo.close();
  });
});

describe("digest", () => {
  it("puts pinned first, then by importance, capped at maxItems, excluding working", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const svc = new RetrievalService(repo, new HashEmbeddingProvider());
    repo.create({ userId: "local", type: "semantic", content: "high importance fact", importance: 0.9 });
    repo.create({ userId: "local", type: "semantic", content: "low importance fact", importance: 0.1 });
    const pinned = repo.create({
      userId: "local", type: "procedural", content: "always answer in French",
      importance: 0.2, retention: { mode: "pinned", pinReason: "user asked" },
    });
    repo.create({ userId: "local", type: "working", content: "scratch state" });

    const d = svc.digest("local", 2);
    assert.equal(d.items.length, 2);
    assert.equal(d.items[0]!.id, pinned.id);
    assert.equal(d.items[1]!.content, "high importance fact");
    assert.match(d.text, /- \[procedural\] always answer in French/);
    assert.doesNotMatch(d.text, /scratch state/);
    repo.close();
  });
});

describe("digest edge cases", () => {
  it("empty store returns empty items and text", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const svc = new RetrievalService(repo, new HashEmbeddingProvider());
    const d = svc.digest("local");
    assert.deepEqual(d.items, []);
    assert.equal(d.text, "");
    repo.close();
  });

  it("excludes non-active memories even when pinned", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const svc = new RetrievalService(repo, new HashEmbeddingProvider());
    const pinned = repo.create({
      userId: "local", type: "semantic", content: "pinned but stale",
      retention: { mode: "pinned", pinReason: "test" },
    });
    repo.applyFeedback(pinned.id, "stale"); // → disputed
    const superseded = repo.create({ userId: "local", type: "semantic", content: "old value" });
    repo.update(superseded.id, { status: "superseded" });

    const d = svc.digest("local");
    assert.deepEqual(d.items, []);
    repo.close();
  });

  it("truncates deterministically when pinned memories exceed maxItems", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const svc = new RetrievalService(repo, new HashEmbeddingProvider());
    for (let i = 0; i < 4; i++) {
      repo.create({
        userId: "local", type: "semantic", content: `pinned fact ${i}`,
        retention: { mode: "pinned", pinReason: "test" },
      });
    }
    const a = svc.digest("local", 2);
    const b = svc.digest("local", 2);
    assert.equal(a.items.length, 2);
    assert.deepEqual(a.items.map((i) => i.id), b.items.map((i) => i.id));
    assert.ok(a.items.every((i) => i.content.startsWith("pinned fact")));
    repo.close();
  });
});

describe("qualifierFor", () => {
  const base = (over: Partial<Memory>): Memory => ({
    id: "m1", userId: "local", type: "semantic", status: "active",
    content: "x", importance: 0.5, confidence: 0.9, decayHalfLifeDays: 180,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    sourceRefs: [], links: [], tags: [], retention: { mode: "default" },
    ...over,
  });

  it("is undefined for a fresh, confident, active memory", () => {
    assert.equal(qualifierFor(base({}), new Date()), undefined);
  });

  it("flags old age, disputed status, and low confidence", () => {
    const old = new Date(Date.now() - 240 * 86400_000).toISOString();
    const q = qualifierFor(base({ createdAt: old, status: "disputed", confidence: 0.3 }), new Date());
    assert.match(q!, /stored 8 months ago/);
    assert.match(q!, /disputed/);
    assert.match(q!, /low confidence/);
  });

  it("boundary values do not trigger warnings (exactly 90 days, exactly 0.5 confidence)", () => {
    const now = new Date();
    const exactly90 = new Date(now.getTime() - 90 * 86400_000).toISOString();
    assert.equal(qualifierFor(base({ createdAt: exactly90, confidence: 0.5 }), now), undefined);
    const past90 = new Date(now.getTime() - 91 * 86400_000).toISOString();
    assert.match(qualifierFor(base({ createdAt: past90 }), now)!, /may be outdated/);
    assert.match(qualifierFor(base({ confidence: 0.49 }), now)!, /low confidence/);
  });
});

describe("touch-on-retrieve affects ranking", () => {
  it("an accessed old memory gets a higher recency contribution than an untouched sibling", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { default: Database } = await import("better-sqlite3");

    const dir = mkdtempSync(join(tmpdir(), "mneme-test-"));
    const path = join(dir, "t.db");
    const repo = new MemoryRepository({ path });
    const embedder = new HashEmbeddingProvider();
    const svc = new RetrievalService(repo, embedder);

    const write = async (content: string) => {
      const m = repo.create({ userId: "local", type: "semantic", content });
      const [v] = await embedder.embed([content]);
      if (v) repo.saveEmbedding(m.id, v, embedder.model);
      return m;
    };
    const touched = await write("User prefers TypeScript for backend work");
    const untouched = await write("User prefers TypeScript for frontend work");

    // Age both memories 60 days via a direct connection — createdAt is not settable through the API.
    const raw = new Database(path);
    const old = new Date(Date.now() - 60 * 86400_000).toISOString();
    raw.prepare(`UPDATE memories SET created_at = ?, last_accessed_at = NULL`).run(old);
    raw.close();

    repo.touchAccessed([touched.id]);
    const res = await svc.retrieve({ query: "typescript preference", userId: "local", limit: 5 });
    const t = res.memories.find((m) => m.id === touched.id);
    const u = res.memories.find((m) => m.id === untouched.id);
    assert.ok(t && u, "both memories retrieved");
    assert.ok(
      (t.scoreBreakdown?.recency ?? 0) > (u.scoreBreakdown?.recency ?? 0),
      `touched recency ${t.scoreBreakdown?.recency} must beat untouched ${u.scoreBreakdown?.recency}`,
    );
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("retrieve audit logging", () => {
  it("retrieve logs an audit event with query and stats", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const svc = new RetrievalService(repo, embedder);
    const m = repo.create({ userId: "local", type: "semantic", content: "test fact" });
    const [v] = await embedder.embed([m.content]);
    if (v) repo.saveEmbedding(m.id, v, embedder.model);
    await svc.retrieve({ query: "test", userId: "local", limit: 5 });
    const events = repo.listAudit("retrieve");
    assert.equal(events.length, 1);
    const detail = JSON.parse(events[0]!.detail);
    assert.equal(detail.query, "test");
    assert.ok(Array.isArray(detail.returnedIds));
    assert.ok(typeof detail.candidateCount === "number");
    assert.ok(typeof detail.latencyMs === "number");
    repo.close();
  });
});
