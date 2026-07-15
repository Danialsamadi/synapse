import { ageDays, decayPenalty } from "@mneme/core";
import type { MemoryRepository } from "../memory-repository.js";

export interface DecayResult { archived: number; expired: number; scanned: number }

const ARCHIVE_THRESHOLD = 0.05;

export function runDecay(repo: MemoryRepository, userId = "local", now = new Date()): DecayResult {
  const result: DecayResult = { archived: 0, expired: 0, scanned: 0 };
  const active = repo.list(userId, { status: "active" });
  for (const m of active) {
    result.scanned++;
    if (m.retention.mode === "pinned") continue;
    if (m.retention.mode === "ttl" || m.retention.mode === "session") {
      if (m.retention.expiresAt && m.retention.expiresAt <= now.toISOString()) {
        repo.update(m.id, { status: "archived" });
        result.expired++;
      }
      continue;
    }
    if (m.type !== "episodic" && m.type !== "working") continue;
    const penalty = decayPenalty(ageDays(m.createdAt, now), m.decayHalfLifeDays, m.retention.mode);
    const utility = m.importance * (1 - penalty);
    if (utility < ARCHIVE_THRESHOLD) {
      repo.update(m.id, { status: "archived" });
      result.archived++;
    }
  }
  return result;
}
