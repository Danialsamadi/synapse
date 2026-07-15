import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_TOOLS,
  MemoryWriteToolInputSchema,
  MemoryRetrieveToolInputSchema,
} from "./tools.js";

describe("memory tool definitions", () => {
  it("exports two tools", () => {
    assert.equal(MEMORY_TOOLS.length, 2);
    assert.equal(MEMORY_TOOLS[0]!.name, "memory_write");
    assert.equal(MEMORY_TOOLS[1]!.name, "memory_retrieve");
  });

  it("each tool has a valid JSON-schema inputSchema", () => {
    for (const tool of MEMORY_TOOLS) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.inputSchema.properties);
    }
  });
});

describe("tool input schemas", () => {
  it("memory_write rejects empty content", () => {
    const result = MemoryWriteToolInputSchema.safeParse({
      type: "episodic",
      content: "",
    });
    assert.equal(result.success, false);
  });

  it("memory_retrieve rejects empty query", () => {
    const result = MemoryRetrieveToolInputSchema.safeParse({ query: "" });
    assert.equal(result.success, false);
  });

  it("memory_retrieve accepts valid input", () => {
    const result = MemoryRetrieveToolInputSchema.safeParse({
      query: "What city do I live in?",
    });
    assert.equal(result.success, true);
  });
});
