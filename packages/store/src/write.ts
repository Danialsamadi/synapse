import type { CreateMemoryInput, Memory } from "@synapse/core";
import { detectSecret, secretsAllowed } from "@synapse/core";
import { cosineSimilarity, type EmbeddingProvider } from "@synapse/embeddings";
import type { MemoryRepository } from "./memory-repository.js";

export const DEDUP_REJECT_THRESHOLD = 0.95;
export const DEDUP_ABSORB_THRESHOLD = 0.92;

export interface WriteResult {
  memory: Memory;
  supersededIds: string[];
  deduped: boolean;
  /** True when a near-duplicate (0.92–0.95 cosine) was refreshed instead of creating a new memory. */
  absorbed?: boolean;
}

/** Write refused: content matched a credential pattern and SYNAPSE_ALLOW_SECRETS is unset. */
export interface SecretRejection {
  rejected: true;
  /** Pattern kind only (e.g. "aws-access-key") — never the matched text. */
  kind: string;
}

export type WriteOutcome = WriteResult | SecretRejection;

/**
 * Single write path: exact content-hash dedup + entityKey supersession
 * (createWithEntitySupersede), then semantic dedup against active memories of
 * the same user+type — cosine >= 0.95 returns the existing memory, 0.92–0.95
 * absorbs into it (touch + tag union). Semantic dedup is skipped when:
 * - entityKey is set (supersession is the intended resolution),
 * - the embedder is non-semantic (hash vectors would mis-merge unrelated text),
 * - type is episodic (distinct events legitimately read near-identical — cron
 *   run logs must all survive; exact content-hash dedup still applies).
 */
export async function writeMemory(
  repo: MemoryRepository,
  embedder: EmbeddingProvider,
  input: CreateMemoryInput,
): Promise<WriteOutcome> {
  // Secret gate: a credential must never touch disk — reject before embedding,
  // dedup, or insert. Kind only in the audit; the matched text never leaves
  // detectSecret. Human opt-out: SYNAPSE_ALLOW_SECRETS=1.
  if (!secretsAllowed()) {
    const hit = detectSecret(input.content);
    if (hit) {
      repo.addAudit("secret_rejected", JSON.stringify({
        kind: hit.kind,
        type: input.type,
        source: input.source ?? "api",
      }));
      return { rejected: true, kind: hit.kind };
    }
  }

  const userId = input.userId ?? "local";
  const [vec] = await embedder.embed([input.content]);

  if (!input.entityKey && vec && embedder.semantic !== false && input.type !== "episodic") {
    const exact = repo.findActiveByContentHash(userId, input.type, input.content);
    if (!exact) {
      const candidates = repo
        .listVisible(userId, (input as CreateMemoryInput & { teamIds?: string[] }).teamIds ?? [], { status: "active" })
        .filter((m) => m.type === input.type);
      const vectors = repo.getEmbeddings(candidates.map((m) => m.id));
      let best: { memory: Memory; sim: number } | null = null;
      for (const m of candidates) {
        const v = vectors.get(m.id);
        if (!v || v.length !== vec.length) continue;
        const sim = cosineSimilarity(vec, v);
        if (!best || sim > best.sim) best = { memory: m, sim };
      }
      if (best && best.sim >= DEDUP_REJECT_THRESHOLD) {
        repo.touchAccessed([best.memory.id]);
        // droppedContent: a false-positive dedup discards the incoming write —
        // the audit row is the only place it can be recovered from.
        repo.addAudit("dedup", JSON.stringify({ keptId: best.memory.id, sim: best.sim, droppedContent: input.content }));
        return { memory: best.memory, supersededIds: [], deduped: true };
      }
      if (best && best.sim >= DEDUP_ABSORB_THRESHOLD) {
        const tags = [...new Set([...best.memory.tags, ...(input.tags ?? [])])];
        const updated = repo.update(best.memory.id, { tags }) ?? best.memory;
        repo.touchAccessed([updated.id]);
        repo.addAudit("absorb", JSON.stringify({ keptId: updated.id, sim: best.sim, droppedContent: input.content }));
        return { memory: updated, supersededIds: [], deduped: true, absorbed: true };
      }
    }
  }

  const result = repo.createWithEntitySupersede(input);
  if (!result.deduped && vec) repo.saveEmbedding(result.memory.id, vec, embedder.model);
  return result;
}
