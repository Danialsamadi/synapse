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

  it("export lists what remember stored", async () => {
    await runCli(["remember", "procedural", "Always run tests before committing"]);
    logs.length = 0;
    await runCli(["export"]);
    const dump = JSON.parse(logs.join("\n"));
    assert.equal(dump.memories.length, 1);
  });
});
