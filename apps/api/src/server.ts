import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CreateMemoryInputSchema,
  RetrieveRequestSchema,
  UpdateMemoryInputSchema,
} from "@mneme/core";
import { MemoryRepository, RetrievalService } from "@mneme/store";
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

const port = Number(process.env.PORT ?? 8787);
console.log(`mneme-api listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
