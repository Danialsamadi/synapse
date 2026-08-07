import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryRepository } from "../memory-repository.js";
import { runDecay } from "./decay.js";

describe("decay job", () => {
  it("archives decayed low-utility episodes, keeps pinned and fresh", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const old = repo.create({ userId: "local", type: "episodic", content: "ancient lunch chat", importance: 0.2, decayHalfLifeDays: 30 });
    const pinned = repo.create({
      userId: "local", type: "episodic", content: "pinned old event", importance: 0.2, decayHalfLifeDays: 30,
      retention: { mode: "pinned", pinReason: "user" },
    });
    const fresh = repo.create({ userId: "local", type: "episodic", content: "yesterday's event", importance: 0.2 });
    const future = new Date(Date.now() + 200 * 24 * 3600 * 1000);
    const r = runDecay(repo, "local", future);
    assert.equal(repo.get(old.id)?.status, "archived");
    assert.equal(repo.get(pinned.id)?.status, "active");
    assert.equal(r.archived >= 1, true);
    repo.close();
  });

  it("expires ttl memories past expiresAt", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const w = repo.create({
      userId: "local", type: "working", content: "current task: draft PRD",
      retention: { mode: "ttl", expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    const r = runDecay(repo);
    assert.equal(repo.get(w.id)?.status, "archived");
    assert.equal(r.expired, 1);
    repo.close();
  });

  it("archives memories driven below the confidence floor, active or disputed", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const junk = repo.create({ userId: "local", type: "semantic", content: "hallucinated fact", confidence: 0.05 });
    repo.applyFeedback(junk.id, "wrong"); // → disputed, confidence 0
    const ok = repo.create({ userId: "local", type: "semantic", content: "solid fact" });
    const r = runDecay(repo);
    assert.equal(repo.get(junk.id)?.status, "archived");
    assert.equal(repo.get(ok.id)?.status, "active");
    assert.equal(r.archived, 1);
    repo.close();
  });

  it("ages by event time, not write time: a backdated episode decays immediately", () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const backdated = repo.create({
      userId: "local", type: "episodic", content: "trip to Lisbon last year",
      importance: 0.2, decayHalfLifeDays: 30,
      sourceRefs: [{ kind: "note", id: "journal", observedAt: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString() }],
    });
    runDecay(repo); // now, no time travel — write time is fresh, event time is old
    assert.equal(repo.get(backdated.id)?.status, "archived");
    repo.close();
  });
});
