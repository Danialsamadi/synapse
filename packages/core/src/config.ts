import { z } from "zod";

export const EmbeddingConfigSchema = z.object({
  provider: z.enum(["hash", "local", "openai"]).default("hash"),
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  apiKey: z.string().default(""),
  model: z.string().default("text-embedding-3-small"),
  dimensions: z.coerce.number().int().positive().default(1536),
});
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

export const LlmConfigSchema = z.object({
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  apiKey: z.string().default(""),
  model: z.string().default("gpt-4o-mini"),
  temperature: z.coerce.number().min(0).max(2).default(0),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export function loadEmbeddingConfig(): EmbeddingConfig {
  return EmbeddingConfigSchema.parse({
    provider: process.env.SYNAPSE_EMBED_PROVIDER,
    baseUrl: process.env.SYNAPSE_EMBED_BASE_URL,
    apiKey: process.env.SYNAPSE_EMBED_API_KEY,
    model: process.env.SYNAPSE_EMBED_MODEL,
    dimensions: process.env.SYNAPSE_EMBED_DIMENSIONS,
  });
}

export function loadLlmConfig(): LlmConfig {
  return LlmConfigSchema.parse({
    baseUrl: process.env.SYNAPSE_LLM_BASE_URL,
    apiKey: process.env.SYNAPSE_LLM_API_KEY,
    model: process.env.SYNAPSE_LLM_MODEL,
    temperature: process.env.SYNAPSE_LLM_TEMPERATURE,
  });
}

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Canonical DB location: SYNAPSE_DB override, else ~/.synapse/synapse.db.
 * Creates the parent directory so callers can open the DB directly.
 */
export function resolveDbPath(): string {
  const path = process.env.SYNAPSE_DB ?? join(homedir(), ".synapse", "synapse.db");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** SYNAPSE_ALLOW_SECRETS=1|true disables the write-time credential gate.
 *  Env-only by design: a human sets it in server config; an agent cannot
 *  self-override the way it could a tool parameter. Read at call time so
 *  tests can toggle it. */
export function secretsAllowed(): boolean {
  const v = process.env.SYNAPSE_ALLOW_SECRETS;
  return v === "1" || v === "true";
}
