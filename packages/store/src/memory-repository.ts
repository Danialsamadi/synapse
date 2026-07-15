import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  type CreateMemoryInput,
  type Memory,
  type MemoryStatus,
  type MemoryType,
  type UpdateMemoryInput,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_IMPORTANCE,
  CreateMemoryInputSchema,
  UpdateMemoryInputSchema,
  newMemoryId,
} from "@mneme/core";
import { MIGRATION_V1 } from "./schema.js";

export interface MemoryRepositoryOptions {
  /** Path to sqlite file, or ":memory:" for tests. */
  path?: string;
}

export class MemoryRepository {
  private readonly db: Database.Database;

  constructor(options: MemoryRepositoryOptions = {}) {
    this.db = new Database(options.path ?? ":memory:");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(MIGRATION_V1);
  }

  close(): void {
    this.db.close();
  }

  create(raw: CreateMemoryInput): Memory {
    const input = CreateMemoryInputSchema.parse(raw);
    const now = new Date().toISOString();
    const type = input.type;
    const memory: Memory = {
      id: newMemoryId(),
      userId: input.userId,
      type,
      status: "active",
      content: input.content,
      ...(input.structured !== undefined
        ? { structured: input.structured }
        : {}),
      importance: input.importance ?? DEFAULT_IMPORTANCE[type],
      confidence: input.confidence ?? 0.7,
      decayHalfLifeDays:
        input.decayHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS[type],
      createdAt: now,
      updatedAt: now,
      sourceRefs:
        input.sourceRefs ??
        (type === "working"
          ? []
          : [
              {
                kind: "manual",
                id: "cli-or-api",
                observedAt: now,
              },
            ]),
      links: [],
      tags: input.tags ?? [],
      retention: input.retention ?? { mode: "default" },
    };

    const hash = contentHash(memory.type, memory.content);
    this.db
      .prepare(
        `INSERT INTO memories (
          id, user_id, type, status, content, structured_json,
          importance, confidence, decay_half_life_days, last_accessed_at,
          created_at, updated_at, source_refs_json, links_json, tags_json,
          retention_json, content_hash
        ) VALUES (
          @id, @user_id, @type, @status, @content, @structured_json,
          @importance, @confidence, @decay_half_life_days, @last_accessed_at,
          @created_at, @updated_at, @source_refs_json, @links_json, @tags_json,
          @retention_json, @content_hash
        )`,
      )
      .run(toRow(memory, hash));

    return memory;
  }

  get(id: string): Memory | null {
    const row = this.db
      .prepare(`SELECT * FROM memories WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(userId: string, opts?: { status?: MemoryStatus; type?: MemoryType }): Memory[] {
    let sql = `SELECT * FROM memories WHERE user_id = ?`;
    const params: unknown[] = [userId];
    if (opts?.status) {
      sql += ` AND status = ?`;
      params.push(opts.status);
    }
    if (opts?.type) {
      sql += ` AND type = ?`;
      params.push(opts.type);
    }
    sql += ` ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(fromRow);
  }

  softDelete(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ? AND status != 'deleted'`,
      )
      .run(now, id);
    return result.changes > 0;
  }

  update(id: string, rawPatch: UpdateMemoryInput): Memory | null {
    const patch = UpdateMemoryInputSchema.parse(rawPatch);
    const existing = this.get(id);
    if (!existing) return null;
    const next: Memory = {
      ...existing,
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.structured !== undefined ? { structured: patch.structured } : {}),
      ...(patch.retention !== undefined ? { retention: patch.retention } : {}),
      updatedAt: new Date().toISOString(),
    };
    const hash = contentHash(next.type, next.content);
    this.db
      .prepare(
        `UPDATE memories SET status=@status, content=@content, structured_json=@structured_json,
         importance=@importance, confidence=@confidence, tags_json=@tags_json,
         retention_json=@retention_json, updated_at=@updated_at, content_hash=@content_hash
         WHERE id=@id`,
      )
      .run({ ...toRow(next, hash), id });
    return next;
  }

  /** Find active semantic with same content hash (MVP near-dedupe). */
  findActiveByContentHash(
    userId: string,
    type: MemoryType,
    content: string,
  ): Memory | null {
    const hash = contentHash(type, content);
    const row = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE user_id = ? AND type = ? AND status = 'active' AND content_hash = ?
         LIMIT 1`,
      )
      .get(userId, type, hash) as Row | undefined;
    return row ? fromRow(row) : null;
  }
}

interface Row {
  id: string;
  user_id: string;
  type: string;
  status: string;
  content: string;
  structured_json: string | null;
  importance: number;
  confidence: number;
  decay_half_life_days: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  source_refs_json: string;
  links_json: string;
  tags_json: string;
  retention_json: string;
  content_hash: string | null;
}

function contentHash(type: string, content: string): string {
  return createHash("sha256")
    .update(`${type}\n${content.trim().toLowerCase()}`)
    .digest("hex");
}

function toRow(m: Memory, hash: string) {
  return {
    id: m.id,
    user_id: m.userId,
    type: m.type,
    status: m.status,
    content: m.content,
    structured_json: m.structured ? JSON.stringify(m.structured) : null,
    importance: m.importance,
    confidence: m.confidence,
    decay_half_life_days: m.decayHalfLifeDays,
    last_accessed_at: m.lastAccessedAt ?? null,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    source_refs_json: JSON.stringify(m.sourceRefs),
    links_json: JSON.stringify(m.links),
    tags_json: JSON.stringify(m.tags),
    retention_json: JSON.stringify(m.retention),
    content_hash: hash,
  };
}

function fromRow(row: Row): Memory {
  const structured = row.structured_json
    ? (JSON.parse(row.structured_json) as Record<string, unknown>)
    : undefined;
  const memory: Memory = {
    id: row.id,
    userId: row.user_id,
    type: row.type as Memory["type"],
    status: row.status as Memory["status"],
    content: row.content,
    importance: row.importance,
    confidence: row.confidence,
    decayHalfLifeDays: row.decay_half_life_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceRefs: JSON.parse(row.source_refs_json) as Memory["sourceRefs"],
    links: JSON.parse(row.links_json) as Memory["links"],
    tags: JSON.parse(row.tags_json) as string[],
    retention: JSON.parse(row.retention_json) as Memory["retention"],
  };
  if (structured !== undefined) memory.structured = structured;
  if (row.last_accessed_at) memory.lastAccessedAt = row.last_accessed_at;
  return memory;
}
