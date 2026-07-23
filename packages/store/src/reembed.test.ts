import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider, type EmbeddingProvider } from "@synapse/embeddings";
import { MemoryRepository } from "./memory-repository.js";
import { RetrievalService } from "./retrieval.js";
import { reembedAll } from "./reembed.js";
import { writeMemory } from "./write.js";

const fake3d: EmbeddingProvider = {
  model: "fake-3d-v1",
  async embed(texts) {
    return texts.map((t) => (t.includes("Toronto") ? [1, 0, 0] : [0, 1, 0]));
  },
};

describe("reembedAll", () => {
  it("replaces old-dims embeddings so vector retrieval works again", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const hash = new HashEmbeddingProvider(); // 32 dims
    await writeMemory(repo, hash, { userId: "local", type: "semantic", content: "User lives in Toronto" });
    await writeMemory(repo, hash, { userId: "local", type: "semantic", content: "Enjoys cycling" });

    // Simulate a model switch: new provider has 3 dims — old vectors would score 0.
    const { reembedded } = await reembedAll(repo, fake3d);
    assert.equal(reembedded, 2);

    const retrieval = new RetrievalService(repo, fake3d);
    const { memories } = await retrieval.retrieve({ query: "Toronto", userId: "local", limit: 2 });
    assert.equal(memories[0]!.content, "User lives in Toronto");
    // breakdown.vector is the weighted contribution (0.40 x cosine); cosine=1 here.
    assert.ok((memories[0]!.scoreBreakdown?.vector ?? 0) > 0.35); // vector signal restored
  });
});
