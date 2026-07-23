import { loadEmbeddingConfig, loadLlmConfig } from "@synapse/core";
import { HashEmbeddingProvider, LocalEmbeddingProvider, OpenAiEmbeddingProvider, type EmbeddingProvider } from "@synapse/embeddings";
import { FakeLlm, OpenAiCompatLlm, type LlmClient } from "./jobs/llm.js";

export function createEmbedder(): EmbeddingProvider {
  const cfg = loadEmbeddingConfig();
  switch (cfg.provider) {
    case "openai":
      return new OpenAiEmbeddingProvider({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
      });
    case "local":
      // Only an explicitly set model reaches the local provider — the config
      // default ("text-embedding-3-small") is an OpenAI id, not a HF one.
      return process.env.SYNAPSE_EMBED_MODEL
        ? new LocalEmbeddingProvider(process.env.SYNAPSE_EMBED_MODEL)
        : new LocalEmbeddingProvider();
    case "hash":
    default:
      return new HashEmbeddingProvider();
  }
}

export function createLlm(): LlmClient {
  const cfg = loadLlmConfig();
  return new OpenAiCompatLlm(cfg);
}

export function createFakeLlm(responses: string[]): LlmClient {
  return new FakeLlm(responses);
}
