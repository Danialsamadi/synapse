import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEmbeddingConfig, loadLlmConfig } from "./config.js";

describe("provider config", () => {
  it("defaults apply when env vars are unset", () => {
    assert.equal(loadEmbeddingConfig().provider, "hash");
    assert.equal(loadLlmConfig().temperature, 0);
  });

  it("infers openai when a key or base URL is configured but no provider is", () => {
    process.env.SYNAPSE_EMBED_API_KEY = "sk-test";
    try {
      assert.equal(loadEmbeddingConfig().provider, "openai");
    } finally {
      delete process.env.SYNAPSE_EMBED_API_KEY;
    }
    process.env.SYNAPSE_EMBED_BASE_URL = "http://localhost:11434/v1";
    try {
      assert.equal(loadEmbeddingConfig().provider, "openai");
    } finally {
      delete process.env.SYNAPSE_EMBED_BASE_URL;
    }
  });

  it("an explicit provider beats the openai inference", () => {
    process.env.SYNAPSE_EMBED_PROVIDER = "hash";
    process.env.SYNAPSE_EMBED_API_KEY = "sk-test";
    try {
      assert.equal(loadEmbeddingConfig().provider, "hash");
    } finally {
      delete process.env.SYNAPSE_EMBED_PROVIDER;
      delete process.env.SYNAPSE_EMBED_API_KEY;
    }
  });

  it("coerces numeric env vars from strings", () => {
    process.env.SYNAPSE_EMBED_DIMENSIONS = "768";
    process.env.SYNAPSE_LLM_TEMPERATURE = "0.5";
    try {
      assert.equal(loadEmbeddingConfig().dimensions, 768);
      assert.equal(loadLlmConfig().temperature, 0.5);
    } finally {
      delete process.env.SYNAPSE_EMBED_DIMENSIONS;
      delete process.env.SYNAPSE_LLM_TEMPERATURE;
    }
  });
});
