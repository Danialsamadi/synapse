import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateMemoryInputSchema,
  RetrieveRequestSchema,
  UpdateMemoryInputSchema,
  MemoryTypeSchema,
  resolveDbPath,
} from "@synapse/core";
import { MemoryRepository, RetrievalService, consolidate, createEmbedder, createLlm, runDecay, writeMemory } from "@synapse/store";
import type { JobRow } from "@synapse/store";

export async function createServer(repo?: MemoryRepository, opts?: { port?: number; hostname?: string }) {
  const repository = repo ?? new MemoryRepository({ path: resolveDbPath() });
  const embedder = createEmbedder();
  const retrieval = new RetrievalService(repository, embedder);
  const llm = createLlm();
  const app = new Hono();

  // Never leak internals: validation failures → 400, everything else → generic 500.
  app.onError((err, c) => {
    if (err instanceof z.ZodError) {
      return c.json({ error: "invalid_input", issues: err.issues }, 400);
    }
    if (err instanceof SyntaxError) {
      return c.json({ error: "invalid_json" }, 400);
    }
    console.error(JSON.stringify({ evt: "error", path: c.req.path, message: String(err) }));
    return c.json({ error: "internal_error" }, 500);
  });

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

  const token = process.env.SYNAPSE_TOKEN;
  if (token) {
    const expected = Buffer.from(`Bearer ${token}`);
    app.use("/v1/*", async (c, next) => {
      const got = Buffer.from(c.req.header("Authorization") ?? "");
      // Length check first: timingSafeEqual throws on unequal lengths.
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      await next();
    });
  }

  app.get("/health", (c) => c.json({ ok: true, service: "synapse-api" }));

  app.post("/v1/memories", async (c) => {
    const json: unknown = await c.req.json();
    const inputs = Array.isArray(json)
      ? json.map((j) => CreateMemoryInputSchema.parse(j))
      : [CreateMemoryInputSchema.parse(json)];
    const results = await Promise.all(inputs.map(async (input) => {
      const { memory, deduped } = await writeMemory(repository, embedder, input);
      return { deduped, memory };
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
    const raw = Number(c.req.query("limit") ?? "100");
    const limit = Number.isFinite(raw) ? Math.min(Math.max(1, Math.trunc(raw)), 500) : 100;
    const action = c.req.query("action");
    const events = repository.listAudit(action, limit).map((e) => ({
      ...e,
      detail: (() => { try { return JSON.parse(e.detail); } catch { return e.detail; } })(),
    }));
    return c.json({ events });
  });

  app.get("/v1/analytics", (c) => {
    const rawDays = Number(c.req.query("days") ?? "14");
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(1, Math.trunc(rawDays)), 90) : 14;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const events = repository.listAudit(undefined, 10_000).filter((e) => e.createdAt >= cutoff);
    const parse = (s: string) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } };

    const dayOf = (iso: string) => iso.slice(0, 10);
    const daysList: string[] = [];
    for (let i = days - 1; i >= 0; i--) daysList.push(dayOf(new Date(Date.now() - i * 86_400_000).toISOString()));
    const zero = () => Object.fromEntries(daysList.map((d) => [d, 0])) as Record<string, number>;
    const perDay = { write: zero(), retrieve: zero(), supersede: zero(), conflict: zero() };

    let latencySum = 0, candidateSum = 0, retrieves = 0, empty = 0, writes = 0, dedups = 0;
    const hits = new Map<string, number>();
    for (const e of events) {
      const d = parse(e.detail);
      const day = dayOf(e.createdAt);
      if (e.action in perDay && day in perDay.write) perDay[e.action as keyof typeof perDay][day]!++;
      // Conflict resolutions are supersede events tagged via:"conflict".
      if (e.action === "supersede" && d.via === "conflict" && day in perDay.conflict) perDay.conflict[day]!++;
      if (e.action === "retrieve") {
        retrieves++;
        latencySum += Number(d.latencyMs ?? 0);
        candidateSum += Number(d.candidateCount ?? 0);
        const ids = Array.isArray(d.returnedIds) ? (d.returnedIds as string[]) : [];
        if (ids.length === 0) empty++;
        for (const id of ids) hits.set(id, (hits.get(id) ?? 0) + 1);
      }
      if (e.action === "write") writes++;
      if (e.action === "dedup" || e.action === "absorb") dedups++;
    }

    const active = repository.list("local", { status: "active" });
    const hot = [...hits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, count]) => {
        const m = repository.get(id);
        return { id, count, type: m?.type ?? "?", preview: m?.content.slice(0, 80) ?? "(deleted)" };
      });
    const coldCount = active.filter((m) => !hits.has(m.id)).length;

    return c.json({
      days,
      auditWindowNote: "Derived from the audit log; pruned events fall outside the window.",
      activity: daysList.map((d) => ({ date: d, writes: perDay.write[d], retrieves: perDay.retrieve[d] })),
      lifecycle: daysList.map((d) => ({ date: d, supersedes: perDay.supersede[d], conflicts: perDay.conflict[d] })),
      retrieval: {
        total: retrieves,
        avgLatencyMs: retrieves ? Math.round(latencySum / retrieves) : 0,
        avgCandidates: retrieves ? Math.round(candidateSum / retrieves) : 0,
        emptyRate: retrieves ? empty / retrieves : 0,
        dedupRate: writes + dedups ? dedups / (writes + dedups) : 0,
      },
      hot,
      cold: { neverRetrieved: coldCount, active: active.length },
    });
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
    return c.json({ countsByTypeStatus, embeddingCoverage: { withVector: embeddings.size, total: all.length }, quarantineCount: quarantine.length, lastJobs, embedder: embedder.model });
  });

  app.get("/v1/digest", (c) => {
    const maxItems = Number(c.req.query("maxItems") ?? "12");
    return c.json(retrieval.digest("local", maxItems));
  });

  const port = opts?.port ?? Number(process.env.PORT ?? 8787);
  // Default to loopback so export/purge aren't exposed to the LAN. Opt into
  // wider exposure with SYNAPSE_HOST=0.0.0.0 (and set SYNAPSE_TOKEN when you do).
  const hostname = opts?.hostname ?? process.env.SYNAPSE_HOST ?? "127.0.0.1";
  if (!token && hostname !== "127.0.0.1" && hostname !== "localhost") {
    console.warn(
      "WARNING: synapse-api is bound to a non-loopback address with no SYNAPSE_TOKEN set — " +
        "/v1/export and /v1/purge are reachable unauthenticated. Set SYNAPSE_TOKEN.",
    );
  }
  const server = await new Promise<ReturnType<typeof serve>>((res) => {
    const s = serve({ fetch: app.fetch, port, hostname }, () => res(s));
  });
  return server;
}

// Default startup behavior
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  // Real semantic embeddings by default when run as a server; tests that
  // import createServer() directly keep the fast hash provider.
  process.env.SYNAPSE_EMBED_PROVIDER ??= "local";
  createServer().then((server) => {
    const port = Number(process.env.PORT ?? 8787);
    console.log(`synapse-api listening on http://localhost:${port}`);
  });
}
