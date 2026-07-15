import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider } from "@mneme/embeddings";
import { MemoryRepository, RetrievalService, consolidate, FakeLlm } from "@mneme/store";

describe("lifecycle: episode → extraction → conflict → supersession → retrieval", () => {
  it("Toronto→Vancouver: extracted fact supersedes old, retrieval excludes stale", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const retrieval = new RetrievalService(repo, embedder);

    const toronto = repo.create({
      type: "semantic", content: "User lives in Toronto", tags: ["location"],
    });
    const [tv] = await embedder.embed([toronto.content]);
    if (tv) repo.saveEmbedding(toronto.id, tv, embedder.model);

    const episode = repo.create({
      type: "episodic", content: "User said they moved from Toronto to Vancouver last month",
    });
    const [ev] = await embedder.embed([episode.content]);
    if (ev) repo.saveEmbedding(episode.id, ev, embedder.model);

    const reply = JSON.stringify({
      facts: [{ content: "User lives in Vancouver", confidence: 0.9, tags: ["location"], supportingEpisodeIds: [episode.id] }],
    });
    const llm = new FakeLlm([reply, "YES"]);

    const result = await consolidate(repo, embedder, llm);
    assert.equal(result.factsAdded, 1);
    assert.equal(result.conflicts, 1);

    const torontoAfter = repo.get(toronto.id);
    assert.equal(torontoAfter?.status, "superseded");

    const res = await retrieval.retrieve({ query: "where does the user live", userId: "local", limit: 5 });
    const ids = res.memories.map((m) => m.id);
    assert.ok(ids.includes(toronto.id) === false, "stale Toronto should not appear");
    assert.ok(ids.some((id) => id !== toronto.id), "should have some result");

    repo.close();
  });
});
