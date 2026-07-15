import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runEvals } from "./harness.js";

describe("eval harness", () => {
  it("runs all golden cases with zero stale hits and pass rate >= 0.8", async () => {
    const summary = await runEvals(5);
    assert.equal(summary.results.length >= 32, true);
    assert.equal(summary.staleFactRate, 0);
    assert.ok(summary.passRate >= 0.8, `passRate ${summary.passRate}`);
  });
});
