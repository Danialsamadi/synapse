import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { MemoryRepository } from "@mneme/store";
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
  baseUrl = `http://localhost:${addr !== null && typeof addr === "object" ? addr.port : port}`;
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
