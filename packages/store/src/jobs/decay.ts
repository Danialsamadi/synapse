import { ageDays, decayPenalty, eventTime } from "@synapse/core";
import type { MemoryRepository } from "../memory-repository.js";

export interface DecayResult { archived: number; expired: number; scanned: number }

const ARCHIVE_THRESHOLD = 0.05;
/** Memories driven below this by "wrong" feedback are noise; retire them. */
const CONFIDENCE_FLOOR = 0.1;

export function runDecay(repo: MemoryRepository, userId = "local", now = new Date()): DecayResult {
  const result: DecayResult = { archived: 0, expired: 0, scanned: 0 };
  const candidates = [
    ...repo.list(userId, { status: "active" }),
    ...repo.list(userId, { status: "disputed" }),
  ];
  for (const m of candidates) {
    result.scanned++;
    if (m.retention.mode === "pinned") continue;
    if (m.retention.mode === "ttl" || m.retention.mode === "session") {
      if (m.retention.expiresAt && m.retention.expiresAt <= now.toISOString()) {
        repo.update(m.id, { status: "archived" });
        result.expired++;
      }
      continue;
    }
    if (m.confidence < CONFIDENCE_FLOOR) {
      repo.update(m.id, { status: "archived" });
      result.archived++;
      continue;
    }
    if (m.type !== "episodic" && m.type !== "working") continue;
    // Age from when the event happened, not when it was written — a backdated
    // import of last year's journal is already old.
    const penalty = decayPenalty(ageDays(eventTime(m), now), m.decayHalfLifeDays, m.retention.mode);
    const utility = m.importance * (1 - penalty);
    if (utility < ARCHIVE_THRESHOLD) {
      repo.update(m.id, { status: "archived" });
      result.archived++;
    }
  }
  return result;
}
