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
    writeFileSync(
      path,
      `const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
console.log(JSON.stringify({ argv: process.argv.slice(2), stdin }));`,
    );
    return path;
  };

  it("passes system prompt via --append-system-prompt, user prompt via stdin, returns stdout", async () => {
    const llm = new ClaudeCliLlm({ model: "haiku", cmd: [process.execPath, stub()] });
    const out = JSON.parse(await llm.complete("SYS PROMPT", "USER PROMPT"));
    assert.equal(out.stdin, "USER PROMPT");
    assert.ok(out.argv.includes("-p"));
    const mi = out.argv.indexOf("--model");
    assert.equal(out.argv[mi + 1], "haiku");
    const si = out.argv.indexOf("--append-system-prompt");
    assert.equal(out.argv[si + 1], "SYS PROMPT");
  });

  it("rejects when the binary exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-cli-llm-"));
    const bad = join(dir, "bad.js");
    writeFileSync(bad, `process.exit(1);`);
    const llm = new ClaudeCliLlm({ cmd: [process.execPath, bad] });
    await assert.rejects(() => llm.complete("s", "u"));
  });
});
