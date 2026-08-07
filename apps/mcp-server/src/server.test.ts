import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryRepository } from "@synapse/store";
import { createSynapseMcpServer } from "./server.js";

async function connected() {
  const repo = new MemoryRepository({ path: ":memory:" });
  const server = createSynapseMcpServer(repo);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { repo, client };
}

describe("synapse MCP server", () => {
  it("lists both memory tools", async () => {
    const { repo, client } = await connected();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["memory_digest", "memory_feedback", "memory_retrieve", "memory_write"]);
    repo.close();
  });

  it("write → retrieve round-trip; importance clamped", async () => {
    const { repo, client } = await connected();
    const writeRes = await client.callTool({
      name: "memory_write",
      arguments: { type: "procedural", content: "Prefer concise bullet answers", importance: 1.0 },
    });
    const written = JSON.parse((writeRes.content as Array<{ text: string }>)[0]!.text) as { id: string; importance: number };
    assert.equal(written.importance, 0.8);

    const readRes = await client.callTool({
      name: "memory_retrieve",
      arguments: { query: "how should you answer me" },
    });
    const hits = JSON.parse((readRes.content as Array<{ text: string }>)[0]!.text) as { memories: Array<{ id: string }> };
    assert.equal(hits.memories[0]?.id, written.id);
    repo.close();
  });

  it("rejects invalid input (zod fail-closed)", async () => {
    const { repo, client } = await connected();
    const res = await client.callTool({
      name: "memory_write",
      arguments: { type: "bogus", content: "x" },
    });
    assert.equal(res.isError, true);
    repo.close();
  });

  it("memory_digest returns pinned + important memories as text", async () => {
    const { repo, client } = await connected();
    repo.create({
      userId: "local", type: "procedural", content: "Always answer in French",
      retention: { mode: "pinned", pinReason: "test" },
    });
    const res = await client.callTool({ name: "memory_digest", arguments: {} });
    const out = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { text: string };
    assert.match(out.text, /Always answer in French/);
    repo.close();
  });

  it("memory_feedback archives a stale memory and disputes a wrong one", async () => {
    const { repo, client } = await connected();
    const m = repo.create({ userId: "local", type: "semantic", content: "User works at Acme Corp" });
    const res = await client.callTool({
      name: "memory_feedback",
      arguments: { id: m.id, verdict: "stale" },
    });
    const out = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { status: string };
    assert.equal(out.status, "archived");

    const w = repo.create({ userId: "local", type: "semantic", content: "User is left-handed" });
    const res2 = await client.callTool({
      name: "memory_feedback",
      arguments: { id: w.id, verdict: "wrong" },
    });
    const out2 = JSON.parse((res2.content as Array<{ text: string }>)[0]!.text) as { status: string };
    assert.equal(out2.status, "disputed");
    repo.close();
  });

  it("memory_write occurredAt becomes the sourceRef observedAt (event time)", async () => {
    const { repo, client } = await connected();
    const occurredAt = "2026-01-15T00:00:00.000Z";
    const res = await client.callTool({
      name: "memory_write",
      arguments: { type: "episodic", content: "User ran a marathon in January", occurredAt },
    });
    const out = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { id: string };
    assert.equal(repo.get(out.id)!.sourceRefs[0]!.observedAt, occurredAt);
    repo.close();
  });

  it("memory_write with entityKey supersedes the previous value", async () => {
    const { repo, client } = await connected();
    await client.callTool({
      name: "memory_write",
      arguments: { type: "semantic", content: "User lives in Toronto", entityKey: "user.location" },
    });
    await client.callTool({
      name: "memory_write",
      arguments: { type: "semantic", content: "User lives in Vancouver", entityKey: "user.location" },
    });
    const active = repo.findActiveByEntityKey("local", "user.location");
    assert.equal(active.length, 1);
    assert.equal(active[0]!.content, "User lives in Vancouver");
    repo.close();
  });

  it("memory_retrieve surfaces the qualifier field", async () => {
    const { repo, client } = await connected();
    const m = repo.create({
      userId: "local", type: "semantic", content: "User might be allergic to peanuts", confidence: 0.3,
    });
    const embedder = (await import("@synapse/store")).createEmbedder();
    const [v] = await embedder.embed([m.content]);
    if (v) repo.saveEmbedding(m.id, v, embedder.model);

    const res = await client.callTool({
      name: "memory_retrieve",
      arguments: { query: "peanut allergy" },
    });
    const out = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
      memories: Array<{ id: string; qualifier?: string }>;
    };
    const hit = out.memories.find((x) => x.id === m.id);
    assert.ok(hit, "memory retrieved");
    assert.match(hit.qualifier ?? "", /low confidence/);
    repo.close();
  });

  it("memory_feedback on an unknown id returns not_found, not an error", async () => {
    const { repo, client } = await connected();
    const res = await client.callTool({
      name: "memory_feedback",
      arguments: { id: "mem_does_not_exist", verdict: "helpful" },
    });
    assert.notEqual(res.isError, true);
    const out = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { error: string };
    assert.equal(out.error, "not_found");
    repo.close();
  });

  it("memory_write rejects credential content with an agent-readable reason", async () => {
    const { repo, client } = await connected();
    const res = await client.callTool({
      name: "memory_write",
      arguments: { type: "semantic", content: "here is my key AKIAABCDEFGHIJKLMNOP" },
    });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    assert.equal(payload.rejected, true);
    assert.match(payload.reason, /aws-access-key/);
    assert.match(payload.reason, /password manager/);
    assert.ok(!payload.reason.includes("AKIAABCDEFGHIJKLMNOP"));
    repo.close();
  });
});
