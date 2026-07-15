import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GOLDEN_CASES } from "./cases.js";

describe("GOLDEN_CASES", () => {
  it("includes a stale_fact scenario", () => {
    assert.ok(GOLDEN_CASES.some((c) => c.family === "stale_fact"));
  });

  it("has unique ids", () => {
    const ids = GOLDEN_CASES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
