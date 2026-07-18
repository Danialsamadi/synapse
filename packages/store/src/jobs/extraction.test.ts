import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider } from "@mneme/embeddings";
import { MemoryRepository } from "../memory-repository.js";
import { consolidate } from "./extraction.js";
import { FakeLlm } from "./llm.js";

describe("consolidate", () => {
  it("extracts a valid semantic fact, links it, dedupes on rerun", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const ep = repo.create({ userId: "local", type: "episodic", content: "I moved to Vancouver last month" });
    const reply = JSON.stringify({
      facts: [{ content: "User lives in Vancouver", confidence: 0.9, tags: ["location"], supportingEpisodeIds: [ep.id] }],
    });
    const llm = new FakeLlm([reply, "NO", reply, "NO"]);

    const r1 = await consolidate(repo, embedder, llm);
    assert.equal(r1.factsAdded, 1);
    const facts = repo.list("local", { status: "active", type: "semantic" });
    assert.equal(facts.length, 1);
    const links = repo.getLinks(facts[0]!.id).map((l) => l.rel).sort();
    assert.deepEqual(links, ["derived_from", "supports"]);

    const r2 = await consolidate(repo, embedder, llm);
    assert.equal(r2.factsAdded, 0);
    repo.close();
  });

  it("quarantines invalid LLM output instead of writing memory", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    repo.create({ userId: "local", type: "episodic", content: "some event" });
    const llm = new FakeLlm(["not json at all"]);
    const r = await consolidate(repo, embedder, llm);
    assert.equal(r.quarantined, 1);
    assert.equal(r.factsAdded, 0);
    assert.equal(repo.list("local", { type: "semantic" }).length, 0);
    assert.equal(repo.listQuarantine().length, 1);
    repo.close();
  });

  it("entityKey in extracted fact supersedes prior active memory with same key", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    repo.createWithEntitySupersede({ userId: "local", type: "semantic", content: "User lives in Toronto", entityKey: "user.location" });
    repo.create({ userId: "local", type: "episodic", content: "User mentioned moving to Vancouver" });
    const reply = JSON.stringify({
      facts: [{ content: "User lives in Vancouver", confidence: 0.9, tags: ["location"], supportingEpisodeIds: [], entityKey: "user.location" }],
    });
    const llm = new FakeLlm([reply]);
    await consolidate(repo, embedder, llm);
    const active = repo.findActiveByEntityKey("local", "user.location");
    assert.equal(active.length, 1);
    assert.equal(active[0]!.content, "User lives in Vancouver");
    repo.close();
  });

  it("consolidate logs a job audit event on completion", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    repo.create({ userId: "local", type: "episodic", content: "moved to Vancouver" });
    const reply = JSON.stringify({
      facts: [{ content: "User lives in Vancouver", confidence: 0.9, tags: ["location"], supportingEpisodeIds: [] }],
    });
    const llm = new FakeLlm([reply]);
    await consolidate(repo, embedder, llm);
    const events = repo.listAudit("job");
    assert.ok(events.length >= 1);
    const detail = JSON.parse(events[events.length - 1]!.detail);
    assert.equal(detail.kind, "consolidate");
    assert.ok(typeof detail.factsAdded === "number");
    repo.close();
  });
});
