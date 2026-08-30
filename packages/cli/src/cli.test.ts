import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.js";

describe("runCli", () => {
  let dir: string;
  let logs: string[];
  const origLog = console.log;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "synapse-cli-"));
    process.env.SYNAPSE_DB = join(dir, "test.db");
    logs = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
  });

  afterEach(() => {
    console.log = origLog;
    delete process.env.SYNAPSE_DB;
    rmSync(dir, { recursive: true, force: true });
  });

  it("remember then query round-trips through the shared store", async () => {
    await runCli(["remember", "semantic", "User prefers TypeScript over JavaScript"]);
    const written = JSON.parse(logs.join("\n"));
    assert.equal(written.type, "semantic");

    logs.length = 0;
    await runCli(["query", "typescript preference"]);
    const res = JSON.parse(logs.join("\n"));
    assert.ok(res.memories.some((m: { content: string }) => m.content.includes("TypeScript")));
  });

  it("restore refuses while another connection holds the DB (stranding guard)", async () => {
    await runCli(["remember", "semantic", "original fact before restore"]);
    const backup = join(dir, "backup.db");
    await runCli(["backup", backup]);

    const { default: Database } = await import("better-sqlite3");
    const holder = new Database(process.env.SYNAPSE_DB!); // simulates a running MCP server
    holder.pragma("journal_mode = WAL");
    try {
      logs.length = 0;
      await runCli(["restore", backup, "--force"]);
      assert.equal(process.exitCode, 1, "restore must refuse under a live holder");
      assert.ok(!logs.join("\n").includes("Restored"), "must not report success");
    } finally {
      process.exitCode = 0;
      holder.close();
    }

    // Holder gone → the same restore succeeds.
    logs.length = 0;
    await runCli(["restore", backup, "--force"]);
    assert.ok(logs.join("\n").includes("Restored"));
  });

  it("decay sweeps expired memories without a live MCP server", async () => {
    const { MemoryRepository } = await import("@synapse/store");
    const repo = new MemoryRepository({ path: process.env.SYNAPSE_DB! });
    const stale = repo.create({
      userId: "local", type: "working", content: "task from last week",
      retention: { mode: "ttl", expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    repo.close();

    await runCli(["decay"]);
    const res = JSON.parse(logs.join("\n"));
    assert.equal(res.expired, 1);

    logs.length = 0;
    await runCli(["get", stale.id]);
    assert.equal(JSON.parse(logs.join("\n")).status, "archived");
  });

  it("export lists what remember stored", async () => {
    await runCli(["remember", "procedural", "Always run tests before committing"]);
    logs.length = 0;
    await runCli(["export"]);
    const dump = JSON.parse(logs.join("\n"));
    assert.equal(dump.memories.length, 1);
  });
});
