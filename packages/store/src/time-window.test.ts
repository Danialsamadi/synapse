import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider } from "@synapse/embeddings";
import { MemoryRepository } from "./memory-repository.js";
import { RetrievalService } from "./retrieval.js";
import { parseTimeWindow } from "./time-window.js";

// Fixed reference: Wednesday 2026-07-15 12:00 local time.
const NOW = new Date(2026, 6, 15, 12, 0, 0);

describe("parseTimeWindow", () => {
  it("yesterday → previous calendar day window", () => {
    const w = parseTimeWindow("what did I say yesterday", NOW);
    assert.equal(w.since, new Date(2026, 6, 14).toISOString());
    assert.equal(w.until, new Date(2026, 6, 15).toISOString());
  });

  it("last week → previous Monday-to-Monday window", () => {
    const w = parseTimeWindow("meetings last week", NOW);
    assert.equal(w.since, new Date(2026, 6, 6).toISOString());
    assert.equal(w.until, new Date(2026, 6, 13).toISOString());
  });

  it("3 days ago → that single day-unit window", () => {
    const w = parseTimeWindow("the bug I hit 3 days ago", NOW);
    assert.equal(w.since, new Date(2026, 6, 12).toISOString());
    assert.equal(w.until, new Date(2026, 6, 13).toISOString());
  });

  it("past 2 weeks → open-ended since", () => {
    const w = parseTimeWindow("progress over the past 2 weeks", NOW);
    assert.equal(w.since, new Date(2026, 6, 1).toISOString());
    assert.equal(w.until, undefined);
  });

  it("last month → previous calendar month", () => {
    const w = parseTimeWindow("what happened last month", NOW);
    assert.equal(w.since, new Date(2026, 5, 1).toISOString());
    assert.equal(w.until, new Date(2026, 6, 1).toISOString());
  });

  it("no time phrase → empty window", () => {
    assert.deepEqual(parseTimeWindow("favorite programming language", NOW), {});
  });
});

describe("time-aware retrieval integration", () => {
  it("'yesterday' query excludes memories created today", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const retrieval = new RetrievalService(repo, new HashEmbeddingProvider());
    repo.create({ userId: "local", type: "episodic", content: "Discussed the deploy pipeline" });

    const plain = await retrieval.retrieve({ query: "deploy pipeline", userId: "local", limit: 8 });
    assert.equal(plain.memories.length, 1);

    const temporal = await retrieval.retrieve({
      query: "deploy pipeline yesterday",
      userId: "local",
      limit: 8,
    });
    assert.equal(temporal.memories.length, 0); // created today, window is yesterday
  });

  it("explicit since/until beats query parsing", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const retrieval = new RetrievalService(repo, new HashEmbeddingProvider());
    repo.create({ userId: "local", type: "episodic", content: "Discussed the deploy pipeline" });
    const res = await retrieval.retrieve({
      query: "deploy pipeline yesterday",
      userId: "local",
      limit: 8,
      since: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal(res.memories.length, 1);
  });
});

describe("digest v2", () => {
  it("pinned survive the budget; rest fill by importance; sections have descriptions", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const retrieval = new RetrievalService(repo, new HashEmbeddingProvider());
    repo.create({
      userId: "local",
      type: "semantic",
      content: "Name is Danial",
      retention: { mode: "pinned" },
    });
    repo.create({ userId: "local", type: "procedural", content: "Always answer in English", importance: 0.9 });
    repo.create({ userId: "local", type: "semantic", content: "x".repeat(4000), importance: 0.5 });

    const d = retrieval.digest("local", 12, 60);
    const contents = d.items.map((i) => i.content);
    assert.ok(contents.includes("Name is Danial")); // pinned always in
    assert.ok(contents.includes("Always answer in English")); // fits budget
    assert.ok(!contents.some((c) => c.length > 3000)); // giant memory cut
    assert.equal(d.truncated, true);
    assert.ok(d.sections.every((s) => s.description.length > 0));
    assert.ok(d.text.includes("## Facts about the user"));
  });
});
