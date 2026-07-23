import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryRepository, RetrievalService, createEmbedder, writeMemory } from "@synapse/store";
import { TOOL_MAX_IMPORTANCE } from "@synapse/sdk";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

/** "today", "yesterday", "5 days ago (2026-07-18)" — in the reader's local timezone. */
function humanizeWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago (${iso.slice(0, 10)})`;
}

export function createSynapseMcpServer(repo: MemoryRepository): McpServer {
  const embedder = createEmbedder();
  const retrieval = new RetrievalService(repo, embedder);
  const server = new McpServer({ name: "synapse", version: "0.1.0" });

  server.registerTool(
    "memory_write",
    {
      description:
        "Store a long-term memory about the user. Call this whenever the user shares a durable fact about themselves (semantic), a preference or instruction about how to work with them (procedural), or a notable event (episodic) — especially when they say 'remember', 'from now on', or state personal facts. Pass entityKey (e.g. 'user.location', 'user.employer') for facts with a single current value so a new value replaces the old one.",
      inputSchema: {
        type: z.enum(["episodic", "semantic", "procedural"]),
        content: z.string().min(1),
        importance: z.number().min(0).max(1).optional(),
        tags: z.array(z.string()).optional(),
        entityKey: z.string().min(1).optional(),
      },
    },
    async ({ type, content, importance, tags, entityKey }) => {
      const { memory, supersededIds, deduped, absorbed } = await writeMemory(repo, embedder, {
        userId: "local",
        type,
        content,
        source: "mcp",
        ...(importance !== undefined ? { importance: Math.min(importance, TOOL_MAX_IMPORTANCE) } : {}),
        ...(tags ? { tags } : {}),
        ...(entityKey ? { entityKey } : {}),
        sourceRefs: [{ kind: "tool", id: "mcp", observedAt: new Date().toISOString() }],
      });
      if (deduped) {
        return json({
          deduped: true,
          ...(absorbed ? { absorbed: true } : {}),
          memory,
          ...(supersededIds.length > 0 ? { supersededIds } : {}),
        });
      }
      return json(supersededIds.length > 0 ? { ...memory, supersededIds } : memory);
    },
  );

  server.registerTool(
    "memory_retrieve",
    {
      description:
        "Retrieve stored long-term memories about the user. Call this BEFORE answering any question about the user's preferences, facts, history, or past conversations (e.g. 'what do you know about me', 'how do I like X', or when personalizing a response) — do not answer such questions from other sources without checking here first.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(20).optional(),
        types: z
          .array(z.enum(["episodic", "semantic", "procedural", "working"]))
          .optional()
          .describe("Usually omit this. Facts are stored as semantic/procedural — filtering to episodic will miss them."),
        tags: z.array(z.string()).optional(),
        minScore: z.number().min(0).max(1).optional(),
      },
    },
    async ({ query, limit, types, tags, minScore }) => {
      const result = await retrieval.retrieve({
        query,
        userId: "local",
        limit: limit ?? 8,
        ...(types ? { types } : {}),
        ...(tags ? { tags } : {}),
        ...(minScore !== undefined ? { minScore } : {}),
      });
      if (result.memories.length === 0) {
        const filtered = (types?.length || tags?.length) && result.stats.candidateCount === 0;
        return json({
          ...result,
          note: filtered
            ? `No memories matched the ${types?.length ? `types=[${types.join(",")}]` : ""}${tags?.length ? ` tags=[${tags.join(",")}]` : ""} filter. Memories of other types may exist — retry this query WITHOUT the types/tags filter before concluding nothing is stored.`
            : "No sufficiently relevant memories found. Do not fabricate an answer from memory — say you don't know or ask the user.",
        });
      }
      // ISO timestamps alone don't register as "today" for many models; say it in words.
      const memories = result.memories.map((m) => ({ ...m, when: humanizeWhen(m.createdAt) }));
      return json({ ...result, memories });
    },
  );

  server.registerTool(
    "memory_digest",
    {
      description:
        "Get the always-on core memory digest: pinned and most important durable facts about the user. Call this once at the START of a session and keep the result in mind for the whole conversation.",
      inputSchema: {
        maxItems: z.number().int().positive().max(50).optional(),
        tokenBudget: z.number().int().positive().optional(),
      },
    },
    async ({ maxItems, tokenBudget }) => json(retrieval.digest("local", maxItems ?? 12, tokenBudget)),
  );

  server.registerTool(
    "memory_feedback",
    {
      description:
        "Report whether a retrieved memory was accurate. Call with verdict 'stale' or 'wrong' when the user corrects something you recalled, and 'helpful' when a retrieved memory proved correct and useful.",
      inputSchema: {
        id: z.string().min(1),
        verdict: z.enum(["helpful", "stale", "wrong"]),
      },
    },
    async ({ id, verdict }) => {
      const memory = repo.applyFeedback(id, verdict);
      return memory ? json(memory) : json({ error: "not_found", id });
    },
  );

  return server;
}
