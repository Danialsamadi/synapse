import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateMemoryInputSchema,
  RetrieveRequestSchema,
  UpdateMemoryInputSchema,
  MemoryTypeSchema,
} from "@mneme/core";
import { MemoryRepository, RetrievalService, consolidate, createEmbedder, createLlm, runDecay } from "@mneme/store";
import type { JobRow } from "@mneme/store";

export async function createServer(repo?: MemoryRepository, opts?: { port?: number }) {
  const repository = repo ?? (() => {
    const path = process.env.MNEME_DB ?? resolve(process.cwd(), ".mneme", "mneme.db");
    mkdirSync(dirname(path), { recursive: true });
    return new MemoryRepository({ path });
  })();
  const embedder = createEmbedder();
  const retrieval = new RetrievalService(repository, embedder);
  const llm = createLlm();
  const app = new Hono();

  const inspectorHtml = readFileSync(
    fileURLToPath(new URL("./inspector.html", import.meta.url)),
    "utf8",
  );
  app.get("/inspector", (c) => c.html(inspectorHtml));

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    console.log(
      JSON.stringify({
        evt: "http",
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      }),
    );
  });

  const token = process.env.MNEME_TOKEN;
  if (token) {
    app.use("/v1/*", async (c, next) => {
      if (c.req.header("Authorization") !== `Bearer ${token}`) {
        return c.json({ error: "unauthorized" }, 401);
      }
      await next();
    });
  }

  app.get("/health", (c) => c.json({ ok: true, service: "mneme-api" }));

  app.post("/v1/memories", async (c) => {
    const json: unknown = await c.req.json();
    const inputs = Array.isArray(json)
      ? json.map((j) => CreateMemoryInputSchema.parse(j))
      : [CreateMemoryInputSchema.parse(json)];
    const results = await Promise.all(inputs.map(async (input) => {
      const { memory, deduped } = repository.createWithEntitySupersede(input);
      if (deduped) return { deduped: true as const, memory };
      const [vec] = await embedder.embed([memory.content]);
      if (vec) repository.saveEmbedding(memory.id, vec, embedder.model);
      return { deduped: false as const, memory };
    }));
    if (!Array.isArray(json)) {
      const first = results[0]!;
      return first.deduped ? c.json({ deduped: true, ...first.memory }) : c.json(first.memory, 201);
    }
    return c.json({ results }, 201);
  });

  app.get("/v1/memories/:id", (c) => {
    const memory = repository.get(c.req.param("id"));
    if (!memory) return c.json({ error: "not_found" }, 404);
    const rawLinks = repository.getLinks(memory.id);
    const resolvedLinks = rawLinks.map((l) => {
      const isOutgoing = l.fromId === memory.id;
      const targetId = isOutgoing ? l.toId : l.fromId;
      const target = repository.get(targetId);
      return {
        rel: l.rel,
        direction: isOutgoing ? "outgoing" : "incoming",
        targetId,
        targetPreview: target ? (target.content.length > 80 ? target.content.slice(0, 77) + "…" : target.content) : "(deleted)",
        targetStatus: target?.status ?? "deleted",
      };
    });
    const events = repository.listAudit(undefined, 50)
      .filter((e) => {
        try { const d = JSON.parse(e.detail); return d.id === memory.id || d.winnerId === memory.id || d.loserId === memory.id; }
        catch { return false; }
      });
    return c.json({ ...memory, resolvedLinks, events });
  });

  app.patch("/v1/memories/:id", async (c) => {
    const json: unknown = await c.req.json();
    const patch = UpdateMemoryInputSchema.parse(json);
    const updated = repository.update(c.req.param("id"), patch);
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json(updated);
  });

  app.delete("/v1/memories/:id", (c) => {
    const ok = repository.softDelete(c.req.param("id"));
    return c.json({ ok });
  });

  app.get("/v1/memories", (c) => {
    const userId = c.req.query("userId") ?? "local";
    const rows = repository.list(userId, { status: "active" });
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
    decay: (r) => Promise.resolve(runDecay(r)),
    purge: (r) => Promise.resolve(r.purgeDeleted()),
  };

  app.post("/v1/jobs/:kind", async (c) => {
    const kind = c.req.param("kind");
    const handler = jobHandlers[kind];
    if (!handler) return c.json({ error: "unknown_job" }, 404);
    const job = repository.createJob(kind);
    repository.updateJob(job.id, "running");
    try {
      repository.updateJob(job.id, "done", await handler(repository));
    } catch (err) {
      repository.updateJob(job.id, "failed", { error: String(err) });
    }
    return c.json(repository.getJob(job.id), 201);
  });

  app.get("/v1/jobs/:id", (c) => {
    const job = repository.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "not_found" }, 404);
    return c.json(job);
  });

  app.get("/v1/conflicts", (c) => {
    const userId = c.req.query("userId") ?? "local";
    const disputed = repository.list(userId, { status: "disputed" });
    return c.json({
      conflicts: disputed.map((m) => ({
        memory: m,
        contradicts: m.links.filter((l) => l.rel === "contradicts").map((l) => l.targetId),
      })),
    });
  });

  app.post("/v1/conflicts/resolve", async (c) => {
    const body = z.object({ winnerId: z.string(), loserId: z.string() }).parse(await c.req.json());
    const winner = repository.update(body.winnerId, { status: "active" });
    const loser = repository.update(body.loserId, { status: "superseded" });
    if (!winner || !loser) return c.json({ error: "not_found" }, 404);
    repository.addLink(winner.id, loser.id, "supersedes");
    return c.json({ winner, loser });
  });

  app.get("/v1/about-me", (c) => {
    const userId = c.req.query("userId") ?? "local";
    const semantic = repository.list(userId, { status: "active", type: "semantic" });
    const procedural = repository.list(userId, { status: "active", type: "procedural" });
    const disputedCount = repository.list(userId, { status: "disputed" }).length;
    return c.json({ semantic, procedural, disputedCount });
  });

  app.get("/v1/export", (c) => {
    const userId = c.req.query("userId") ?? "local";
    const dump = repository.exportAll(userId);
    repository.addAudit("export", `userId=${userId} count=${dump.memories.length}`);
    return c.json(dump);
  });

  app.post("/v1/purge", async (c) => {
    const body = z
      .object({
        userId: z.string().default("local"),
        tags: z.array(z.string()).optional(),
        types: z.array(MemoryTypeSchema).optional(),
        before: z.string().optional(),
      })
      .parse(await c.req.json());
    const softDeleted =
      body.tags || body.types || body.before
        ? repository.softDeleteWhere(body.userId, { ...(body.tags ? { tags: body.tags } : {}), ...(body.types ? { types: body.types } : {}), ...(body.before ? { before: body.before } : {}) })
        : 0;
    const { purged } = repository.purgeDeleted();
    repository.addAudit("purge", `softDeleted=${softDeleted} purged=${purged}`);
    return c.json({ softDeleted, purged });
  });

  // --- New inspector endpoints ---

  app.get("/v1/activity", (c) => {
    const limit = Number(c.req.query("limit") ?? "100");
    const action = c.req.query("action");
    const events = repository.listAudit(action, limit).map((e) => ({
      ...e,
      detail: (() => { try { return JSON.parse(e.detail); } catch { return e.detail; } })(),
    }));
    return c.json({ events });
  });

  app.get("/v1/stats", (c) => {
    const all = repository.list("local");
    const countsByTypeStatus: Record<string, number> = {};
    for (const m of all) {
      const key = `${m.type}:${m.status}`;
      countsByTypeStatus[key] = (countsByTypeStatus[key] ?? 0) + 1;
    }
    const ids = all.map((m) => m.id);
    const embeddings = repository.getEmbeddings(ids);
    const quarantine = repository.listQuarantine();
    const jobKinds = ["consolidate", "decay", "purge"];
    const lastJobs: Record<string, { updatedAt: string; result: unknown }> = {};
    for (const kind of jobKinds) {
      const j = repository.lastDoneJob(kind);
      if (j) lastJobs[kind] = { updatedAt: j.updatedAt, result: j.result ? JSON.parse(j.result) : null };
    }
    return c.json({ countsByTypeStatus, embeddingCoverage: { withVector: embeddings.size, total: all.length }, quarantineCount: quarantine.length, lastJobs });
  });

  app.get("/v1/digest", (c) => {
    const maxItems = Number(c.req.query("maxItems") ?? "12");
    return c.json(retrieval.digest("local", maxItems));
  });

  const port = opts?.port ?? Number(process.env.PORT ?? 8787);
  const server = serve({ fetch: app.fetch, port });
  return server;
}

// Default startup behavior
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  createServer().then((server) => {
    const port = Number(process.env.PORT ?? 8787);
    console.log(`mneme-api listening on http://localhost:${port}`);
  });
}
