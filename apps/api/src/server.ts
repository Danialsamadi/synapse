import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CreateMemoryInputSchema,
  RetrieveRequestSchema,
  UpdateMemoryInputSchema,
} from "@mneme/core";
import { MemoryRepository, RetrievalService, consolidate, OpenAiCompatLlm } from "@mneme/store";
import type { JobRow } from "@mneme/store";
import { HashEmbeddingProvider } from "@mneme/embeddings";

function openRepo(): MemoryRepository {
  const path =
    process.env.MNEME_DB ?? resolve(process.cwd(), ".mneme", "mneme.db");
  mkdirSync(dirname(path), { recursive: true });
  return new MemoryRepository({ path });
}

const repo = openRepo();
const embedder = new HashEmbeddingProvider();
const retrieval = new RetrievalService(repo, embedder);
const llm = new OpenAiCompatLlm();
const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "mneme-api" }));

app.post("/v1/memories", async (c) => {
  const json: unknown = await c.req.json();
  const inputs = Array.isArray(json)
    ? json.map((j) => CreateMemoryInputSchema.parse(j))
    : [CreateMemoryInputSchema.parse(json)];
  const results = await Promise.all(inputs.map(async (input) => {
    const existing = repo.findActiveByContentHash(input.userId, input.type, input.content);
    if (existing) return { deduped: true as const, memory: existing };
    const memory = repo.create(input);
    const [vec] = await embedder.embed([memory.content]);
    if (vec) repo.saveEmbedding(memory.id, vec, embedder.model);
    return { deduped: false as const, memory };
  }));
  if (!Array.isArray(json)) {
    const first = results[0]!;
    return first.deduped ? c.json({ deduped: true, ...first.memory }) : c.json(first.memory, 201);
  }
  return c.json({ results }, 201);
});

app.get("/v1/memories/:id", (c) => {
  const memory = repo.get(c.req.param("id"));
  if (!memory) return c.json({ error: "not_found" }, 404);
  return c.json(memory);
});

app.patch("/v1/memories/:id", async (c) => {
  const json: unknown = await c.req.json();
  const patch = UpdateMemoryInputSchema.parse(json);
  const updated = repo.update(c.req.param("id"), patch);
  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.json(updated);
});

app.delete("/v1/memories/:id", (c) => {
  const ok = repo.softDelete(c.req.param("id"));
  return c.json({ ok });
});

app.get("/v1/memories", (c) => {
  const userId = c.req.query("userId") ?? "local";
  const rows = repo.list(userId, { status: "active" });
  return c.json({ memories: rows });
});

app.post("/v1/memories/retrieve", async (c) => {
  const json: unknown = await c.req.json();
  const req = RetrieveRequestSchema.parse(json);
  const result = await retrieval.retrieve(req);
  return c.json(result);
});

const jobHandlers: Record<string, (repo: MemoryRepository) => Promise<unknown>> = {
  consolidate: (r) => consolidate(r, embedder, llm),
};

app.post("/v1/jobs/:kind", async (c) => {
  const kind = c.req.param("kind");
  const handler = jobHandlers[kind];
  if (!handler) return c.json({ error: "unknown_job" }, 404);
  const job = repo.createJob(kind);
  repo.updateJob(job.id, "running");
  try {
    repo.updateJob(job.id, "done", await handler(repo));
  } catch (err) {
    repo.updateJob(job.id, "failed", { error: String(err) });
  }
  return c.json(repo.getJob(job.id), 201);
});

app.get("/v1/jobs/:id", (c) => {
  const job = repo.getJob(c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);
  return c.json(job);
});

app.get("/v1/conflicts", (c) => {
  const userId = c.req.query("userId") ?? "local";
  const disputed = repo.list(userId, { status: "disputed" });
  return c.json({
    conflicts: disputed.map((m) => ({
      memory: m,
      contradicts: m.links.filter((l) => l.rel === "contradicts").map((l) => l.targetId),
    })),
  });
});

app.post("/v1/conflicts/resolve", async (c) => {
  const body = z.object({ winnerId: z.string(), loserId: z.string() }).parse(await c.req.json());
  const winner = repo.update(body.winnerId, { status: "active" });
  const loser = repo.update(body.loserId, { status: "superseded" });
  if (!winner || !loser) return c.json({ error: "not_found" }, 404);
  repo.addLink(winner.id, loser.id, "supersedes");
  return c.json({ winner, loser });
});

const port = Number(process.env.PORT ?? 8787);
console.log(`mneme-api listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
