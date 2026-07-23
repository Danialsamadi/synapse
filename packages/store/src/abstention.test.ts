import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider } from "@synapse/embeddings";
import { MemoryRepository } from "./memory-repository.js";
import { RetrievalService } from "./retrieval.js";

describe("retrieval minScore abstention", () => {
  it("filters weak matches when minScore is set, keeps them otherwise", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const retrieval = new RetrievalService(repo, new HashEmbeddingProvider());
    repo.create({ userId: "local", type: "semantic", content: "User lives in Toronto" });

    const loose = await retrieval.retrieve({ query: "quantum chromodynamics lattice", userId: "local", limit: 8 });
    assert.equal(loose.memories.length, 1); // unrelated but still returned without a bar

    const strict = await retrieval.retrieve({
      query: "quantum chromodynamics lattice",
      userId: "local",
      limit: 8,
      minScore: 0.99,
    });
    assert.equal(strict.memories.length, 0); // abstains
  });
});
