import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { judgePrompt } from "./judge-prompts.js";

const q = (id: string, type: string) => ({
  question_id: id,
  question_type: type,
  question: "Q?",
  answer: "GOLD",
});

describe("judgePrompt", () => {
  it("dispatches per question type, with _abs winning over the type", () => {
    // Abstention: the old prompt asked "does this decline to answer" and Sonnet
    // answered no to explicit refusals — score was 0/7.
    assert.match(judgePrompt(q("x_abs", "single-session-user"), "R"), /unanswerable/);
    // Preference gold is a rubric, not a fact list.
    const pref = judgePrompt(q("x", "single-session-preference"), "R");
    assert.match(pref, /Rubric: GOLD/);
    assert.doesNotMatch(pref, /Correct Answer/);
    assert.match(judgePrompt(q("x", "temporal-reasoning"), "R"), /off-by-one/);
    assert.match(judgePrompt(q("x", "knowledge-update"), "R"), /updated answer/);
    assert.match(judgePrompt(q("x", "multi-session"), "R"), /Correct Answer: GOLD/);
    // No upstream prompt for engram's own types: prior wording kept.
    assert.match(judgePrompt(q("x", "fact-recall"), "R"), /contain the key facts/);
  });
});

describe("--rejudge", () => {
  it("re-scores records from a results JSON without retrieval or answering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rejudge-"));
    const inPath = join(dir, "shard0.json");
    writeFileSync(
      inPath,
      JSON.stringify({
        variant: "dev0",
        split: "dev",
        config: { minScore: 0.4, top: 50, rerank: true, model: "sonnet", judgeModel: null },
        records: [
          { question_id: "a_abs", question_type: "abstention", question: "Q1", gold: "G1", hypothesis: "H1", correct: false },
          { question_id: "b", question_type: "multi-session", question: "Q2", gold: "G2", hypothesis: "H2", correct: true },
        ],
      }),
    );

    const prompts: string[] = [];
    const replies = ["Yes", "no"];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        prompts.push(JSON.parse(body).messages.at(-1).content);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: replies[prompts.length - 1] ?? "no" } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    try {
      const { stdout } = await promisify(execFile)(
        "node",
        ["--import", "tsx", join(import.meta.dirname, "longmemeval.ts"), "--rejudge", inPath],
        {
          env: {
            ...process.env,
            // HOME: keeps the run out of the user's real ~/.synapse/bench.
            HOME: dir,
            SYNAPSE_LLM_PROVIDER: "openai",
            SYNAPSE_LLM_BASE_URL: `http://127.0.0.1:${port}`,
            SYNAPSE_LLM_API_KEY: "test",
          },
        },
      );
      assert.match(stdout, /OVERALL/);
      // One judge call per record and nothing else: proof the answerer never ran.
      assert.equal(prompts.length, 2);
      assert.match(prompts[0]!, /unanswerable/);
      // Prefix, not suffix: bench-merge.mjs globs shard*.json and would merge
      // a "shard0.rejudged.json" as an extra shard, double-counting records.
      assert.equal(existsSync(join(dir, "shard0.rejudged.json")), false);
      const out = JSON.parse(readFileSync(join(dir, "rejudged-shard0.json"), "utf8"));
      assert.equal(out.variant, "dev0");
      assert.equal(out.split, "dev");
      // Retrieval config carried from the input, not this process's defaults.
      assert.equal(out.config.top, 50);
      assert.equal(out.config.rerank, true);
      assert.equal(out.config.minScore, 0.4);
      assert.deepEqual(out.byType, {
        abstention: { total: 1, correct: 1, accuracy: 1 },
        "multi-session": { total: 1, correct: 0, accuracy: 0 },
      });
      assert.equal(out.overall.accuracy, 0.5);
      assert.equal(out.records[0].correct, true);
      assert.equal(out.records[1].correct, false);
    } finally {
      server.close();
    }
  });
});
