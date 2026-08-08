import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliLlm } from "./llm.js";

describe("ClaudeCliLlm", () => {
  // Stub binary standing in for `claude`: prints its argv and stdin so the
  // test can verify how the prompt is delivered. Real code, no mocks — the
  // only faked thing is the external binary, which is the unavoidable boundary.
  const stub = () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-cli-llm-"));
    const path = join(dir, "stub.js");
    writeFileSync(path, `console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));`);
    return path;
  };

  it("fully overrides the system prompt, passes user prompt as positional arg, runs outside any project dir", async () => {
    const llm = new ClaudeCliLlm({ model: "haiku", cmd: [process.execPath, stub()] });
    const out = JSON.parse(await llm.complete("SYS PROMPT", "USER PROMPT"));
    assert.equal(out.argv[out.argv.length - 1], "USER PROMPT");
    assert.ok(out.argv.includes("-p"));
    const mi = out.argv.indexOf("--model");
    assert.equal(out.argv[mi + 1], "haiku");
    // Full --system-prompt override, NOT --append-system-prompt: the CLI's
    // coding-agent framing (project context, hooks) intermittently hijacked
    // the session role when memory content looked like a task request.
    const si = out.argv.indexOf("--system-prompt");
    assert.equal(out.argv[si + 1], "SYS PROMPT");
    assert.ok(!out.argv.includes("--append-system-prompt"));
    // Neutral cwd: no repo, no git status, no CLAUDE.md leaking into answers.
    assert.notEqual(out.cwd, process.cwd());
  });

  it("rejects when the binary exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-cli-llm-"));
    const bad = join(dir, "bad.js");
    writeFileSync(bad, `process.exit(1);`);
    const llm = new ClaudeCliLlm({ cmd: [process.execPath, bad] });
    await assert.rejects(() => llm.complete("s", "u"));
  });
});
