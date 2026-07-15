import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryRepository } from "./memory-repository.js";

describe("MemoryRepository", () => {
  it("creates and gets a memory", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const created = repo.create({
      userId: "local",
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
      userId: "local",
      type: "procedural",
      content: "Prefer concise bullets",
    });
    assert.equal(repo.softDelete(created.id), true);
    const got = repo.get(created.id);
    assert.equal(got?.status, "deleted");
    repo.close();
  });

  it("updates content, status and tags", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const m = repo.create({ userId: "local", type: "semantic", content: "Lives in Toronto" });
    const updated = repo.update(m.id, { status: "superseded", tags: ["location"] });
    assert.equal(updated?.status, "superseded");
    assert.deepEqual(updated?.tags, ["location"]);
    assert.notEqual(updated?.updatedAt, undefined);
    assert.equal(repo.update("nope", { status: "archived" }), null);
    repo.close();
  });

  it("dedupes active by content hash", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const a = repo.create({
      userId: "local",
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

  it("adds and reads links in both directions", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const fact = repo.create({ userId: "local", type: "semantic", content: "Lives in Vancouver" });
    const ep = repo.create({ userId: "local", type: "episodic", content: "Said they moved to Vancouver" });
    repo.addLink(ep.id, fact.id, "supports");
    repo.addLink(ep.id, fact.id, "supports"); // idempotent
    const links = repo.getLinks(fact.id);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.rel, "supports");
    assert.equal(repo.get(fact.id)?.links[0]?.targetId, ep.id);
    repo.close();
  });

  it("stores quarantine and audit rows", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    repo.addQuarantine("extraction", "{bad json", "parse error");
    assert.equal(repo.listQuarantine().length, 1);
    repo.addAudit("export", "full export");
    repo.close();
  });
});
