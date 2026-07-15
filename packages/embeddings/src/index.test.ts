import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider, cosineSimilarity } from "./index.js";

describe("HashEmbeddingProvider", () => {
  it("is deterministic and self-similar", async () => {
    const p = new HashEmbeddingProvider(16);
    const [a] = await p.embed(["User lives in Toronto"]);
    const [b] = await p.embed(["User lives in Toronto"]);
    assert.ok(a && b);
    assert.ok(cosineSimilarity(a, b) > 0.99);
  });
});
