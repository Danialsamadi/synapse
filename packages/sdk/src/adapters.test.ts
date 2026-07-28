import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toAnthropicTools, toOpenAiTools, anthropicForceTool, openAiForceTool, parseToolCall } from "./adapters.js";
import { MEMORY_TOOLS } from "./tools.js";

describe("provider adapters", () => {
  it("converts to Anthropic Messages API format", () => {
    const tools = toAnthropicTools();
    assert.equal(tools.length, MEMORY_TOOLS.length);
    const write = tools.find((t) => t.name === "memory_write")!;
    assert.equal(write.input_schema["type"], "object");
    assert.ok(write.description.length > 0);
    assert.ok(!("inputSchema" in write));
  });

  it("converts to OpenAI Chat Completions format", () => {
    const tools = toOpenAiTools();
    const write = tools.find((t) => t.function.name === "memory_write")!;
    assert.equal(write.type, "function");
    assert.equal(write.function.parameters["type"], "object");
  });

  it("normalizes an Anthropic tool_use block", () => {
    const call = parseToolCall({
      type: "tool_use",
      id: "toolu_01",
      name: "memory_retrieve",
      input: { query: "where do I live" },
    });
    assert.deepEqual(call, { id: "toolu_01", name: "memory_retrieve", args: { query: "where do I live" } });
  });

  it("normalizes an OpenAI tool call (arguments is a JSON string)", () => {
    const call = parseToolCall({
      id: "call_01",
      type: "function",
      function: { name: "memory_write", arguments: '{"type":"semantic","content":"x"}' },
    });
    assert.equal(call.name, "memory_write");
    assert.deepEqual(call.args, { type: "semantic", content: "x" });
  });

  it("builds tool_choice forcing objects for both providers", () => {
    assert.deepEqual(anthropicForceTool(), { type: "tool", name: "memory_retrieve" });
    assert.deepEqual(openAiForceTool("memory_write"), {
      type: "function",
      function: { name: "memory_write" },
    });
  });

  it("throws on unrecognized shapes and bad JSON", () => {
    assert.throws(() => parseToolCall({ hello: "world" }));
    assert.throws(() =>
      parseToolCall({ id: "c", type: "function", function: { name: "x", arguments: "{not json" } }),
    );
  });
});
