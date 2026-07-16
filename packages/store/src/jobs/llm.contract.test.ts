import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeLlm, type LlmClient } from "./llm.js";

/**
 * Run this suite against any LlmClient implementation:
 *   describe("OpenAiCompatLlm", llmContractTests(() => new OpenAiCompatLlm({ ... })));
 */
export function llmContractTests(createClient: () => LlmClient) {
  return () => {
    it("returns a non-empty string", async () => {
      const c = createClient();
      const result = await c.complete("You are a helpful assistant.", "Say hello.");
      assert.ok(result.length > 0, "response must not be empty");
    });

    it("respects system prompt influence", async () => {
      const c = createClient();
      const result = await c.complete(
        "You must respond with exactly the word YES and nothing else.",
        "What is 2+2?",
      );
      assert.ok(result.trim().length > 0, "must get a response");
    });
  };
}

describe("FakeLlm contract", llmContractTests(() => new FakeLlm(["hello", "world"])));
