import {
  ageDays,
  decayPenalty,
  hybridScore,
  packByTokenBudget,
  recencyBoost,
  DEFAULT_RANK_WEIGHTS,
  type Memory,
  type RankWeights,
  type RetrieveRequest,
  type RetrievedMemory,
} from "@mneme/core";
import { cosineSimilarity, type EmbeddingProvider } from "@mneme/embeddings";
import type { MemoryRepository } from "./memory-repository.js";

export class RetrievalService {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly embedder: EmbeddingProvider,
    private readonly weights: RankWeights = DEFAULT_RANK_WEIGHTS,
  ) {}

  async retrieve(req: RetrieveRequest): Promise<{
    memories: RetrievedMemory[];
    stats: { candidateCount: number; latencyMs: number };
  }> {
    const start = performance.now();
    const active = this.repo.list(req.userId, { status: "active" });
    const disputed = req.includeDisputed ? this.repo.list(req.userId, { status: "disputed" }) : [];
    const candidates = [...active, ...disputed].filter((m) => {
      if (req.types && !req.types.includes(m.type)) return false;
      if (req.tags && !req.tags.some((t) => m.tags.includes(t))) return false;
      if (req.since && m.createdAt < req.since) return false;
      if (req.until && m.createdAt > req.until) return false;
      return true;
    });

    const [queryVec] = await this.embedder.embed([req.query]);
    const vectors = this.repo.getEmbeddings(candidates.map((m) => m.id));
    const now = new Date();

    const scored = candidates.map((m) => {
      const vec = vectors.get(m.id);
      const vectorSim = queryVec && vec ? cosineSimilarity(queryVec, vec) : 0;
      const { score, breakdown } = hybridScore({
        vectorSim,
        keywordScore: keywordScore(req.query, m.content),
        importance: m.importance,
        recency: recencyBoost(m.createdAt, m.lastAccessedAt, now),
        decay: decayPenalty(ageDays(m.createdAt, now), m.decayHalfLifeDays, m.retention.mode),
        conflictPenalty: m.status === "disputed" ? 1 : 0,
        weights: this.weights,
      });
      return { memory: m, score, breakdown };
    });

    scored.sort((a, b) => b.score - a.score);
    let top = scored.slice(0, req.limit).map(({ memory: m, score, breakdown }) => toRetrieved(m, score, breakdown, req));
    if (req.tokenBudget) top = packByTokenBudget(top, req.tokenBudget);
    return {
      memories: top,
      stats: { candidateCount: candidates.length, latencyMs: Math.round(performance.now() - start) },
    };
  }
}

/** Fraction of query tokens (len>2) present in content. */
function keywordScore(query: string, content: string): number {
  const c = content.toLowerCase();
  const tokens = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return 0;
  return tokens.filter((t) => c.includes(t)).length / tokens.length;
}

function toRetrieved(
  m: Memory,
  score: number,
  breakdown: Record<string, number>,
  req: RetrieveRequest,
): RetrievedMemory {
  const conflicts = m.links.filter((l) => l.rel === "contradicts").map((l) => l.targetId);
  return {
    id: m.id,
    type: m.type,
    content: m.content,
    score,
    scoreBreakdown: breakdown,
    status: m.status,
    ...(req.includeEvidence ? { evidence: m.sourceRefs } : {}),
    ...(conflicts.length > 0 ? { conflictsWith: conflicts } : {}),
  };
}
