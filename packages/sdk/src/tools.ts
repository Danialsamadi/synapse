import { z } from "zod";
import type { MnemeClient } from "./index.js";

export const MemoryWriteToolInputSchema = z.object({
  type: z.enum(["episodic", "semantic", "procedural"]),
  content: z.string().min(1),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  structured: z.record(z.unknown()).optional(),
  sourceMessageId: z.string().optional(),
});
export type MemoryWriteToolInput = z.infer<typeof MemoryWriteToolInputSchema>;

export const MemoryRetrieveToolInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).optional(),
  types: z.array(z.enum(["episodic", "semantic", "procedural", "working"])).optional(),
});
export type MemoryRetrieveToolInput = z.infer<typeof MemoryRetrieveToolInputSchema>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: "memory_write",
    description:
      "Store a long-term memory about the user. Use episodic for events, semantic for durable facts, procedural for preferences.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["episodic", "semantic", "procedural"] },
        content: { type: "string" },
        importance: { type: "number", minimum: 0, maximum: 1 },
        tags: { type: "array", items: { type: "string" } },
        structured: { type: "object" },
        sourceMessageId: { type: "string" },
      },
      required: ["type", "content"],
    },
  },
  {
    name: "memory_retrieve",
    description: "Retrieve relevant long-term memories about the user for the current query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        types: { type: "array", items: { type: "string", enum: ["episodic", "semantic", "procedural", "working"] } },
      },
      required: ["query"],
    },
  },
];

export async function executeMemoryTool(
  client: MnemeClient,
  name: string,
  args: unknown,
): Promise<unknown> {
  if (name === "memory_write") {
    const input = MemoryWriteToolInputSchema.parse(args);
    return client.createMemory({
      userId: "local",
      type: input.type,
      content: input.content,
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.structured ? { structured: input.structured } : {}),
      ...(input.sourceMessageId
        ? { sourceRefs: [{ kind: "message" as const, id: input.sourceMessageId, observedAt: new Date().toISOString() }] }
        : {}),
    });
  }
  if (name === "memory_retrieve") {
    const input = MemoryRetrieveToolInputSchema.parse(args);
    return client.retrieve({
      query: input.query,
      userId: "local",
      limit: input.limit ?? 8,
      ...(input.types ? { types: input.types } : {}),
    });
  }
  throw new Error(`Unknown memory tool: ${name}`);
}
