import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider, type EmbeddingProvider } from "@synapse/embeddings";
import { MemoryRepository } from "./memory-repository.js";
import { writeMemory } from "./write.js";

/** Embedder with scripted vectors per text, to control similarity exactly. */
function fakeEmbedder(map: Record<string, number[]>): EmbeddingProvider {
  return {
    model: "fake-v1",
    async embed(texts) {
      return texts.map((t) => {
        const v = map[t];
        if (!v) throw new Error(`no fixture vector for: ${t}`);
        return v;
      });
    },
  };
}

describe("writeMemory semantic dedup", () => {
  it("rejects near-identical content (cosine >= 0.95) and returns the original", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = fakeEmbedder({
      "User prefers TypeScript": [1, 0, 0],
      "The user prefers TypeScript": [0.99, 0.141, 0], // cos ≈ 0.99
    });
    const first = await writeMemory(repo, embedder, {
      userId: "local",
      type: "semantic",
      content: "User prefers TypeScript",
    });
    const second = await writeMemory(repo, embedder, {
      userId: "local",
      type: "semantic",
      content: "The user prefers TypeScript",
    });
    assert.ok(!("rejected" in first));
    assert.ok(!("rejected" in second));
    assert.equal(second.deduped, true);
    assert.equal(second.memory.id, first.memory.id);
    assert.equal(repo.list("local", { status: "active" }).length, 1);
  });

  it("absorbs in the 0.92–0.95 band: tags merge, no new memory", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = fakeEmbedder({
      a: [1, 0, 0],
      b: [0.93, Math.sqrt(1 - 0.93 * 0.93), 0], // cos = 0.93
    });
    const first = await writeMemory(repo, embedder, {
      userId: "local",
      type: "semantic",
      content: "a",
      tags: ["x"],
    });
    const second = await writeMemory(repo, embedder, {
      userId: "local",
      type: "semantic",
      content: "b",
      tags: ["y"],
    });
    assert.ok(!("rejected" in first));
    assert.ok(!("rejected" in second));
    assert.equal(second.absorbed, true);
    assert.equal(second.memory.id, first.memory.id);
    assert.deepEqual([...second.memory.tags].sort(), ["x", "y"]);
    assert.equal(repo.list("local", { status: "active" }).length, 1);
  });

  it("stores distinct content (cosine < 0.92) as a new memory with embedding", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = fakeEmbedder({ a: [1, 0, 0], c: [0, 1, 0] });
    await writeMemory(repo, embedder, { userId: "local", type: "semantic", content: "a" });
    const res = await writeMemory(repo, embedder, { userId: "local", type: "semantic", content: "c" });
    assert.ok(!("rejected" in res));
    assert.equal(res.deduped, false);
    assert.equal(repo.list("local", { status: "active" }).length, 2);
    assert.equal(repo.getEmbeddings([res.memory.id]).size, 1);
  });

  it("skips semantic dedup when entityKey is set (supersession wins)", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = fakeEmbedder({
      "favorite editor is vim": [1, 0, 0],
      "favorite editor is neovim": [0.99, 0.141, 0],
    });
    await writeMemory(repo, embedder, {
      userId: "local",
      type: "semantic",
      content: "favorite editor is vim",
      entityKey: "user.favorite_editor",
    });
    const second = await writeMemory(repo, embedder, {
      userId: "local",
      type: "semantic",
      content: "favorite editor is neovim",
      entityKey: "user.favorite_editor",
    });
    assert.ok(!("rejected" in second));
    assert.equal(second.deduped, false);
    assert.equal(second.supersededIds.length, 1);
  });
});

describe("writeMemory secret gate", () => {
  it("rejects a credential write: no row, no embedding, kind-only audit", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const result = await writeMemory(repo, embedder, {
      userId: "local",
      type: "semantic",
      content: "my aws key is AKIAABCDEFGHIJKLMNOP",
    });
    assert.ok("rejected" in result && result.rejected);
    assert.equal(result.kind, "aws-access-key");
    assert.equal(repo.list("local").length, 0); // nothing stored
    const audits = repo.listAudit();
    const rejectedEvents = audits.filter((a) => a.action === "secret_rejected");
    assert.equal(rejectedEvents.length, 1);
    assert.ok(!JSON.stringify(audits).includes("AKIAABCDEFGHIJKLMNOP"), "secret leaked into audit");
    assert.equal(audits.filter((a) => a.action === "write").length, 0); // write audit never fired
  });

  it("stores normally when SYNAPSE_ALLOW_SECRETS=1", async () => {
    process.env.SYNAPSE_ALLOW_SECRETS = "1";
    try {
      const repo = new MemoryRepository({ path: ":memory:" });
      const embedder = new HashEmbeddingProvider();
      const result = await writeMemory(repo, embedder, {
        userId: "local",
        type: "semantic",
        content: "my aws key is AKIAABCDEFGHIJKLMNOP",
      });
      assert.ok(!("rejected" in result));
      assert.equal(repo.list("local").length, 1);
    } finally {
      delete process.env.SYNAPSE_ALLOW_SECRETS;
    }
  });

  it("normal content is unaffected by the gate", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const embedder = new HashEmbeddingProvider();
    const result = await writeMemory(repo, embedder, {
      userId: "local",
      type: "semantic",
      content: "prefers dark roast coffee in the morning",
    });
    assert.ok(!("rejected" in result));
    assert.equal(repo.list("local").length, 1);
  });
});
