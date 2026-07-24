/**
 * LongMemEval harness (xiaowu0162/longmemeval, MIT): ingest each question's
 * timestamped sessions into a fresh Synapse store, retrieve, answer with the
 * configured LLM, judge, and print per-ability accuracy.
 *
 * Usage: pnpm --filter @synapse/evals longmemeval [--limit N] [--variant oracle|s|engram]
 *        [--min-score 0.25] [--judge]
 * Env:   SYNAPSE_LLM_API_KEY (+ optional SYNAPSE_LLM_BASE_URL / SYNAPSE_LLM_MODEL),
 *        SYNAPSE_EMBED_PROVIDER (default local)
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryRepository, RetrievalService, writeMemory, createEmbedder, createLlm } from "@synapse/store";

const DATA_URLS: Record<string, string> = {
  oracle:
    "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json",
  s: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
  // engram-v3 (MIT): same schema as LongMemEval (inline haystack_sessions), 50-task CI smoke test.
  engram: "https://huggingface.co/datasets/matthewschramm/engram-v3/resolve/main/engram-v3-test.json",
};

interface LmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_sessions: { role: string; content: string }[][];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadDataset(variant: string): Promise<LmeQuestion[]> {
  const dir = join(homedir(), ".synapse", "bench");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `longmemeval_${variant}.json`);
  if (!existsSync(file)) {
    console.log(`Downloading LongMemEval ${variant} dataset...`);
    const res = await fetch(DATA_URLS[variant]!);
    if (!res.ok) throw new Error(`Dataset download failed: ${res.status} ${res.statusText}`);
    writeFileSync(file, await res.text());
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

async function answerQuestion(q: LmeQuestion, minScore: number, dryRun: boolean): Promise<string> {
  const repo = new MemoryRepository({ path: ":memory:" });
  const embedder = createEmbedder();
  const retrieval = new RetrievalService(repo, embedder);
  try {
    for (let s = 0; s < q.haystack_sessions.length; s++) {
      const date = q.haystack_dates[s] ?? "";
      for (const turn of q.haystack_sessions[s]!) {
        if (!turn.content?.trim()) continue;
        await writeMemory(repo, embedder, {
          userId: "local",
          type: "episodic",
          content: `[${date}] ${turn.role}: ${turn.content}`,
        });
      }
    }
    const { memories } = await retrieval.retrieve({
      query: q.question,
      userId: "local",
      limit: 15,
      minScore,
    });
    if (dryRun) {
      return `[dry-run] retrieved ${memories.length} memories; top: ${memories[0]?.content.slice(0, 80) ?? "(none)"}`;
    }
    const llm = createLlm();
    const context = memories.map((m) => m.content).join("\n---\n");
    return await llm.complete(
      "You answer questions about a user based ONLY on retrieved conversation memories. " +
        "Each memory is prefixed with its date. Today's date for the question is " +
        `${q.question_date}. Be concise — answer in one short sentence. ` +
        "If the memories do not contain the answer, reply exactly: I don't know.",
      `Memories:\n${context || "(none retrieved)"}\n\nQuestion: ${q.question}`,
    );
  } finally {
    repo.close();
  }
}

async function judge(q: LmeQuestion, hypothesis: string): Promise<boolean> {
  const llm = createLlm();
  if (q.question_type.includes("abs")) {
    // Abstention questions: correct = the system declines to answer.
    const verdict = await llm.complete(
      "Reply yes or no only.",
      `Does this response decline to answer / say the information is unavailable?\nResponse: ${hypothesis}`,
    );
    return verdict.toLowerCase().includes("yes");
  }
  const verdict = await llm.complete(
    "You judge answer correctness. Reply yes or no only.",
    `Question: ${q.question}\nGold answer: ${q.answer}\nModel answer: ${hypothesis}\n` +
      "Is the model answer correct (semantically equivalent to the gold answer)?",
  );
  return verdict.toLowerCase().includes("yes");
}

const variant = arg("variant") ?? "oracle";
const limit = Number(arg("limit") ?? Infinity);
const minScore = Number(arg("min-score") ?? 0.25);
const runJudge = process.argv.includes("--judge");
const dryRun = process.argv.includes("--dry-run");
process.env.SYNAPSE_EMBED_PROVIDER ??= "local";

const questions = (await loadDataset(variant)).slice(0, limit);
console.log(`LongMemEval ${variant}: ${questions.length} questions, minScore=${minScore}`);

const outDir = join(homedir(), ".synapse", "bench");
const hypPath = join(outDir, `hypotheses_${variant}.jsonl`);
const lines: string[] = [];
const byType = new Map<string, { total: number; correct: number }>();

let errors = 0;
for (let i = 0; i < questions.length; i++) {
  const q = questions[i]!;
  // A single API error (quota, rate limit, timeout) must not discard the whole
  // run: record it, keep going, and still write hypotheses + print the table.
  try {
    const hypothesis = await answerQuestion(q, minScore, dryRun);
    lines.push(JSON.stringify({ question_id: q.question_id, hypothesis }));
    let verdict = "";
    if (runJudge) {
      const ok = await judge(q, hypothesis);
      const t = byType.get(q.question_type) ?? { total: 0, correct: 0 };
      t.total++;
      if (ok) t.correct++;
      byType.set(q.question_type, t);
      verdict = ok ? " ✓" : " ✗";
    }
    console.log(`[${i + 1}/${questions.length}] ${q.question_type}${verdict}`);
  } catch (err) {
    errors++;
    console.log(`[${i + 1}/${questions.length}] ${q.question_type} ERR: ${(err as Error).message.slice(0, 120)}`);
  }
}
if (errors > 0) console.log(`\n${errors} question(s) errored and were skipped.`);

writeFileSync(hypPath, lines.join("\n") + "\n");
console.log(`\nHypotheses written to ${hypPath} (compatible with upstream evaluate_qa.py)`);

if (runJudge) {
  let total = 0;
  let correct = 0;
  console.log("\nAccuracy by question type:");
  for (const [type, t] of [...byType.entries()].sort()) {
    console.log(`  ${type.padEnd(28)} ${((t.correct / t.total) * 100).toFixed(1)}%  (${t.correct}/${t.total})`);
    total += t.total;
    correct += t.correct;
  }
  console.log(`  ${"OVERALL".padEnd(28)} ${((correct / total) * 100).toFixed(1)}%  (${correct}/${total})`);
}
