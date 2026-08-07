import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitIntoMemories } from "./import.js";

describe("splitIntoMemories", () => {
  it("one memory per bullet, one per paragraph, headings dropped", () => {
    const doc = [
      "# My Notes",
      "",
      "The user prefers TypeScript over JavaScript.",
      "",
      "## Preferences",
      "- Always run pnpm test before committing",
      "- Never add co-author trailers",
      "",
      "ok", // < 10 chars → dropped
    ].join("\n");
    assert.deepEqual(splitIntoMemories(doc), [
      "The user prefers TypeScript over JavaScript.",
      "Always run pnpm test before committing",
      "Never add co-author trailers",
    ]);
  });

  it("joins multi-line paragraphs and strips bullets in mixed blocks", () => {
    const doc = "Context line\n- bullet detail here";
    assert.deepEqual(splitIntoMemories(doc), ["Context line bullet detail here"]);
  });

  it("empty input yields nothing", () => {
    assert.deepEqual(splitIntoMemories(""), []);
    assert.deepEqual(splitIntoMemories("# Only Headings\n\n## More"), []);
  });
});
