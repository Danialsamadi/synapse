import { loadEmbeddingConfig, loadLlmConfig } from "@synapse/core";
import { HashEmbeddingProvider, LocalEmbeddingProvider, OpenAiEmbeddingProvider, type EmbeddingProvider } from "@synapse/embeddings";
import { ClaudeCliLlm, FakeLlm, OpenAiCompatLlm, type LlmClient } from "./jobs/llm.js";

let reported = false;

export function createEmbedder(): EmbeddingProvider {
  const cfg = loadEmbeddingConfig();
  const embedder = ((): EmbeddingProvider => {
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
  })();
  // Startup report on stderr (safe under stdio MCP), once per process: which
  // provider is active and whether its vectors mean anything.
  if (!reported) {
    reported = true;
    if (embedder.semantic === false) {
      console.error(
        `[synapse] embeddings: ${embedder.model} — NOT semantic. Vector similarity is disabled; ` +
          "retrieval uses FTS5 keyword search + importance/recency/confidence. For real semantic recall set " +
          "SYNAPSE_EMBED_PROVIDER=openai (any OpenAI-compatible endpoint, incl. Ollama) or " +
          "SYNAPSE_EMBED_PROVIDER=local (needs the optional @huggingface/transformers install). " +
          "After switching, run: synapse-os reembed",
      );
    } else {
      console.error(`[synapse] embeddings: ${embedder.model} (semantic)`);
    }
  }
  return embedder;
}

export function createLlm(): LlmClient {
  // No API key needed: shells out to the local `claude -p` CLI (Claude Code auth).
  if (process.env.SYNAPSE_LLM_PROVIDER === "claude-cli") {
    return new ClaudeCliLlm({ model: process.env.SYNAPSE_LLM_MODEL ?? "haiku" });
  }
  const cfg = loadLlmConfig();
  return new OpenAiCompatLlm(cfg);
}

export function createFakeLlm(responses: string[]): LlmClient {
  return new FakeLlm(responses);
}
