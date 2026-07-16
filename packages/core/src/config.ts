import { z } from "zod";

export const EmbeddingConfigSchema = z.object({
  provider: z.enum(["hash", "openai"]).default("hash"),
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  apiKey: z.string().default(""),
  model: z.string().default("text-embedding-3-small"),
  dimensions: z.number().int().positive().default(1536),
});
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

export const LlmConfigSchema = z.object({
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  apiKey: z.string().default(""),
  model: z.string().default("gpt-4o-mini"),
  temperature: z.number().min(0).max(2).default(0),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export function loadEmbeddingConfig(): EmbeddingConfig {
  return EmbeddingConfigSchema.parse({
    provider: process.env.MNEME_EMBED_PROVIDER,
    baseUrl: process.env.MNEME_EMBED_BASE_URL,
    apiKey: process.env.MNEME_EMBED_API_KEY,
    model: process.env.MNEME_EMBED_MODEL,
    dimensions: process.env.MNEME_EMBED_DIMENSIONS,
  });
}

export function loadLlmConfig(): LlmConfig {
  return LlmConfigSchema.parse({
    baseUrl: process.env.MNEME_LLM_BASE_URL,
    apiKey: process.env.MNEME_LLM_API_KEY,
    model: process.env.MNEME_LLM_MODEL,
    temperature: process.env.MNEME_LLM_TEMPERATURE,
  });
}
