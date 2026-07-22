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
      return new LocalEmbeddingProvider();
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
