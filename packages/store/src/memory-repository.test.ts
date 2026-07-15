import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryRepository } from "./memory-repository.js";

describe("MemoryRepository", () => {
  it("creates and gets a memory", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const created = repo.create({
      type: "semantic",
      content: "User lives in Toronto",
      tags: ["location"],
    });
    const got = repo.get(created.id);
    assert.ok(got);
    assert.equal(got.content, "User lives in Toronto");
    assert.equal(got.status, "active");
    assert.equal(got.type, "semantic");
    repo.close();
  });

  it("soft-deletes", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const created = repo.create({
      type: "procedural",
      content: "Prefer concise bullets",
    });
    assert.equal(repo.softDelete(created.id), true);
    const got = repo.get(created.id);
    assert.equal(got?.status, "deleted");
    repo.close();
  });

  it("dedupes active by content hash", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const a = repo.create({
      type: "semantic",
      content: "Likes TypeScript",
    });
    const dup = repo.findActiveByContentHash(
      "local",
      "semantic",
      "likes typescript",
    );
    assert.equal(dup?.id, a.id);
    repo.close();
  });
});
