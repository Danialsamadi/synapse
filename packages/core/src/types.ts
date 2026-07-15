import { z } from "zod";

export const MemoryTypeSchema = z.enum([
  "episodic",
  "semantic",
  "procedural",
  "working",
]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryStatusSchema = z.enum([
  "active",
  "superseded",
  "disputed",
  "archived",
  "deleted",
]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const SourceRefSchema = z.object({
  kind: z.enum(["message", "note", "file", "tool", "manual"]),
  id: z.string().min(1),
  excerpt: z.string().optional(),
  observedAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const MemoryLinkSchema = z.object({
  rel: z.enum([
    "supports",
    "contradicts",
    "supersedes",
    "related_to",
    "derived_from",
  ]),
  targetId: z.string().min(1),
});
export type MemoryLink = z.infer<typeof MemoryLinkSchema>;

export const RetentionPolicySchema = z.object({
  mode: z.enum(["default", "pinned", "ttl", "session"]),
  expiresAt: z.string().optional(),
  pinReason: z.string().optional(),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const MemorySchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  type: MemoryTypeSchema,
  status: MemoryStatusSchema,
  content: z.string().min(1),
  structured: z.record(z.unknown()).optional(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  decayHalfLifeDays: z.number().positive(),
  lastAccessedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sourceRefs: z.array(SourceRefSchema),
  links: z.array(MemoryLinkSchema),
  tags: z.array(z.string()),
  retention: RetentionPolicySchema,
});
export type Memory = z.infer<typeof MemorySchema>;

export const CreateMemoryInputSchema = z.object({
  userId: z.string().min(1).optional().default("local"),
  type: MemoryTypeSchema,
  content: z.string().min(1),
  structured: z.record(z.unknown()).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  decayHalfLifeDays: z.number().positive().optional(),
  sourceRefs: z.array(SourceRefSchema).optional(),
  tags: z.array(z.string()).optional(),
  retention: RetentionPolicySchema.optional(),
});
export type CreateMemoryInput = z.infer<typeof CreateMemoryInputSchema>;

export const UpdateMemoryInputSchema = z.object({
  content: z.string().min(1).optional(),
  status: MemoryStatusSchema.optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  structured: z.record(z.unknown()).optional(),
  retention: RetentionPolicySchema.optional(),
});
export type UpdateMemoryInput = z.infer<typeof UpdateMemoryInputSchema>;

export const RetrieveRequestSchema = z.object({
  query: z.string().min(1),
  userId: z.string().min(1).optional().default("local"),
  types: z.array(MemoryTypeSchema).optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(50).default(8),
  tokenBudget: z.number().int().positive().optional(),
  includeEvidence: z.boolean().optional(),
  includeDisputed: z.boolean().optional(),
});
export type RetrieveRequest = z.infer<typeof RetrieveRequestSchema>;

export const ScoreBreakdownSchema = z.object({
  vector: z.number().optional(),
  keyword: z.number().optional(),
  importance: z.number().optional(),
  recency: z.number().optional(),
  decay: z.number().optional(),
  conflict: z.number().optional(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const RetrievedMemorySchema = z.object({
  id: z.string(),
  type: MemoryTypeSchema,
  content: z.string(),
  score: z.number(),
  scoreBreakdown: ScoreBreakdownSchema.optional(),
  status: MemoryStatusSchema,
  evidence: z.array(SourceRefSchema).optional(),
  conflictsWith: z.array(z.string()).optional(),
});
export type RetrievedMemory = z.infer<typeof RetrievedMemorySchema>;

/** Default half-lives (days) by type — tunable later via config. */
export const DEFAULT_HALF_LIFE_DAYS: Record<MemoryType, number> = {
  episodic: 30,
  semantic: 180,
  procedural: 365,
  working: 0.5,
};

export const DEFAULT_IMPORTANCE: Record<MemoryType, number> = {
  episodic: 0.4,
  semantic: 0.7,
  procedural: 0.8,
  working: 0.3,
};
