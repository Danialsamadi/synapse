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
} from "@synapse/core";
import { cosineSimilarity, type EmbeddingProvider } from "@synapse/embeddings";
import type { MemoryRepository } from "./memory-repository.js";
import { parseTimeWindow } from "./time-window.js";

export class RetrievalService {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly embedder: EmbeddingProvider,
    private readonly weights: RankWeights = DEFAULT_RANK_WEIGHTS,
  ) {}

  /** Always-on core memory: pinned first, then top-importance active non-working. */
  digest(
    userId: string,
    maxItems = 12,
    tokenBudget?: number,
  ): {
    items: Array<{ id: string; type: Memory["type"]; content: string }>;
    text: string;
    sections: Array<{ label: string; description: string; items: string[] }>;
    truncated: boolean;
  } {
    const active = this.repo
      .list(userId, { status: "active" })
      .filter((m) => m.type !== "working");
    const pinned = active.filter((m) => m.retention.mode === "pinned");
    const rest = active
      .filter((m) => m.retention.mode !== "pinned")
      .sort((a, b) => b.importance - a.importance);

    // Pinned are never cut (Letta priority-0 semantics); the rest fill what's
    // left of maxItems and the approximate token budget, by importance.
    const estimate = (s: string) => Math.ceil(s.length / 4);
    let budget = tokenBudget ?? Infinity;
    const chosen: Memory[] = [];
    for (const m of pinned) {
      chosen.push(m);
      budget -= estimate(m.content);
    }
    let truncated = false;
    for (const m of rest) {
      if (chosen.length >= maxItems || budget < estimate(m.content)) {
        truncated = true;
        continue;
      }
      chosen.push(m);
      budget -= estimate(m.content);
    }

    const SECTION_META: Record<string, { label: string; description: string }> = {
      procedural: {
        label: "How to work with this user",
        description: "Standing instructions and preferences for how to behave. Follow these.",
      },
      semantic: {
        label: "Facts about the user",
        description: "Durable facts. Treat as current truth unless the user contradicts them.",
      },
      episodic: {
        label: "Notable history",
        description: "Past events for context; use memory_retrieve for details.",
      },
    };
    const sections = Object.entries(SECTION_META)
      .map(([type, meta]) => ({
        ...meta,
        items: chosen.filter((m) => m.type === type).map((m) => m.content),
      }))
      .filter((s) => s.items.length > 0);

    const items = chosen.map((m) => ({ id: m.id, type: m.type, content: m.content }));
    const text = sections
      .map((s) => `## ${s.label}\n(${s.description})\n${s.items.map((i) => `- ${i}`).join("\n")}`)
      .join("\n\n");
    return { items, text, sections, truncated };
  }

  async retrieve(req: RetrieveRequest): Promise<{
    memories: RetrievedMemory[];
    stats: { candidateCount: number; latencyMs: number };
  }> {
    const start = performance.now();
    // Explicit since/until win; otherwise mine the query for relative time
    // ("yesterday", "last week") so temporal questions filter by date.
    if (req.since === undefined && req.until === undefined) {
      const window = parseTimeWindow(req.query);
      req = { ...req, ...window };
    }
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
      // Dims mismatch = embedding from a different provider; similarity would be noise.
      const vectorSim =
        queryVec && vec && vec.length === queryVec.length ? cosineSimilarity(queryVec, vec) : 0;
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
    // Abstention: below minScore is noise, not evidence — return nothing rather than weakly-related memories.
    const eligible = req.minScore !== undefined ? scored.filter((s) => s.score >= req.minScore!) : scored;
    let top = eligible.slice(0, req.limit).map(({ memory: m, score, breakdown }) => toRetrieved(m, score, breakdown, req, now));
    if (req.tokenBudget) top = packByTokenBudget(top, req.tokenBudget);
    this.repo.touchAccessed(top.map((m) => m.id));
    this.repo.addAudit("retrieve", JSON.stringify({
      query: req.query,
      returnedIds: top.map((m) => m.id),
      candidateCount: candidates.length,
      latencyMs: Math.round(performance.now() - start),
    }));
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
  now: Date,
): RetrievedMemory {
  const conflicts = m.links.filter((l) => l.rel === "contradicts").map((l) => l.targetId);
  const qualifier = qualifierFor(m, now);
  return {
    id: m.id,
    type: m.type,
    content: m.content,
    score,
    scoreBreakdown: breakdown,
    status: m.status,
    ...(req.includeEvidence ? { evidence: m.sourceRefs } : {}),
    ...(conflicts.length > 0 ? { conflictsWith: conflicts } : {}),
    ...(qualifier ? { qualifier } : {}),
  };
}

/** Human-readable trust hints for the consuming LLM; undefined when fresh + confident. */
export function qualifierFor(m: Memory, now: Date): string | undefined {
  const parts: string[] = [];
  const days = ageDays(m.createdAt, now);
  if (days > 90) parts.push(`stored ${Math.round(days / 30)} months ago — may be outdated`);
  if (m.status === "disputed") parts.push("disputed by a conflicting memory");
  if (m.confidence < 0.5) parts.push("low confidence");
  return parts.length > 0 ? parts.join("; ") : undefined;
}
