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
    // memory.links carries outgoing links; incoming only for symmetric rels
    assert.equal(repo.get(ep.id)?.links[0]?.targetId, fact.id);
    assert.equal(repo.get(fact.id)?.links.length, 0);
    const rival = repo.create({ userId: "local", type: "semantic", content: "Lives in Toronto" });
    repo.addLink(rival.id, fact.id, "contradicts");
    assert.deepEqual(repo.get(fact.id)?.links, [{ rel: "contradicts", targetId: rival.id }]);
    repo.close();
  });

  it("stores quarantine and audit rows", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    repo.addQuarantine("extraction", "{bad json", "parse error");
    assert.equal(repo.listQuarantine().length, 1);
    repo.addAudit("export", "full export");
    repo.close();
  });

  it("saves and reads embeddings", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const m = repo.create({ userId: "local", type: "semantic", content: "Likes espresso" });
    repo.saveEmbedding(m.id, [0.1, 0.2, 0.3], "hash-embed-v0");
    const map = repo.getEmbeddings([m.id, "missing"]);
    assert.deepEqual(map.get(m.id), [0.1, 0.2, 0.3]);
    assert.equal(map.has("missing"), false);
    repo.deleteEmbedding(m.id);
    assert.equal(repo.getEmbeddings([m.id]).size, 0);
    repo.close();
  });

  it("rejects embedding with mismatched dimensions", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const m = repo.create({ userId: "local", type: "semantic", content: "test" });
    repo.saveEmbedding(m.id, [1, 0, 0], "model-a");
    assert.throws(() => {
      repo.saveEmbedding(m.id, [1, 0, 0, 0], "model-b");
    }, /dimension mismatch/);
    repo.close();
  });

  it("creates, updates and queries jobs", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const job = repo.createJob("consolidate", { since: null });
    assert.equal(job.status, "pending");
    repo.updateJob(job.id, "done", { factsAdded: 2 });
    const got = repo.getJob(job.id);
    assert.equal(got?.status, "done");
    assert.equal(repo.lastDoneJob("consolidate")?.id, job.id);
    repo.close();
  });
});

describe("feedback loop", () => {
  it("touchAccessed sets lastAccessedAt", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const m = repo.create({ userId: "local", type: "semantic", content: "fact" });
    assert.equal(m.lastAccessedAt, undefined);
    repo.touchAccessed([m.id]);
    assert.ok(repo.get(m.id)!.lastAccessedAt);
    repo.close();
  });

  it("helpful raises confidence; stale/wrong lower it and dispute the memory", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const a = repo.create({ userId: "local", type: "semantic", content: "a" });
    const b = repo.create({ userId: "local", type: "semantic", content: "b" });

    const helped = repo.applyFeedback(a.id, "helpful")!;
    assert.ok(Math.abs(helped.confidence - 0.8) < 1e-9);
    assert.equal(helped.status, "active");

    const staled = repo.applyFeedback(b.id, "stale")!;
    assert.ok(Math.abs(staled.confidence - 0.4) < 1e-9);
    assert.equal(staled.status, "disputed");

    assert.equal(repo.applyFeedback("nope", "helpful"), null);
    repo.close();
  });

  it("feedback writes an audit-log entry", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const m = repo.create({ userId: "local", type: "semantic", content: "audited fact" });
    repo.applyFeedback(m.id, "stale");
    const entries = repo.listAudit("feedback");
    assert.equal(entries.length, 1);
    assert.deepEqual(JSON.parse(entries[0]!.detail), { id: m.id, verdict: "stale" });
    repo.close();
  });

  it("helpful restores a disputed memory to active", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const m = repo.create({ userId: "local", type: "semantic", content: "redeemed fact" });
    repo.applyFeedback(m.id, "stale");
    assert.equal(repo.get(m.id)!.status, "disputed");
    const restored = repo.applyFeedback(m.id, "helpful")!;
    assert.equal(restored.status, "active");
    repo.close();
  });
});

describe("entity anchoring", () => {
  it("new write with same entityKey supersedes the old active memory", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const first = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User works at Acme Corp", entityKey: "user.employer",
    });
    assert.deepEqual(first.supersededIds, []);

    const second = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User works at Initech", entityKey: "user.employer",
    });
    assert.deepEqual(second.supersededIds, [first.memory.id]);
    assert.equal(repo.get(first.memory.id)!.status, "superseded");
    assert.ok(
      second.memory.links.some((l) => l.rel === "supersedes" && l.targetId === first.memory.id) ||
        repo.get(second.memory.id)!.links.some((l) => l.rel === "supersedes" && l.targetId === first.memory.id),
    );

    const active = repo.findActiveByEntityKey("local", "user.employer");
    assert.deepEqual(active.map((m) => m.id), [second.memory.id]);
    repo.close();
  });

  it("without entityKey behaves like create, deduping identical content", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const r = repo.createWithEntitySupersede({ userId: "local", type: "semantic", content: "plain fact" });
    assert.deepEqual(r.supersededIds, []);
    assert.equal(r.memory.structured, undefined);
    assert.equal(r.deduped, false);
    const again = repo.createWithEntitySupersede({ userId: "local", type: "semantic", content: "plain fact" });
    assert.equal(again.deduped, true);
    assert.equal(again.memory.id, r.memory.id);
    repo.close();
  });

  it("dedupe with a new entityKey attaches the key and supersedes siblings", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const bare = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User lives in Vancouver",
    });
    const rival = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User lives in Toronto", entityKey: "user.location",
    });

    const r = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User lives in Vancouver", entityKey: "user.location",
    });
    assert.equal(r.deduped, true);
    assert.equal(r.memory.id, bare.memory.id);
    assert.equal(r.memory.structured?.entityKey, "user.location");
    assert.deepEqual(r.supersededIds, [rival.memory.id]);
    assert.equal(repo.get(rival.memory.id)!.status, "superseded");
    repo.close();
  });

  it("different entityKeys never interfere", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const employer = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User works at Acme", entityKey: "user.employer",
    });
    const location = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User lives in Toronto", entityKey: "user.location",
    });
    assert.deepEqual(location.supersededIds, []);
    assert.equal(repo.get(employer.memory.id)!.status, "active");
    repo.close();
  });

  it("entityKey supersession is isolated per user", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const alice = repo.createWithEntitySupersede({
      userId: "alice", type: "semantic", content: "Works at Acme", entityKey: "user.employer",
    });
    const bob = repo.createWithEntitySupersede({
      userId: "bob", type: "semantic", content: "Works at Initech", entityKey: "user.employer",
    });
    assert.deepEqual(bob.supersededIds, []);
    assert.equal(repo.get(alice.memory.id)!.status, "active");
    assert.equal(repo.get(bob.memory.id)!.status, "active");
    repo.close();
  });

  it("entity supersession overrides a pin — truth changes beat retention", () => {
    // ponytail: deliberate — a superseded fact is wrong, and wrong facts don't
    // deserve pin protection. Revisit if pins ever mean "immutable".
    const repo = new MemoryRepository({ path: ":memory:" });
    const pinnedOld = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User works at Acme",
      entityKey: "user.employer", retention: { mode: "pinned", pinReason: "test" },
    });
    const next = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User works at Initech", entityKey: "user.employer",
    });
    assert.deepEqual(next.supersededIds, [pinnedOld.memory.id]);
    assert.equal(repo.get(pinnedOld.memory.id)!.status, "superseded");
    repo.close();
  });

  it("resurrecting a previously superseded value creates a fresh active memory", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const toronto1 = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User lives in Toronto", entityKey: "user.location",
    });
    const vancouver = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User lives in Vancouver", entityKey: "user.location",
    });
    // "Moved back": old Toronto row is superseded, so dedupe (active-only) misses it.
    const toronto2 = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "User lives in Toronto", entityKey: "user.location",
    });
    assert.equal(toronto2.deduped, false);
    assert.notEqual(toronto2.memory.id, toronto1.memory.id);
    assert.deepEqual(toronto2.supersededIds, [vancouver.memory.id]);

    const active = repo.findActiveByEntityKey("local", "user.location");
    assert.deepEqual(active.map((m) => m.id), [toronto2.memory.id]);
    assert.equal(repo.get(toronto1.memory.id)!.status, "superseded");
    assert.equal(repo.get(vancouver.memory.id)!.status, "superseded");
    repo.close();
  });
});

describe("audit event logging", () => {
  it("create() logs a write audit event with source", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    repo.create({ userId: "local", type: "semantic", content: "test fact", source: "mcp" });
    const events = repo.listAudit("write");
    assert.equal(events.length, 1);
    const detail = JSON.parse(events[0]!.detail);
    assert.equal(detail.type, "semantic");
    assert.equal(detail.source, "mcp");
    assert.match(detail.contentPreview, /test fact/);
    repo.close();
  });

  it("create() defaults source to api", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    repo.create({ userId: "local", type: "semantic", content: "fact" });
    const events = repo.listAudit("write");
    assert.equal(JSON.parse(events[0]!.detail).source, "api");
    repo.close();
  });

  it("createWithEntitySupersede() logs supersede events", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const first = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "works at Acme", entityKey: "user.employer",
    });
    const second = repo.createWithEntitySupersede({
      userId: "local", type: "semantic", content: "works at Initech", entityKey: "user.employer",
    });
    const supersedeEvents = repo.listAudit("supersede");
    assert.ok(supersedeEvents.length >= 1);
    const detail = JSON.parse(supersedeEvents[0]!.detail);
    assert.equal(detail.winnerId, second.memory.id);
    assert.equal(detail.loserId, first.memory.id);
    assert.equal(detail.via, "entityKey");
    repo.close();
  });

  it("listAudit supports limit parameter, newest first", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    for (let i = 0; i < 5; i++) repo.addAudit("test", `event-${i}`);
    const all = repo.listAudit("test");
    assert.equal(all.length, 5);
    const limited = repo.listAudit("test", 3);
    assert.equal(limited.length, 3);
    assert.ok(limited[0]!.id > limited[1]!.id);
    repo.close();
  });

  it("pruneAudit keeps newest N rows", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    for (let i = 0; i < 10; i++) repo.addAudit("test", `event-${i}`);
    repo.pruneAudit(3);
    const remaining = repo.listAudit("test");
    assert.equal(remaining.length, 3);
    assert.match(remaining[0]!.detail, /event-9/);
    repo.close();
  });
});
