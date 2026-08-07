import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CreateMemoryInputSchema,
  MemoryStatusSchema,
  MemoryTypeSchema,
} from "./types.js";
import { decayPenalty, eventTime, hybridScore, packByTokenBudget } from "./scoring.js";

describe("MemoryTypeSchema", () => {
  it("accepts core types", () => {
    for (const t of ["episodic", "semantic", "procedural", "working"] as const) {
      assert.equal(MemoryTypeSchema.parse(t), t);
    }
  });
});

describe("MemoryStatusSchema", () => {
  it("accepts lifecycle statuses", () => {
    assert.equal(MemoryStatusSchema.parse("superseded"), "superseded");
  });
});

describe("CreateMemoryInputSchema", () => {
  it("defaults userId", () => {
    const parsed = CreateMemoryInputSchema.parse({
      type: "semantic",
      content: "User prefers TypeScript",
    });
    assert.equal(parsed.userId, "local");
  });
});

describe("decayPenalty", () => {
  it("is zero when pinned", () => {
    assert.equal(decayPenalty(100, 30, "pinned"), 0);
  });

  it("grows with age", () => {
    const young = decayPenalty(7, 30, "default");
    const old = decayPenalty(90, 30, "default");
    assert.ok(old > young);
  });
});

describe("hybridScore", () => {
  it("rewards vector match", () => {
    const high = hybridScore({
      vectorSim: 0.9,
      keywordScore: 0,
      importance: 0.5,
      recency: 0.5,
      decay: 0,
      conflictPenalty: 0,
    });
    const low = hybridScore({
      vectorSim: 0.1,
      keywordScore: 0,
      importance: 0.5,
      recency: 0.5,
      decay: 0,
      conflictPenalty: 0,
    });
    assert.ok(high.score > low.score);
  });

  it("rewards confidence so feedback changes rank order", () => {
    const base = {
      vectorSim: 0.5,
      keywordScore: 0,
      importance: 0.5,
      recency: 0.5,
      decay: 0,
      conflictPenalty: 0,
    };
    const trusted = hybridScore({ ...base, confidence: 0.9 });
    const doubted = hybridScore({ ...base, confidence: 0.2 });
    assert.ok(trusted.score > doubted.score);
    assert.ok(trusted.breakdown.confidence > 0);
  });
});

describe("eventTime", () => {
  it("returns earliest parseable observedAt, else createdAt", () => {
    const createdAt = "2026-07-30T00:00:00.000Z";
    assert.equal(eventTime({ createdAt, sourceRefs: [] }), createdAt);
    assert.equal(
      eventTime({
        createdAt,
        sourceRefs: [
          { kind: "note", id: "a", observedAt: "2026-06-01T00:00:00.000Z" },
          { kind: "note", id: "b", observedAt: "2025-01-01T00:00:00.000Z" },
          { kind: "note", id: "c", observedAt: "not a date" },
        ],
      }),
      "2025-01-01T00:00:00.000Z",
    );
    assert.equal(
      eventTime({ createdAt, sourceRefs: [{ kind: "note", id: "x", observedAt: "junk" }] }),
      createdAt,
    );
  });
});

describe("packByTokenBudget", () => {
  it("stops before exceeding budget", () => {
    const items = [
      { content: "aaaa" }, // ~1 token
      { content: "bbbb" },
      { content: "cccc" },
    ];
    const packed = packByTokenBudget(items, 2);
    assert.ok(packed.length <= 2);
  });
});
