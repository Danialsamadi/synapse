import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider } from "@synapse/embeddings";
import { MemoryRepository } from "./memory-repository.js";
import { RetrievalService } from "./retrieval.js";

describe("export and purge", () => {
  it("export excludes deleted; purge removes rows, vectors, links", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const keep = repo.create({ userId: "local", type: "semantic", content: "keep me" });
    const kill = repo.create({ userId: "local", type: "semantic", content: "delete me", tags: ["work"] });
    repo.saveEmbedding(kill.id, [1, 0], "hash-embed-v0");
    repo.addLink(keep.id, kill.id, "related_to");

    assert.equal(repo.softDeleteWhere("local", { tags: ["work"] }), 1);
    const exported = repo.exportAll("local");
    assert.deepEqual(exported.memories.map((m) => m.id), [keep.id]);

    const { purged } = repo.purgeDeleted();
    assert.equal(purged, 1);
    assert.equal(repo.get(kill.id), null);
    assert.equal(repo.getEmbeddings([kill.id]).size, 0);
    assert.equal(repo.getLinks(keep.id).length, 0);
    repo.close();
  });
});

describe("purge completeness", () => {
  it("retrieve returns nothing after full purge", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const m = repo.create({ userId: "local", type: "semantic", content: "User lives in Vancouver" });
    const [v] = await embedder.embed([m.content]);
    if (v) repo.saveEmbedding(m.id, v, embedder.model);

    repo.softDelete(m.id);
    repo.purgeDeleted();

    const svc = new RetrievalService(repo, embedder);
    const res = await svc.retrieve({ query: "where does the user live", userId: "local", limit: 10 });
    assert.equal(res.memories.length, 0);
    assert.equal(res.stats.candidateCount, 0);
    repo.close();
  });
});
