import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider, OpenAiEmbeddingProvider, cosineSimilarity } from "./index.js";

describe("OpenAiEmbeddingProvider error hints", () => {
  it("a 404 from /embeddings explains that the base URL is likely chat-only", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => new Response("Not Found", { status: 404 });
    try {
      const p = new OpenAiEmbeddingProvider({ baseUrl: "http://router.local/v1" });
      await assert.rejects(p.embed(["x"]), /may not serve \/embeddings.*Ollama/s);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("other failures keep the plain status error, no misleading hint", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => new Response("upstream boom", { status: 500 });
    try {
      const p = new OpenAiEmbeddingProvider({ baseUrl: "http://router.local/v1" });
      await assert.rejects(p.embed(["x"]), (err: Error) =>
        /failed \(500\)/.test(err.message) && !/embeddings-capable/.test(err.message));
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("HashEmbeddingProvider", () => {
  it("is deterministic and self-similar", async () => {
    const p = new HashEmbeddingProvider(16);
    const [a] = await p.embed(["User lives in Toronto"]);
    const [b] = await p.embed(["User lives in Toronto"]);
    assert.ok(a && b);
    assert.ok(cosineSimilarity(a, b) > 0.99);
  });
});
