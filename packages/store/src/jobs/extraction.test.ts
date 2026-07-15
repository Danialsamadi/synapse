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
    const ep = repo.create({ type: "episodic", content: "I moved to Vancouver last month" });
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
    repo.create({ type: "episodic", content: "some event" });
    const llm = new FakeLlm(["not json at all"]);
    const r = await consolidate(repo, embedder, llm);
    assert.equal(r.quarantined, 1);
    assert.equal(r.factsAdded, 0);
    assert.equal(repo.list("local", { type: "semantic" }).length, 0);
    assert.equal(repo.listQuarantine().length, 1);
    repo.close();
  });
});
