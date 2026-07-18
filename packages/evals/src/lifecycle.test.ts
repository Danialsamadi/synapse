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
      userId: "local", type: "semantic", content: "User lives in Toronto", tags: ["location"],
    });
    const [tv] = await embedder.embed([toronto.content]);
    if (tv) repo.saveEmbedding(toronto.id, tv, embedder.model);

    const episode = repo.create({
      userId: "local", type: "episodic", content: "User said they moved from Toronto to Vancouver last month",
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

  it("entityKey path: consolidation supersedes the anchored fact without needing conflict detection", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const retrieval = new RetrievalService(repo, embedder);

    const { memory: acme } = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User works at Acme Corp", entityKey: "user.employer",
    });
    const [av] = await embedder.embed([acme.content]);
    if (av) repo.saveEmbedding(acme.id, av, embedder.model);

    const episode = repo.create({
      userId: "local", type: "episodic", content: "User mentioned they just started a new job at Initech",
    });
    const [ev] = await embedder.embed([episode.content]);
    if (ev) repo.saveEmbedding(episode.id, ev, embedder.model);

    const reply = JSON.stringify({
      facts: [{
        content: "User works at Initech", confidence: 0.9, tags: ["work"],
        supportingEpisodeIds: [episode.id], entityKey: "user.employer",
      }],
    });
    const llm = new FakeLlm([reply, "NO"]);

    const result = await consolidate(repo, embedder, llm);
    assert.equal(result.factsAdded, 1);
    assert.equal(repo.get(acme.id)?.status, "superseded");

    const active = repo.findActiveByEntityKey("local", "user.employer");
    assert.equal(active.length, 1);
    assert.equal(active[0]!.content, "User works at Initech");

    const res = await retrieval.retrieve({ query: "where does the user work", userId: "local", limit: 5 });
    assert.ok(!res.memories.some((m) => m.id === acme.id), "stale employer must not surface");

    repo.close();
  });
});
