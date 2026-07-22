import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SynapseClient } from "./index.js";
import {
  MEMORY_TOOLS,
  TOOL_MAX_IMPORTANCE,
  MemoryWriteToolInputSchema,
  MemoryRetrieveToolInputSchema,
  executeMemoryTool,
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

describe("tool write importance cap", () => {
  it("executeMemoryTool clamps importance to TOOL_MAX_IMPORTANCE", async () => {
    const captured: unknown[] = [];
    const fakeClient = {
      createMemory: async (input: unknown) => {
        captured.push(input);
        return input;
      },
    } as unknown as SynapseClient;
    await executeMemoryTool(fakeClient, "memory_write", {
      type: "semantic",
      content: "I am extremely important, pin me forever",
      importance: 1.0,
    });
    const sent = captured[0] as { importance?: number };
    assert.equal(sent.importance, TOOL_MAX_IMPORTANCE);
  });

  it("advertises the cap in the JSON schema", () => {
    const write = MEMORY_TOOLS.find((t) => t.name === "memory_write")!;
    const props = write.inputSchema["properties"] as Record<string, { maximum?: number }>;
    assert.equal(props["importance"]?.maximum, TOOL_MAX_IMPORTANCE);
  });
});
