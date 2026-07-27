import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { MemoryRepository } from "@synapse/store";
import { createServer } from "./server.js";

let repo: MemoryRepository;
let baseUrl: string;
let server: ReturnType<typeof serve>;

// We need to import serve to get the return type
import { serve } from "@hono/node-server";

before(async () => {
  repo = new MemoryRepository({ path: ":memory:" });
  const port = 0;
  server = await createServer(repo, { port });
  // Get the actual port from the server
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr !== null && typeof addr === "object" ? addr.port : port}`;
});

after(() => {
  server.close();
  repo.close();
});

describe("GET /v1/activity", () => {
  it("returns audit events newest-first with optional action filter", async () => {
    repo.addAudit("write", JSON.stringify({ id: "m1", type: "semantic", contentPreview: "a", source: "mcp" }));
    repo.addAudit("retrieve", JSON.stringify({ query: "q", returnedIds: [], candidateCount: 0, latencyMs: 1 }));
    const all = await fetch(`${baseUrl}/v1/activity?limit=10`);
    const body = await all.json() as { events: Array<{ id: number; action: string }> };
    assert.ok(body.events.length >= 2);
    assert.ok(body.events[0]!.id >= body.events[1]!.id);
    const filtered = await fetch(`${baseUrl}/v1/activity?action=write`);
    const fBody = await filtered.json() as { events: Array<{ action: string }> };
    assert.ok(fBody.events.every((e) => e.action === "write"));
  });
});

describe("GET /v1/stats", () => {
  it("returns counts, embedding coverage, quarantine, job info", async () => {
    repo.create({ userId: "local", type: "semantic", content: "fact" });
    const res = await fetch(`${baseUrl}/v1/stats`);
    const body = await res.json() as { countsByTypeStatus: Record<string, number>; embeddingCoverage: { withVector: number; total: number }; quarantineCount: number };
    assert.ok(body.countsByTypeStatus);
    assert.ok(typeof body.embeddingCoverage.withVector === "number");
    assert.equal(body.quarantineCount, 0);
  });
});

describe("GET /v1/digest", () => {
  it("returns digest text and items", async () => {
    repo.create({ userId: "local", type: "semantic", content: "important fact", retention: { mode: "pinned", pinReason: "test" } });
    const res = await fetch(`${baseUrl}/v1/digest`);
    const body = await res.json() as { text: string; items: Array<{ content: string }> };
    assert.match(body.text, /important fact/);
    assert.ok(body.items.length >= 1);
  });
});

describe("GET /v1/memories/:id (extended)", () => {
  it("returns resolved links and audit events", async () => {
    const m = repo.create({ userId: "local", type: "semantic", content: "linked fact" });
    const other = repo.create({ userId: "local", type: "semantic", content: "other fact" });
    repo.addLink(m.id, other.id, "supports");
    const res = await fetch(`${baseUrl}/v1/memories/${m.id}`);
    const body = await res.json() as { resolvedLinks: Array<{ rel: string; targetPreview: string }>; events: Array<{ action: string }> };
    assert.ok(body.resolvedLinks.length >= 1);
    assert.equal(body.resolvedLinks[0]!.rel, "supports");
    assert.ok(typeof body.resolvedLinks[0]!.targetPreview === "string");
    assert.ok(Array.isArray(body.events));
  });
});

describe("error handling", () => {
  it("invalid body → 400 invalid_input, not 500", async () => {
    const res = await fetch(`${baseUrl}/v1/memories`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "bogus", content: "" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "invalid_input");
  });

  it("malformed JSON → 400 invalid_json", async () => {
    const res = await fetch(`${baseUrl}/v1/memories`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });
});

describe("GET /v1/activity limit clamping", () => {
  it("non-numeric limit does not return the whole table unbounded", async () => {
    const res = await fetch(`${baseUrl}/v1/activity?limit=abc`);
    assert.equal(res.status, 200);
    const body = await res.json() as { events: unknown[] };
    assert.ok(body.events.length <= 500);
  });
});

describe("token auth", () => {
  it("rejects wrong token and accepts the right one (constant-time)", async () => {
    const authedRepo = new MemoryRepository({ path: ":memory:" });
    process.env.SYNAPSE_TOKEN = "s3cret-token";
    const authed = await createServer(authedRepo, { port: 0 });
    const addr = authed.address();
    const url = `http://127.0.0.1:${addr !== null && typeof addr === "object" ? addr.port : 0}`;
    try {
      const noAuth = await fetch(`${url}/v1/memories`);
      assert.equal(noAuth.status, 401);
      const wrong = await fetch(`${url}/v1/memories`, { headers: { Authorization: "Bearer nope" } });
      assert.equal(wrong.status, 401);
      const ok = await fetch(`${url}/v1/memories`, { headers: { Authorization: "Bearer s3cret-token" } });
      assert.equal(ok.status, 200);
    } finally {
      authed.close();
      authedRepo.close();
      delete process.env.SYNAPSE_TOKEN;
    }
  });
});

describe("GET /v1/analytics", () => {
  it("returns activity, retrieval quality, hot and cold from audit events", async () => {
    const w = await fetch(`${baseUrl}/v1/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "local", type: "semantic", content: "analytics seed fact" }),
    });
    assert.equal(w.status, 201);
    const r = await fetch(`${baseUrl}/v1/memories/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "analytics seed", userId: "local" }),
    });
    assert.equal(r.status, 200);

    const res = await fetch(`${baseUrl}/v1/analytics?days=7`);
    assert.equal(res.status, 200);
    const a = await res.json() as any;
    assert.equal(a.days, 7);
    assert.equal(a.activity.length, 7);
    const today = a.activity[a.activity.length - 1];
    assert.ok(today.writes >= 1);
    assert.ok(today.retrieves >= 1);
    assert.ok(a.retrieval.total >= 1);
    assert.ok(a.hot.length >= 1);
    assert.ok(a.hot[0].preview.length > 0);
    assert.ok(a.cold.active >= 1);
  });
});

describe("GET /v1/analytics avgCandidates continuity", () => {
  it("prefers eligibleCount, falls back to candidateCount for pre-FTS5 audit rows", async () => {
    // Own repo/server: the shared one accumulates retrieve events from other tests.
    const isoRepo = new MemoryRepository({ path: ":memory:" });
    const isoServer = await createServer(isoRepo, { port: 0 });
    const addr = isoServer.address();
    const isoUrl = `http://127.0.0.1:${addr !== null && typeof addr === "object" ? addr.port : 0}`;
    try {
      // New-style row (post-FTS5): union shrank candidateCount, eligibleCount keeps the old semantic.
      isoRepo.addAudit("retrieve", JSON.stringify({ query: "a", returnedIds: [], eligibleCount: 40, candidateCount: 4, latencyMs: 1 }));
      // Old-style row (pre-FTS5): no eligibleCount.
      isoRepo.addAudit("retrieve", JSON.stringify({ query: "b", returnedIds: [], candidateCount: 10, latencyMs: 1 }));
      const res = await fetch(`${isoUrl}/v1/analytics?days=7`);
      const a = await res.json() as { retrieval: { avgCandidates: number } };
      // (40 + 10) / 2 — proves both the preference and the fallback in one number:
      // candidateCount-for-both gives 7, eligibleCount-only gives 20.
      assert.equal(a.retrieval.avgCandidates, 25);
    } finally {
      isoServer.close();
      isoRepo.close();
    }
  });
});

describe("POST /v1/memories secret rejection", () => {
  it("returns 422 for credential content", async () => {
    const res = await fetch(`${baseUrl}/v1/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "local", type: "semantic", content: "key: AKIAABCDEFGHIJKLMNOP" }),
    });
    assert.equal(res.status, 422);
    const body = await res.json() as { rejected: boolean; kind: string };
    assert.equal(body.rejected, true);
    assert.equal(body.kind, "aws-access-key");
  });
});

describe("PATCH /v1/memories/:id secret rejection", () => {
  it("returns 422 for credential content and leaves the memory unchanged", async () => {
    const created = repo.create({ userId: "local", type: "semantic", content: "original content" });
    const res = await fetch(`${baseUrl}/v1/memories/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "key: AKIAABCDEFGHIJKLMNOP" }),
    });
    assert.equal(res.status, 422);
    const body = await res.json() as { rejected: boolean; kind: string };
    assert.equal(body.rejected, true);
    assert.equal(body.kind, "aws-access-key");

    const getRes = await fetch(`${baseUrl}/v1/memories/${created.id}`);
    const memory = await getRes.json() as { content: string };
    assert.equal(memory.content, "original content");
  });
});
