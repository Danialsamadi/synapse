import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryRepository } from "@mneme/store";
import { createMnemeMcpServer } from "./server.js";

async function connected() {
  const repo = new MemoryRepository({ path: ":memory:" });
  const server = createMnemeMcpServer(repo);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { repo, client };
}

describe("mneme MCP server", () => {
  it("lists both memory tools", async () => {
    const { repo, client } = await connected();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["memory_retrieve", "memory_write"]);
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
});
