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
  { key: "mem_proc_email", type: "procedural", content: "Draft emails in a formal tone unless told otherwise", tags: ["style"] },
  { key: "mem_proc_units", type: "procedural", content: "Use metric units in all answers", tags: ["style"] },
  { key: "mem_sem_dog", type: "semantic", content: "User has a golden retriever named Biscuit", tags: ["personal"] },
  { key: "mem_sem_old_dog_name", type: "semantic", content: "User has a dog named Rex", tags: ["personal"], superseded: true },
  { key: "mem_sem_vegan", type: "semantic", content: "User eats a vegan diet", tags: ["personal"] },
  { key: "mem_sem_old_diet", type: "semantic", content: "User eats a keto diet", tags: ["personal"], superseded: true },
  { key: "mem_ep_conference", type: "episodic", content: "User attended a TypeScript conference in June", tags: ["work"] },
  { key: "mem_ep_april_trip", type: "episodic", content: "In April the user traveled to Montreal for a wedding", tags: ["personal"] },
  { key: "mem_ep_noise_movie", type: "episodic", content: "User watched a three hour movie and described the whole plot in detail", tags: ["personal"] },
  { key: "mem_sem_editor", type: "semantic", content: "User's main editor is VS Code", tags: ["work"] },
  { key: "mem_sem_old_editor", type: "semantic", content: "User's main editor is Vim", tags: ["work"], superseded: true },
  { key: "mem_proc_no_emoji", type: "procedural", content: "Never use emoji in written answers", tags: ["style"] },
  { key: "mem_sem_timezone", type: "semantic", content: "User is in the Pacific time zone", tags: ["personal"] },
  { key: "mem_ep_deploy_friday", type: "episodic", content: "User's team had an incident after a Friday deploy in May", tags: ["work"] },
  { key: "mem_sem_bike", type: "semantic", content: "User commutes by bicycle", tags: ["personal"] },
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
