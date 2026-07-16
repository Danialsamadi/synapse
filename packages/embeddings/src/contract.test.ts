import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider, type EmbeddingProvider } from "./index.js";

/**
 * Run this suite against any EmbeddingProvider implementation:
 *   describe("OpenAiEmbeddingProvider", embeddingContractTests(() => new OpenAiEmbeddingProvider({ ... })));
 */
export function embeddingContractTests(createProvider: () => EmbeddingProvider) {
  return () => {
    it("returns vectors with consistent dimensions", async () => {
      const p = createProvider();
      const vecs = await p.embed(["hello", "world"]);
      assert.equal(vecs.length, 2);
      const [a, b] = vecs;
      assert.ok(a && b, "must return vectors for each input");
      assert.equal(a.length, b.length, "dimension mismatch between calls");
      assert.ok(a.length > 0, "vector must not be empty");
    });

    it("returns same count as input", async () => {
      const p = createProvider();
      const vecs = await p.embed(["a", "b", "c"]);
      assert.equal(vecs.length, 3);
    });

    it("returns empty array for empty input", async () => {
      const p = createProvider();
      const vecs = await p.embed([]);
      assert.equal(vecs.length, 0);
    });

    it("is deterministic for same input", async () => {
      const p = createProvider();
      const vecsA = await p.embed(["test sentence"]);
      const vecsB = await p.embed(["test sentence"]);
      const [a] = vecsA;
      const [b] = vecsB;
      assert.ok(a && b, "must return vectors");
      assert.deepEqual(a, b);
    });

    it("produces different vectors for different inputs", async () => {
      const p = createProvider();
      const vecsA = await p.embed(["cats are animals"]);
      const vecsB = await p.embed(["quantum computing basics"]);
      const [a] = vecsA;
      const [b] = vecsB;
      assert.ok(a && b, "must return vectors");
      assert.notDeepEqual(a, b);
    });
  };
}

describe("HashEmbeddingProvider contract", embeddingContractTests(() => new HashEmbeddingProvider()));
