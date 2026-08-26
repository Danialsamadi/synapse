import {
  ageDays,
  decayPenalty,
  eventTime,
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
import type { LlmClient } from "./jobs/llm.js";
import { parseTimeWindow } from "./time-window.js";

/** Additive boost for members of the best-ranked tag group. */
export const GROUP_BOOST = 0.05;

export class RetrievalService {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly embedder: EmbeddingProvider,
    private readonly weights: RankWeights = DEFAULT_RANK_WEIGHTS,
    private readonly llm?: LlmClient,
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
    // One clock for the whole call: the query window, recency and decay must
    // agree. req.now lets a caller ask a question as of a past date; an
    // unparseable value falls back rather than throwing RangeError out of
    // toISOString() — retrieve() is reachable from HTTP and MCP.
    const parsedNow = req.now ? new Date(req.now) : new Date();
    const now = Number.isNaN(parsedNow.getTime()) ? new Date() : parsedNow;
    // Explicit since/until win; otherwise mine the query for relative time
    // ("yesterday", "last week") so temporal questions filter by date.
    if (req.since === undefined && req.until === undefined) {
      req = { ...req, ...parseTimeWindow(req.query, now) };
    }
    const active = this.repo.list(req.userId, { status: "active" });
    const disputed = req.includeDisputed ? this.repo.list(req.userId, { status: "disputed" }) : [];
    // No empty-pool fallback on purpose. An empty window used to mean "the clock
    // was wrong" (measured: 7 LongMemEval questions resolved their window into
    // the current year and retrieved nothing) — fixed above by anchoring to
    // req.now. What remains is the honest case: nothing happened in the window
    // the user asked about, and saying so is why abstention scores 7/7.
    const eligible = [...active, ...disputed].filter((m) => {
      if (req.types && !req.types.includes(m.type)) return false;
      if (req.tags && !req.tags.some((t) => m.tags.includes(t))) return false;
      // Temporal filters match when the fact was true (event time), not when
      // it was written — a backdated import must not answer "this week".
      // Numeric compare: observedAt is parseable but not guaranteed ISO-sortable.
      const et = Date.parse(eventTime(m));
      if (req.since && et < Date.parse(req.since)) return false;
      if (req.until && et > Date.parse(req.until)) return false;
      return true;
    });

    // Non-semantic embedder (hash): similarities would be noise. Skip the
    // query embed, contribute 0 to every vector term, and let candidacy come
    // from keyword search alone — FTS5 + importance/recency/confidence carry
    // the ranking.
    const semantic = this.embedder.semantic !== false;
    const [queryVec] = semantic ? await this.embedder.embed([req.query]) : [undefined];
    // ponytail: linear scan over all eligible vectors — fine at personal scale
    // (thousands); the B′ union below saves scoring work, not scan work. Swap
    // the vector side to a sqlite-vec index if retrieval latency ever matters.
    const vectors = semantic
      ? this.repo.getEmbeddings(eligible.map((m) => m.id))
      : new Map<string, number[]>();
    // (clock hoisted above — recency and decay use the same `now` as the window)
    const sims = new Map<string, number>();
    for (const m of eligible) {
      const vec = vectors.get(m.id);
      // Dims mismatch = embedding from a different provider; similarity would be noise.
      sims.set(
        m.id,
        queryVec && vec && vec.length === queryVec.length ? cosineSimilarity(queryVec, vec) : 0,
      );
    }

    // B′ candidacy: (FTS keyword hits ∪ vector top-K) — a memory matching
    // neither is noise for this query; always-know facts are the digest's job.
    const keywordRanks = this.repo.searchKeyword(req.query);
    let candidates: Memory[];
    if (keywordRanks === null) {
      candidates = eligible; // FTS broken → legacy full scan, substring keyword below
    } else if (!semantic) {
      candidates = eligible.filter((m) => keywordRanks.has(m.id));
    } else {
      const K = Math.max(req.limit * 4, 40);
      const topK = new Set(
        [...eligible].sort((a, b) => sims.get(b.id)! - sims.get(a.id)!).slice(0, K).map((m) => m.id),
      );
      candidates = eligible.filter((m) => topK.has(m.id) || keywordRanks.has(m.id));
    }

    const scored = candidates.map((m) => {
      const { score, breakdown } = hybridScore({
        vectorSim: sims.get(m.id)!,
        keywordScore:
          keywordRanks === null ? keywordScore(req.query, m.content) : keywordRanks.get(m.id) ?? 0,
        importance: m.importance,
        confidence: m.confidence,
        recency: recencyBoost(m.createdAt, m.lastAccessedAt, now),
        decay: decayPenalty(ageDays(eventTime(m), now), m.decayHalfLifeDays, m.retention.mode),
        conflictPenalty: m.status === "disputed" ? 1 : 0,
        weights: this.weights,
      });
      return { memory: m, score, breakdown: breakdown as Record<string, number> };
    });

    // Rank-based group boost (ordinal, MemPalace-closet style): the tag group
    // whose best member scored highest is likely the query's topic — nudge its
    // members so weak siblings of a strong hit outrank unrelated stragglers.
    // Rank, not raw distances, so it's robust to score-scale drift. Inert when
    // there's only one group (a uniform shift would just distort minScore).
    const bestPerTag = new Map<string, number>();
    for (const s of scored) {
      for (const t of s.memory.tags) {
        if ((bestPerTag.get(t) ?? -Infinity) < s.score) bestPerTag.set(t, s.score);
      }
    }
    if (bestPerTag.size > 1) {
      const topTag = [...bestPerTag.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      for (const s of scored) {
        if (s.memory.tags.includes(topTag)) {
          s.score += GROUP_BOOST;
          s.breakdown = { ...s.breakdown, group: GROUP_BOOST };
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);
    // Abstention: below minScore is noise, not evidence — return nothing rather than weakly-related memories.
    const aboveMinScore =
      req.minScore !== undefined ? scored.filter((s) => s.score >= req.minScore!) : scored;
    const topScored = aboveMinScore.slice(0, req.limit);
    let top = topScored.map(({ memory: m, score, breakdown }) => toRetrieved(m, score, breakdown, req, now));

    // 1-hop expansion: a hit on a chapter should bring its book along.
    // Structural rels only — following supersedes would resurface retired facts.
    // ponytail: single hop at 0.5x score into leftover limit slots; spreading
    // activation with depth/decay if graph recall ever proves insufficient.
    const EXPAND_RELS = new Set(["part_of", "related_to"]);
    if (top.length > 0 && top.length < req.limit) {
      const seen = new Set(top.map((t) => t.id));
      const extras: RetrievedMemory[] = [];
      for (const { memory: m, score } of topScored) {
        for (const l of m.links) {
          if (!EXPAND_RELS.has(l.rel) || seen.has(l.targetId)) continue;
          const neighbor = this.repo.get(l.targetId);
          if (!neighbor || neighbor.status !== "active") continue;
          seen.add(neighbor.id);
          const linkScore = score * 0.5;
          extras.push(toRetrieved(neighbor, linkScore, { link: linkScore }, req, now));
        }
      }
      extras.sort((a, b) => b.score - a.score);
      top = [...top, ...extras.slice(0, req.limit - top.length)];
    }
    if (req.rerank && this.llm && top.length > 1) {
      top = await rerankWithLlm(this.llm, req.query, top);
    }
    if (req.tokenBudget) top = packByTokenBudget(top, req.tokenBudget);
    this.repo.touchAccessed(top.map((m) => m.id));
    this.repo.addAudit("retrieve", JSON.stringify({
      query: req.query,
      returnedIds: top.map((m) => m.id),
      candidateCount: candidates.length,
      eligibleCount: eligible.length,
      // Tripwire for B′ union candidacy: how many eligible memories this query
      // never scored. If real recall misses show up, this tells us first.
      unionDropped: eligible.length - candidates.length,
      ...(keywordRanks === null ? { ftsFallback: true } : {}),
      latencyMs: Math.round(performance.now() - start),
      // Filters explain 0-candidate results; without them the log is unreadable.
      ...(req.types ? { types: req.types } : {}),
      ...(req.tags ? { tags: req.tags } : {}),
      ...(req.since ? { since: req.since } : {}),
      ...(req.until ? { until: req.until } : {}),
      ...(req.minScore !== undefined ? { minScore: req.minScore } : {}),
      ...(req.rerank ? { rerank: true } : {}),
    }));
    return {
      memories: top,
      stats: { candidateCount: candidates.length, latencyMs: Math.round(performance.now() - start) },
    };
  }
}

/** LLM rerank of the final hit list, 1-based index reply ("3,1,2"). Any parse
 *  failure, partial ranking, or LLM error falls back to hybrid order — rerank
 *  must never break or truncate retrieval. */
async function rerankWithLlm(
  llm: LlmClient,
  query: string,
  items: RetrievedMemory[],
): Promise<RetrievedMemory[]> {
  try {
    const list = items.map((m, i) => `${i + 1}. ${m.content}`).join("\n");
    const raw = await llm.complete(
      "You rerank memory search results. Reply with only the item numbers, most relevant to the query first, comma-separated. Example: 3,1,2",
      `Query: ${query}\n\nResults:\n${list}`,
    );
    const idx = [...new Set((raw.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 1 && n <= items.length))];
    if (idx.length !== items.length) return items;
    return idx.map((n) => items[n - 1]!);
  } catch {
    return items;
  }
}

/** Legacy substring keyword score — fallback only, used when the FTS index is unavailable. */
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
    // Without the timestamp the consuming LLM cannot answer "when did I tell
    // you X" — it sees facts but not their age.
    createdAt: m.createdAt,
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
