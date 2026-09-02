import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryRepository, RetrievalService, createEmbedder, runDecay, writeMemory } from "@synapse/store";
import { TOOL_MAX_IMPORTANCE } from "@synapse/sdk";

export interface SynapsePrincipal { userId: string; teamIds: string[] }

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

export function createSynapseMcpServer(repo: MemoryRepository, principal: SynapsePrincipal = { userId: "local", teamIds: [] }): McpServer {
  const embedder = createEmbedder();
  const retrieval = new RetrievalService(repo, embedder);
  // PKG_VERSION is injected by tsup at build time from package.json.
  const server = new McpServer({ name: "synapse", version: process.env.PKG_VERSION ?? "0.0.0-dev" });

  // Version stamp: long-lived hosts can keep a pre-upgrade process serving for
  // days — this audit row is how a CLI or SQL reader detects the skew.
  repo.addAudit("startup", JSON.stringify({ version: process.env.PKG_VERSION ?? "0.0.0-dev" }));

  // The MCP path is the flagship install and has no job runner: sweep once at
  // startup so TTL expiry, decay archival, and the confidence floor actually
  // run for npx-only users.
  const swept = runDecay(repo);
  if (swept.archived > 0 || swept.expired > 0) {
    repo.addAudit("job", JSON.stringify({ kind: "decay", trigger: "mcp-startup", ...swept }));
  }

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
        occurredAt: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("ISO timestamp of when the fact was true or the event happened, if not now — e.g. the user recounts something from last month."),
        links: z
          .array(z.object({
            rel: z.enum(["supports", "contradicts", "related_to", "derived_from", "part_of"]),
            targetId: z.string().min(1),
          }))
          .optional()
          .describe("Structural edges to existing memories, e.g. part_of to link a chapter to its book."),
        scope: z.enum(["private", "team"]).optional().default("private"),
        teamId: z.string().min(1).optional(),
      },
    },
    async ({ type, content, importance, tags, entityKey, occurredAt, links, scope, teamId }) => {
      if (scope === "team" && (!teamId || !principal.teamIds.includes(teamId))) {
        return json({ error: "not_found" });
      }
      const outcome = await writeMemory(repo, embedder, {
        userId: principal.userId,
        ownerId: principal.userId,
        createdBy: principal.userId,
        scope,
        ...(scope === "team" ? { teamId } : {}),
        type,
        content,
        source: "mcp",
        ...(importance !== undefined ? { importance: Math.min(importance, TOOL_MAX_IMPORTANCE) } : {}),
        ...(tags ? { tags } : {}),
        ...(entityKey ? { entityKey } : {}),
        sourceRefs: [{ kind: "tool", id: "mcp", observedAt: occurredAt ?? new Date().toISOString() }],
      });
      if ("rejected" in outcome) {
        return json({
          rejected: true,
          reason:
            `Content appears to contain a credential (${outcome.kind}). Synapse does not store secrets — ` +
            "suggest the user keep it in a password manager instead. A human can override by setting " +
            "SYNAPSE_ALLOW_SECRETS=1 in the server environment.",
        });
      }
      const { memory, supersededIds, deduped, absorbed } = outcome;
      // Links attach even on dedup — relating existing knowledge is still useful.
      for (const l of links ?? []) {
        if (repo.get(l.targetId)) repo.addLink(memory.id, l.targetId, l.rel);
      }
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
        userId: principal.userId,
        teamIds: principal.teamIds,
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
    async ({ maxItems, tokenBudget }) => json(retrieval.digest(principal.userId, maxItems ?? 12, tokenBudget, principal.teamIds)),
  );

  server.registerTool(
    "memory_feedback",
    {
      description:
        "Report whether a retrieved memory was accurate. Call with verdict 'stale' when the memory was true but is now outdated, 'wrong' when it was never accurate, and 'helpful' when a retrieved memory proved correct and useful.",
      inputSchema: {
        id: z.string().min(1),
        verdict: z.enum(["helpful", "stale", "wrong"]),
      },
    },
    async ({ id, verdict }) => {
      const visible = repo.getVisible(id, principal.userId, principal.teamIds);
      const memory = visible ? repo.applyFeedback(id, verdict) : null;
      return memory ? json(memory) : json({ error: "not_found", id });
    },
  );

  return server;
}
