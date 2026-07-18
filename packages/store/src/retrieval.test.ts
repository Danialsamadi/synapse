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
});
