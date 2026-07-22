import type { Memory } from "@synapse/core";
import { cosineSimilarity, type EmbeddingProvider } from "@synapse/embeddings";
import type { MemoryRepository } from "../memory-repository.js";
import type { LlmClient } from "./llm.js";

export type ConflictPolicy = "auto_supersede_newest" | "manual_only";

export interface ConflictOutcome {
  conflicts: number;
  superseded: string[];
  disputed: string[];
}

const NEIGHBOR_THRESHOLD = 0.75;

const SYSTEM = `You judge whether two statements about the same user contradict each other
(cannot both be true now). Answer with exactly one word: YES or NO.`;

export async function detectAndResolve(
  repo: MemoryRepository,
  embedder: EmbeddingProvider,
  llm: LlmClient,
  newFact: Memory,
  policy: ConflictPolicy = "auto_supersede_newest",
): Promise<ConflictOutcome> {
  const out: ConflictOutcome = { conflicts: 0, superseded: [], disputed: [] };
  const candidates = repo
    .list(newFact.userId, { status: "active", type: "semantic" })
    .filter((m) => m.id !== newFact.id);
  if (candidates.length === 0) return out;

  const vectors = repo.getEmbeddings([newFact.id, ...candidates.map((m) => m.id)]);
  const newVec = vectors.get(newFact.id);
  if (!newVec) return out;

  const neighbors = candidates.filter((m) => {
    const v = vectors.get(m.id);
    return v ? cosineSimilarity(newVec, v) >= NEIGHBOR_THRESHOLD : false;
  });

  for (const old of neighbors) {
    const verdict = (await llm.complete(SYSTEM, `A: ${old.content}\nB: ${newFact.content}`)).trim().toUpperCase();
    if (!verdict.startsWith("YES")) continue;
    out.conflicts++;
    repo.addLink(newFact.id, old.id, "contradicts");
    if (policy === "auto_supersede_newest") {
      repo.addLink(newFact.id, old.id, "supersedes");
      repo.update(old.id, { status: "superseded" });
      out.superseded.push(old.id);
      repo.addAudit("supersede", JSON.stringify({
        winnerId: newFact.id,
        loserId: old.id,
        via: "conflict",
      }));
    } else {
      repo.update(old.id, { status: "disputed" });
      repo.update(newFact.id, { status: "disputed" });
      out.disputed.push(old.id, newFact.id);
    }
  }
  return out;
}
