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
  detectSecret,
  secretsAllowed,
} from "@synapse/core";
import { runMigrations } from "./schema.js";

export interface MemoryRepositoryOptions {
  /** Path to sqlite file, or ":memory:" for tests. */
  path?: string;
}

/** Thrown by update() when patch.content is a rejected secret and SYNAPSE_ALLOW_SECRETS is unset. */
export class SecretContentError extends Error {
  constructor(public readonly kind: string) {
    super(`Content update rejected: contains a credential (${kind})`);
    this.name = "SecretContentError";
  }
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
    // Multiple agents may share one DB file; wait for the writer instead of SQLITE_BUSY.
    this.db.pragma("busy_timeout = 5000");
    runMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** Online backup via SQLite's backup API — safe while the DB is in use (WAL). */
  async backup(destination: string): Promise<void> {
    await this.db.backup(destination);
  }

  create(raw: CreateMemoryInput): Memory {
    const { entityKey, ...input } = CreateMemoryInputSchema.parse(raw);
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

    const preview = memory.content.length > 120 ? memory.content.slice(0, 117) + "…" : memory.content;
    // entityKey arrives top-level from direct create() calls, but via structured
    // when createWithEntitySupersede re-enters — log it from either path.
    const auditEntityKey = entityKey ?? (input.structured?.entityKey as string | undefined);
    this.addAudit("write", JSON.stringify({
      id: memory.id,
      type: memory.type,
      contentPreview: preview,
      source: input.source ?? "api",
      ...(auditEntityKey ? { entityKey: auditEntityKey } : {}),
    }));

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
    if (patch.content !== undefined && !secretsAllowed()) {
      const hit = detectSecret(patch.content);
      if (hit) {
        this.addAudit("secret_rejected", JSON.stringify({ id, kind: hit.kind, source: "update" }));
        throw new SecretContentError(hit.kind);
      }
    }
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

  findActiveByEntityKey(userId: string, entityKey: string): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE user_id = ? AND status = 'active'
           AND json_extract(structured_json, '$.entityKey') = ?
         ORDER BY created_at DESC`,
      )
      .all(userId, entityKey) as Row[];
    return rows.map((r) => this.withLinks(fromRow(r)));
  }

  /**
   * Create with content-hash dedupe; if entityKey given, mark prior actives
   * with that key superseded and link. On dedupe with a new entityKey, the
   * key is attached to the existing memory so supersession still applies.
   */
  createWithEntitySupersede(
    rawInput: CreateMemoryInput,
  ): { memory: Memory; supersededIds: string[]; deduped: boolean } {
    const { entityKey, ...rest } = CreateMemoryInputSchema.parse(rawInput);
    const userId = rest.userId ?? "local";
    const existing = this.findActiveByContentHash(userId, rest.type, rest.content);
    if (!entityKey) {
      return existing
        ? { memory: existing, supersededIds: [], deduped: true }
        : { memory: this.create(rest), supersededIds: [], deduped: false };
    }

    const prior = this.findActiveByEntityKey(userId, entityKey).filter(
      (m) => m.id !== existing?.id,
    );
    const memory = existing
      ? existing.structured?.entityKey === entityKey
        ? existing
        : this.update(existing.id, {
            structured: { ...(existing.structured ?? {}), entityKey },
          })!
      : this.create({
          ...rest,
          structured: { ...(rest.structured ?? {}), entityKey },
        });
    for (const old of prior) {
      this.update(old.id, { status: "superseded" });
      this.addLink(memory.id, old.id, "supersedes");
      this.addAudit("supersede", JSON.stringify({
        winnerId: memory.id,
        loserId: old.id,
        via: "entityKey",
      }));
    }
    return { memory, supersededIds: prior.map((m) => m.id), deduped: !!existing };
  }

  private withLinks(m: Memory): Memory {
    // Rel direction is from → to. Incoming links only apply for symmetric
    // rels; reversing asymmetric ones like `supersedes` would misstate them.
    const links = this.getLinks(m.id).flatMap((l) => {
      if (l.fromId === m.id) return [{ rel: l.rel, targetId: l.toId }];
      if (l.rel === "contradicts" || l.rel === "related_to")
        return [{ rel: l.rel, targetId: l.fromId }];
      return [];
    });
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

  listAudit(action?: string, limit?: number): Array<{ id: number; action: string; detail: string; createdAt: string }> {
    let sql = `SELECT * FROM audit_log`;
    const params: unknown[] = [];
    if (action) {
      sql += ` WHERE action = ?`;
      params.push(action);
    }
    sql += ` ORDER BY id DESC`;
    if (limit) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number; action: string; detail: string; created_at: string;
    }>;
    return rows.map((r) => ({ id: r.id, action: r.action, detail: r.detail, createdAt: r.created_at }));
  }

  addAudit(action: string, detail: string): void {
    this.db
      .prepare(`INSERT INTO audit_log (action, detail, created_at) VALUES (?, ?, ?)`)
      .run(action, detail, new Date().toISOString());
  }

  pruneAudit(keepLast = 5000): void {
    this.db.prepare(
      `DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?)`,
    ).run(keepLast);
  }

  saveEmbedding(memoryId: string, vector: number[], model: string): void {
    if (vector.length === 0) throw new Error("Embedding vector must not be empty");
    const existing = this.db
      .prepare("SELECT dims FROM embeddings WHERE memory_id = ?")
      .get(memoryId) as { dims: number } | undefined;
    if (existing && existing.dims !== vector.length) {
      throw new Error(
        `Embedding dimension mismatch: existing=${existing.dims} got=${vector.length}. ` +
          `Delete the old embedding or use a consistent model.`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO embeddings (memory_id, dims, vector_json, model, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET dims=excluded.dims,
           vector_json=excluded.vector_json, model=excluded.model, updated_at=excluded.updated_at`,
      )
      .run(memoryId, vector.length, JSON.stringify(vector), model, new Date().toISOString());
  }

  /** All memories across users/statuses, for re-embedding after a model switch. */
  listAllForReembed(): Array<{ id: string; content: string }> {
    return this.db.prepare("SELECT id, content FROM memories").all() as Array<{
      id: string;
      content: string;
    }>;
  }

  /** Replaces an embedding outright — the dims guard in saveEmbedding is for
   *  accidental provider mixing; a deliberate reembed bypasses it. */
  replaceEmbedding(memoryId: string, vector: number[], model: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM embeddings WHERE memory_id = ?`).run(memoryId);
      this.saveEmbedding(memoryId, vector, model);
    })();
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

  /** BM25 keyword ranks for a query, min-max normalized to [0,1] (best hit = 1).
   *  Empty Map = ran, no matches. null = FTS itself failed → caller must fall
   *  back to legacy substring scoring so retrieval never breaks. */
  searchKeyword(query: string): Map<string, number> | null {
    const match = buildMatchExpr(query);
    if (match === null) return new Map();
    try {
      const rows = this.db
        .prepare(
          `SELECT m.id, bm25(memories_fts) AS rank
           FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ?
           ORDER BY rank LIMIT 200`,
        )
        .all(match) as Array<{ id: string; rank: number }>;
      const out = new Map<string, number>();
      if (rows.length === 0) return out;
      // bm25 is negative-better; min-max over the result set, single hit → 1.
      const best = rows[0]!.rank;
      const worst = rows[rows.length - 1]!.rank;
      const span = worst - best;
      for (const r of rows) out.set(r.id, span === 0 ? 1 : (worst - r.rank) / span);
      return out;
    } catch {
      return null;
    }
  }

  touchAccessed(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`UPDATE memories SET last_accessed_at = ? WHERE id = ?`);
    const tx = this.db.transaction((list: string[]) => {
      for (const id of list) stmt.run(now, id);
    });
    tx(ids);
  }

  /** Agent-reported verdict on a retrieved memory. helpful: +0.1 confidence, restores disputed → active. stale/wrong: -0.3 and disputed. */
  applyFeedback(id: string, verdict: "helpful" | "stale" | "wrong"): Memory | null {
    const m = this.get(id);
    if (!m) return null;
    const next =
      verdict === "helpful"
        ? this.update(id, {
            confidence: Math.min(1, m.confidence + 0.1),
            ...(m.status === "disputed" ? { status: "active" as const } : {}),
          })
        : this.update(id, { confidence: Math.max(0, m.confidence - 0.3), status: "disputed" });
    this.addAudit("feedback", JSON.stringify({ id, verdict }));
    return next;
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

/** Safe FTS5 MATCH expression: tokens double-quoted (operators neutralized),
 *  OR-joined (AND is too strict for natural-language queries; bm25 already
 *  ranks multi-term hits higher), every token prefix-matched — recovers the
 *  partial-credit the old substring scorer gave ("roas" matches "roast"). */
export function buildMatchExpr(query: string): string | null {
  const tokens = query.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
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
