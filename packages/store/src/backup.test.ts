import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MemoryRepository } from "./memory-repository.js";

describe("backup", () => {
  it("round-trips: backup of a live DB opens as a working repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-backup-"));
    try {
      const repo = new MemoryRepository({ path: join(dir, "live.db") });
      const created = repo.create({
        userId: "local",
        type: "semantic",
        content: "Backups must survive",
      });
      const dest = join(dir, "copy.db");
      await repo.backup(dest);
      repo.close();

      const restored = new MemoryRepository({ path: dest });
      const got = restored.get(created.id);
      assert.equal(got?.content, "Backups must survive");
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
