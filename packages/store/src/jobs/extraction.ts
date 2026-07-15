import { z } from "zod";
import type { EmbeddingProvider } from "@mneme/embeddings";
import type { MemoryRepository } from "../memory-repository.js";
import type { LlmClient } from "./llm.js";

export const ExtractedFactsSchema = z.object({
  facts: z.array(
    z.object({
      content: z.string().min(1),
      confidence: z.number().min(0).max(1),
      tags: z.array(z.string()).default([]),
      supportingEpisodeIds: z.array(z.string()).default([]),
    }),
  ),
});

export interface ConsolidateResult {
  factsAdded: number;
  duplicates: number;
  quarantined: number;
  episodesProcessed: number;
}

const SYSTEM = `You extract durable semantic facts about the user from episodic memories.
Return ONLY JSON: {"facts":[{"content":string,"confidence":0..1,"tags":string[],"supportingEpisodeIds":string[]}]}.
Only include facts stated or strongly implied. Empty facts array if none.`;

export async function consolidate(
  repo: MemoryRepository,
  embedder: EmbeddingProvider,
  llm: LlmClient,
  userId = "local",
): Promise<ConsolidateResult> {
  const last = repo.lastDoneJob("consolidate");
  const since = last?.createdAt ?? "";
  const episodes = repo
    .list(userId, { status: "active", type: "episodic" })
    .filter((e) => e.createdAt > since);

  const result: ConsolidateResult = { factsAdded: 0, duplicates: 0, quarantined: 0, episodesProcessed: episodes.length };
  if (episodes.length === 0) return result;

  const user = episodes.map((e) => `[${e.id}] ${e.content}`).join("\n");
  const raw = await llm.complete(SYSTEM, user);

  let parsed: z.infer<typeof ExtractedFactsSchema>;
  try {
    parsed = ExtractedFactsSchema.parse(JSON.parse(raw));
  } catch (err) {
    repo.addQuarantine("extraction", raw, String(err));
    result.quarantined = 1;
    return result;
  }

  const validEpisodeIds = new Set(episodes.map((e) => e.id));
  for (const fact of parsed.facts) {
    const existing = repo.findActiveByContentHash(userId, "semantic", fact.content);
    if (existing) {
      result.duplicates++;
      continue;
    }
    const supporting = fact.supportingEpisodeIds.filter((id) => validEpisodeIds.has(id));
    const memory = repo.create({
      userId,
      type: "semantic",
      content: fact.content,
      confidence: fact.confidence,
      tags: fact.tags,
      sourceRefs: supporting.map((id) => ({ kind: "message" as const, id, observedAt: new Date().toISOString() })),
    });
    const [vec] = await embedder.embed([memory.content]);
    if (vec) repo.saveEmbedding(memory.id, vec, embedder.model);
    for (const epId of supporting) {
      repo.addLink(epId, memory.id, "supports");
      repo.addLink(memory.id, epId, "derived_from");
    }
    result.factsAdded++;
  }
  return result;
}
