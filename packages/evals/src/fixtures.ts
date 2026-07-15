import type { EmbeddingProvider } from "@mneme/embeddings";
import type { MemoryRepository } from "@mneme/store";
import type { MemoryType } from "@mneme/core";

export interface Fixture {
  key: string;
  type: MemoryType;
  content: string;
  tags?: string[];
  superseded?: boolean;
}

export const FIXTURES: Fixture[] = [
  { key: "mem_proc_bullets", type: "procedural", content: "Prefer concise bullet answers with tradeoffs included", tags: ["style"] },
  { key: "mem_sem_toronto", type: "semantic", content: "User lives in Toronto", tags: ["location"], superseded: true },
  { key: "mem_sem_vancouver", type: "semantic", content: "User lives in Vancouver", tags: ["location"] },
  { key: "mem_ep_move", type: "episodic", content: "User said they moved from Toronto to Vancouver last month", tags: ["location"] },
  { key: "mem_ep_march_plan", type: "episodic", content: "In March the user was planning the Mneme memory OS PRD", tags: ["work"] },
  { key: "mem_sem_typescript", type: "semantic", content: "User prefers TypeScript as their main programming language", tags: ["work"] },
  { key: "mem_ep_lunch_order", type: "episodic", content: "User ordered a tuna sandwich and talked about the weather for a long time", tags: ["personal"] },
  { key: "mem_proc_cite", type: "procedural", content: "Always cite sources when giving factual claims", tags: ["style"] },
  { key: "mem_sem_job", type: "semantic", content: "User works as a TypeScript engineer at a startup", tags: ["work"] },
  { key: "mem_sem_old_job", type: "semantic", content: "User works as a barista", tags: ["work"], superseded: true },
  { key: "mem_ep_interview", type: "episodic", content: "User has an interview at xAI next week", tags: ["work"] },
  { key: "mem_sem_coffee", type: "semantic", content: "User drinks espresso every morning", tags: ["personal"] },
  { key: "mem_ep_gym", type: "episodic", content: "User started going to the gym on Mondays and Thursdays", tags: ["personal"] },
];

export async function seedFixtures(
  repo: MemoryRepository,
  embedder: EmbeddingProvider,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const f of FIXTURES) {
    const m = repo.create({ userId: "local", type: f.type, content: f.content, tags: f.tags ?? [] });
    const [v] = await embedder.embed([m.content]);
    if (v) repo.saveEmbedding(m.id, v, embedder.model);
    if (f.superseded) repo.update(m.id, { status: "superseded" });
    ids.set(f.key, m.id);
  }
  return ids;
}
