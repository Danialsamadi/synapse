import { randomBytes } from "node:crypto";

/** Simple sortable-ish id for MVP (swap for ULID later if needed). */
export function newMemoryId(): string {
  const t = Date.now().toString(36);
  const r = randomBytes(6).toString("hex");
  return `mem_${t}_${r}`;
}
