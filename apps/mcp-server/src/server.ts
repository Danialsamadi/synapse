import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryRepository, RetrievalService, createEmbedder } from "@mneme/store";
import { TOOL_MAX_IMPORTANCE } from "@mneme/sdk";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function createMnemeMcpServer(repo: MemoryRepository): McpServer {
  const embedder = createEmbedder();
  const retrieval = new RetrievalService(repo, embedder);
  const server = new McpServer({ name: "mneme", version: "0.1.0" });

  server.registerTool(
    "memory_write",
    {
      description:
        "Store a long-term memory about the user. Use episodic for events, semantic for durable facts, procedural for preferences.",
      inputSchema: {
        type: z.enum(["episodic", "semantic", "procedural"]),
        content: z.string().min(1),
        importance: z.number().min(0).max(1).optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ type, content, importance, tags }) => {
      const existing = repo.findActiveByContentHash("local", type, content);
      if (existing) return json({ deduped: true, memory: existing });
      const memory = repo.create({
        userId: "local",
        type,
        content,
        ...(importance !== undefined ? { importance: Math.min(importance, TOOL_MAX_IMPORTANCE) } : {}),
        ...(tags ? { tags } : {}),
        sourceRefs: [{ kind: "tool", id: "mcp", observedAt: new Date().toISOString() }],
      });
      const [vec] = await embedder.embed([memory.content]);
      if (vec) repo.saveEmbedding(memory.id, vec, embedder.model);
      return json(memory);
    },
  );

  server.registerTool(
    "memory_retrieve",
    {
      description: "Retrieve relevant long-term memories about the user for the current query.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(20).optional(),
        types: z.array(z.enum(["episodic", "semantic", "procedural", "working"])).optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ query, limit, types, tags }) => {
      const result = await retrieval.retrieve({
        query,
        userId: "local",
        limit: limit ?? 8,
        ...(types ? { types } : {}),
        ...(tags ? { tags } : {}),
      });
      return json(result);
    },
  );

  return server;
}
