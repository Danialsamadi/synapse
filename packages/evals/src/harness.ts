import { HashEmbeddingProvider } from "@mneme/embeddings";
import { MemoryRepository, RetrievalService } from "@mneme/store";
import { GOLDEN_CASES, type EvalCase } from "./cases.js";
import { seedFixtures } from "./fixtures.js";

export interface EvalResult {
  caseId: string;
  family: EvalCase["family"];
  pass: boolean;
  precisionAtK: number;
  staleHit: boolean;
}
export interface EvalSummary {
  results: EvalResult[];
  precisionAtK: number;
  staleFactRate: number;
  passRate: number;
}

export async function runEvals(k = 5): Promise<EvalSummary> {
  const repo = new MemoryRepository({ path: ":memory:" });
  const embedder = new HashEmbeddingProvider();
  const svc = new RetrievalService(repo, embedder);
  const ids = await seedFixtures(repo, embedder);

  const results: EvalResult[] = [];
  for (const c of GOLDEN_CASES) {
    const res = await svc.retrieve({
      query: c.query,
      userId: "local",
      limit: k,
      ...(c.tags ? { tags: c.tags } : {}),
      ...(c.types ? { types: c.types } : {}),
    });
    const gotIds = res.memories.map((m) => m.id);
    const relevant = c.relevantIds.map((key) => ids.get(key)).filter((x): x is string => !!x);
    const forbidden = (c.forbiddenIds ?? []).map((key) => ids.get(key)).filter((x): x is string => !!x);
    const hits = relevant.filter((id) => gotIds.includes(id)).length;
    const staleHit = forbidden.some((id) => gotIds.includes(id));
    const precisionAtK = relevant.length === 0 ? 1 : hits / relevant.length;
    results.push({
      caseId: c.id,
      family: c.family,
      pass: hits === relevant.length && !staleHit,
      precisionAtK,
      staleHit,
    });
  }
  repo.close();

  const staleCases = results.filter((r) => GOLDEN_CASES.find((c) => c.id === r.caseId)?.forbiddenIds?.length);
  return {
    results,
    precisionAtK: avg(results.map((r) => r.precisionAtK)),
    staleFactRate: staleCases.length === 0 ? 0 : staleCases.filter((r) => r.staleHit).length / staleCases.length,
    passRate: results.filter((r) => r.pass).length / results.length,
  };
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}
