import type { Memory, MemoryType } from "./types.js";

export interface RankWeights {
  vector: number;
  keyword: number;
  importance: number;
  recency: number;
  decay: number;
  conflict: number;
}

/** Documented defaults — publish in README when hybrid retrieve ships. */
export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  vector: 0.4,
  keyword: 0.2,
  importance: 0.15,
  recency: 0.1,
  decay: 0.1,
  conflict: 0.05,
};

/**
 * Exponential decay penalty in [0, 1]: higher = more forgotten.
 * score contribution is typically `-weight * decayPenalty`.
 */
export function decayPenalty(
  ageDays: number,
  halfLifeDays: number,
  retentionMode: Memory["retention"]["mode"],
): number {
  if (retentionMode === "pinned") return 0;
  if (halfLifeDays <= 0) return 1;
  // 1 - 0.5^(age/halfLife) → approaches 1 as memory ages
  return 1 - Math.pow(0.5, ageDays / halfLifeDays);
}

export function ageDays(fromIso: string, now = new Date()): number {
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now.getTime() - t) / (1000 * 60 * 60 * 24));
}

export function recencyBoost(
  createdAt: string,
  lastAccessedAt: string | undefined,
  now = new Date(),
): number {
  const ref = lastAccessedAt ?? createdAt;
  const days = ageDays(ref, now);
  // Fresh access → ~1; fades toward 0
  return Math.pow(0.5, days / 14);
}

export interface ScoreInputs {
  vectorSim: number;
  keywordScore: number;
  importance: number;
  recency: number;
  decay: number;
  conflictPenalty: number;
  weights?: RankWeights;
}

export function hybridScore(input: ScoreInputs): {
  score: number;
  breakdown: Required<
    Pick<
      Record<string, number>,
      "vector" | "keyword" | "importance" | "recency" | "decay" | "conflict"
    >
  >;
} {
  const w = input.weights ?? DEFAULT_RANK_WEIGHTS;
  const breakdown = {
    vector: w.vector * clamp01(input.vectorSim),
    keyword: w.keyword * clamp01(input.keywordScore),
    importance: w.importance * clamp01(input.importance),
    recency: w.recency * clamp01(input.recency),
    decay: -(w.decay * clamp01(input.decay)),
    conflict: -(w.conflict * clamp01(input.conflictPenalty)),
  };
  const score =
    breakdown.vector +
    breakdown.keyword +
    breakdown.importance +
    breakdown.recency +
    breakdown.decay +
    breakdown.conflict;
  return { score, breakdown };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Rough token estimate for budget packing (MVP: chars/4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function packByTokenBudget<T extends { content: string }>(
  items: T[],
  tokenBudget: number,
): T[] {
  const out: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(item.content);
    if (used + cost > tokenBudget) break;
    out.push(item);
    used += cost;
  }
  return out;
}

export function defaultHalfLife(type: MemoryType): number {
  const map: Record<MemoryType, number> = {
    episodic: 30,
    semantic: 180,
    procedural: 365,
    working: 0.5,
  };
  return map[type];
}
