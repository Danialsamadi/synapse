import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  type CreateMemoryInput,
  type Memory,
  type MemoryLink,
  type MemoryStatus,
  type MemoryType,
  type UpdateMemoryInput,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_IMPORTANCE,
  CreateMemoryInputSchema,
  UpdateMemoryInputSchema,
  newMemoryId,
} from "@mneme/core";
import { MIGRATION_V1, MIGRATION_V2 } from "./schema.js";

export interface MemoryRepositoryOptions {
  /** Path to sqlite file, or ":memory:" for tests. */
  path?: string;
}

export interface JobRow {
  id: string;
  kind: string;
  status: "pending" | "running" | "done" | "failed";
  payload: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export class MemoryRepository {
  private readonly db: Database.Database;

  constructor(options: MemoryRepositoryOptions = {}) {
    this.db = new Database(options.path ?? ":memory:");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(MIGRATION_V1);
    this.db.exec(MIGRATION_V2);
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
    return row ? this.withLinks(fromRow(row)) : null;
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
    return rows.map((r) => this.withLinks(fromRow(r)));
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

  private withLinks(m: Memory): Memory {
    // Only outgoing links: rel direction is from → to; reversing incoming
    // links would misstate asymmetric rels like `supersedes`.
    const links = this.getLinks(m.id)
      .filter((l) => l.fromId === m.id)
      .map((l) => ({ rel: l.rel, targetId: l.toId }));
    return { ...m, links };
  }

  addLink(fromId: string, toId: string, rel: MemoryLink["rel"]): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO links (from_id, to_id, rel, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(fromId, toId, rel, new Date().toISOString());
  }

  getLinks(memoryId: string): Array<{ fromId: string; toId: string; rel: MemoryLink["rel"] }> {
    const rows = this.db
      .prepare(`SELECT from_id, to_id, rel FROM links WHERE from_id = ? OR to_id = ?`)
      .all(memoryId, memoryId) as Array<{ from_id: string; to_id: string; rel: string }>;
    return rows.map((r) => ({ fromId: r.from_id, toId: r.to_id, rel: r.rel as MemoryLink["rel"] }));
  }

  addQuarantine(kind: string, payload: string, error: string): void {
    this.db
      .prepare(`INSERT INTO quarantine (kind, payload, error, created_at) VALUES (?, ?, ?, ?)`)
      .run(kind, payload, error, new Date().toISOString());
  }

  listQuarantine(): Array<{ id: number; kind: string; payload: string; error: string; createdAt: string }> {
    const rows = this.db.prepare(`SELECT * FROM quarantine ORDER BY id`).all() as Array<{
      id: number; kind: string; payload: string; error: string; created_at: string;
    }>;
    return rows.map((r) => ({ id: r.id, kind: r.kind, payload: r.payload, error: r.error, createdAt: r.created_at }));
  }

  addAudit(action: string, detail: string): void {
    this.db
      .prepare(`INSERT INTO audit_log (action, detail, created_at) VALUES (?, ?, ?)`)
      .run(action, detail, new Date().toISOString());
  }

  saveEmbedding(memoryId: string, vector: number[], model: string): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (memory_id, dims, vector_json, model, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET dims=excluded.dims,
           vector_json=excluded.vector_json, model=excluded.model, updated_at=excluded.updated_at`,
      )
      .run(memoryId, vector.length, JSON.stringify(vector), model, new Date().toISOString());
  }

  getEmbeddings(memoryIds: string[]): Map<string, number[]> {
    const out = new Map<string, number[]>();
    if (memoryIds.length === 0) return out;
    const placeholders = memoryIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT memory_id, vector_json FROM embeddings WHERE memory_id IN (${placeholders})`)
      .all(...memoryIds) as Array<{ memory_id: string; vector_json: string }>;
    for (const r of rows) out.set(r.memory_id, JSON.parse(r.vector_json) as number[]);
    return out;
  }

  deleteEmbedding(memoryId: string): void {
    this.db.prepare(`DELETE FROM embeddings WHERE memory_id = ?`).run(memoryId);
  }

  createJob(kind: string, payload?: unknown): JobRow {
    const now = new Date().toISOString();
    const row: JobRow = {
      id: newMemoryId(),
      kind,
      status: "pending",
      payload: payload === undefined ? null : JSON.stringify(payload),
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, status, payload_json, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.kind, row.status, row.payload, row.result, row.createdAt, row.updatedAt);
    return row;
  }

  updateJob(id: string, status: JobRow["status"], result?: unknown): void {
    this.db
      .prepare(`UPDATE jobs SET status = ?, result_json = ?, updated_at = ? WHERE id = ?`)
      .run(status, result === undefined ? null : JSON.stringify(result), new Date().toISOString(), id);
  }

  getJob(id: string): JobRow | null {
    const r = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
      | { id: string; kind: string; status: string; payload_json: string | null; result_json: string | null; created_at: string; updated_at: string }
      | undefined;
    if (!r) return null;
    return { id: r.id, kind: r.kind, status: r.status as JobRow["status"], payload: r.payload_json, result: r.result_json, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  lastDoneJob(kind: string): JobRow | null {
    const r = this.db
      .prepare(`SELECT id FROM jobs WHERE kind = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 1`)
      .get(kind) as { id: string } | undefined;
    return r ? this.getJob(r.id) : null;
  }

  softDeleteWhere(
    userId: string,
    filter: { tags?: string[]; types?: MemoryType[]; before?: string },
  ): number {
    const all = this.list(userId).filter((m) => m.status !== "deleted");
    const targets = all.filter((m) => {
      if (filter.types && !filter.types.includes(m.type)) return false;
      if (filter.tags && !filter.tags.some((t) => m.tags.includes(t))) return false;
      if (filter.before && m.createdAt >= filter.before) return false;
      return filter.tags !== undefined || filter.types !== undefined || filter.before !== undefined;
    });
    for (const m of targets) this.softDelete(m.id);
    return targets.length;
  }

  purgeDeleted(): { purged: number } {
    const rows = this.db.prepare(`SELECT id FROM memories WHERE status = 'deleted'`).all() as Array<{ id: string }>;
    const purge = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.db.prepare(`DELETE FROM embeddings WHERE memory_id = ?`).run(id);
        this.db.prepare(`DELETE FROM links WHERE from_id = ? OR to_id = ?`).run(id, id);
        this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
      }
    });
    purge(rows.map((r) => r.id));
    return { purged: rows.length };
  }

  exportAll(userId: string): { memories: Memory[]; exportedAt: string } {
    const memories = this.list(userId).filter((m) => m.status !== "deleted");
    return { memories, exportedAt: new Date().toISOString() };
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
