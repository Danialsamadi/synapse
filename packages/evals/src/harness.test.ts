import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runEvals } from "./harness.js";

describe("eval harness", () => {
  it("runs all golden cases with zero stale hits and pass rate >= 0.95", async () => {
    const summary = await runEvals(5);
    assert.equal(summary.results.length >= 32, true);
    assert.equal(summary.staleFactRate, 0);
    // 0.95: one broken case out of 32 must fail CI, not hide in the margin
    assert.ok(summary.passRate >= 0.95, `passRate ${summary.passRate}`);
  });
});
