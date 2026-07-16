import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEmbeddingConfig, loadLlmConfig } from "./config.js";

describe("provider config", () => {
  it("defaults apply when env vars are unset", () => {
    assert.equal(loadEmbeddingConfig().provider, "hash");
    assert.equal(loadLlmConfig().temperature, 0);
  });

  it("coerces numeric env vars from strings", () => {
    process.env.MNEME_EMBED_DIMENSIONS = "768";
    process.env.MNEME_LLM_TEMPERATURE = "0.5";
    try {
      assert.equal(loadEmbeddingConfig().dimensions, 768);
      assert.equal(loadLlmConfig().temperature, 0.5);
    } finally {
      delete process.env.MNEME_EMBED_DIMENSIONS;
      delete process.env.MNEME_LLM_TEMPERATURE;
    }
  });
});
