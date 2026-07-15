import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CreateMemoryInputSchema,
  MemoryStatusSchema,
  MemoryTypeSchema,
} from "./types.js";
import { decayPenalty, hybridScore, packByTokenBudget } from "./scoring.js";

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
