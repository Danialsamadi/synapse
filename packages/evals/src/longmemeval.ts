/**
 * LongMemEval harness (xiaowu0162/longmemeval, MIT): ingest each question's
 * timestamped sessions into a fresh Synapse store, retrieve, answer with the
 * configured LLM, judge, and print per-ability accuracy.
 *
 * Usage: pnpm --filter @synapse/evals longmemeval [--limit N] [--variant oracle|s|engram]
 *        [--min-score 0.25] [--judge] [--rerank]
 *        pnpm --filter @synapse/evals longmemeval --rejudge <results.json> [--judge-model M]
 *          — re-judge an existing run's records only; writes rejudged-<file>.
 * Env:   SYNAPSE_LLM_API_KEY (+ optional SYNAPSE_LLM_BASE_URL / SYNAPSE_LLM_MODEL),
 *        SYNAPSE_EMBED_PROVIDER (default local)
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { MemoryRepository, RetrievalService, writeMemory, createEmbedder, createLlm } from "@synapse/store";
import { DEFAULT_RANK_WEIGHTS } from "@synapse/core";
import { judgePrompt, type JudgeInput } from "./judge-prompts.js";

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

/**
 * LongMemEval stamps dates as "2023/05/30 (Tue) 20:36". Keep the time — a
 * same-day window ("yesterday") is a real boundary — and drop the day name,
 * which no Date parser is required to accept. Falls back to the raw string so a
 * malformed stamp degrades to the previous behaviour instead of throwing.
 */
function isoDate(stamp: string): string {
  const m = stamp.match(/^(\d{4})\/(\d{2})\/(\d{2})(?:[^\d]*(\d{2}):(\d{2}))?/);
  if (!m) return stamp;
  const [, y, mo, d, hh, mm] = m;
  return `${y}-${mo}-${d}T${hh ?? "00"}:${mm ?? "00"}:00`;
}

async function answerQuestion(q: LmeQuestion, minScore: number, dryRun: boolean, rerank: boolean, top: number): Promise<string> {
  const repo = new MemoryRepository({ path: ":memory:" });
  const embedder = createEmbedder();
  // DIAGNOSTIC ONLY. Anchoring retrieval to the question's date switched decay
  // on: it had been inert while every memory's eventTime was the run time. With
  // a 30-day episodic half-life over a ~6-month haystack it now spans 0.086 of
  // score — comparable to a 21.5% swing in cosine similarity. --decay-weight
  // isolates how much of a round is that pressure. It is a measurement handle,
  // not a tuning knob: a weight fitted to the dev split is not a product change.
  const decayWeight = arg("decay-weight");
  const weights = decayWeight === undefined ? undefined : { ...DEFAULT_RANK_WEIGHTS, decay: Number(decayWeight) };
  const retrieval = new RetrievalService(repo, embedder, weights, rerank ? createLlm() : undefined);
  try {
    for (let s = 0; s < q.haystack_sessions.length; s++) {
      const date = q.haystack_dates[s] ?? "";
      for (const turn of q.haystack_sessions[s]!) {
        if (!turn.content?.trim()) continue;
        await writeMemory(repo, embedder, {
          userId: "local",
          type: "episodic",
          content: `[${date}] ${turn.role}: ${turn.content}`,
          // Event time, not write time. Without this every memory's eventTime()
          // fell back to createdAt (today), so a date-filtered query could not
          // match anything from 2023 — measured as 7 dev questions retrieving
          // literally zero memories. "manual" keeps default confidence at 0.9:
          // other kinds drop it to 0.7, which would shift every score against
          // an absolute minScore gate and confound the change being measured.
          sourceRefs: [{ kind: "manual", id: `s${s}`, observedAt: isoDate(date) }],
          // No session tags: measured 80% -> 76% with them — the group boost
          // rewards same-session redundancy where these questions need
          // cross-session diversity (knowledge-update fell 100 -> 60).
        });
      }
    }
    const { memories } = await retrieval.retrieve({
      query: q.question,
      userId: "local",
      limit: top,
      minScore,
      // Ask the question as of its own date: "10 days ago" has to resolve
      // against 2023, not against whenever the benchmark happens to run.
      now: isoDate(q.question_date),
      ...(rerank ? { rerank: true } : {}),
    });
    if (dryRun) {
      return `[dry-run] retrieved ${memories.length} memories; top: ${memories[0]?.content.slice(0, 80) ?? "(none)"}`;
    }
    const llm = createLlm();
    const context = memories.map((m) => m.content).join("\n---\n");
    return await llm.complete(
      "You answer questions about a user based ONLY on retrieved conversation memories. " +
        // Grounding: memories are raw turns that rarely name the project; without
        // this line models refuse ("Arclight isn't mentioned") on evidence in hand.
        "The memories are excerpts from the user's own past conversations about their project; " +
        "a project name in the question refers to that project even if the memories never name it. " +
        "Each memory is prefixed with its date. Today's date for the question is " +
        `${q.question_date}. ` +
        // Completeness: "one short sentence" forced detail-dropping on multi-part
        // questions and the judge failed them for it (misses #7/#27/#30/#34).
        "Answer concisely but completely — include every distinct detail the memories support. " +
        "State the answer directly; do not hedge or ask follow-up questions. " +
        // Calibrated abstention: a strict "reply exactly I don't know" makes
        // cautious models abstain on partial evidence and tanks the score;
        // measured Sonnet 40% vs Haiku 74% on identical retrieval.
        "Reasonable inference from the memories is fine. " +
        "Only reply exactly: I don't know — if nothing relevant was retrieved.",
      `Memories:\n${context || "(none retrieved)"}\n\nQuestion: ${q.question}`,
    );
  } finally {
    repo.close();
  }
}

// --judge-model splits the judge from the answerer (e.g. Sonnet judging Haiku
// answers). createLlm() reads env at call time, so swap the model around it.
function createJudgeLlm() {
  const judgeModel = arg("judge-model");
  if (!judgeModel) return createLlm();
  const prev = process.env.SYNAPSE_LLM_MODEL;
  process.env.SYNAPSE_LLM_MODEL = judgeModel;
  try {
    return createLlm();
  } finally {
    if (prev === undefined) delete process.env.SYNAPSE_LLM_MODEL;
    else process.env.SYNAPSE_LLM_MODEL = prev;
  }
}

// LongMemEval marks abstention questions with an "_abs" question_id suffix —
// question_type stays the base category. Keying off question_type (as this did)
// matched nothing, so abstention questions were graded as ordinary recall.
const isAbstention = (q: LmeQuestion): boolean => q.question_id.endsWith("_abs");
/** Abstention is scored and reported as its own category, not folded into the base type. */
const catOf = (q: LmeQuestion): string => (isAbstention(q) ? "abstention" : q.question_type);

async function judge(q: JudgeInput, hypothesis: string): Promise<boolean> {
  const llm = createJudgeLlm();
  // Upstream sends one user turn and no system message; complete() requires a
  // system arg, so it is empty. Decision rule is upstream's: 'yes' in lower().
  const verdict = await llm.complete("", judgePrompt(q, hypothesis));
  // Upstream's rule is `'yes' in verdict.lower()`, which is safe when the judge
  // emits a bare token. Ours often doesn't — measured 12/68 verdicts came back
  // as "No.\n\nThe model response ..." prose — and any such explanation that
  // quotes the word "yes" flips the verdict. Anchoring on the leading token
  // agreed with the loose rule on all 68 sampled verdicts, so this changes no
  // measured number; it removes a latent one-word flip.
  return /^\s*\**\s*yes\b/i.test(verdict);
}

// --rejudge <results.json> re-runs ONLY the judge over an existing run's
// records (from --out or scripts/bench-merge.mjs merged.json). No retrieval, no
// answerer. let: variant/split are reseeded from the input file below.
const rejudgePath = arg("rejudge");
let variant = arg("variant") ?? "oracle";
const limit = Number(arg("limit") ?? Infinity);
const minScore = Number(arg("min-score") ?? 0.25);
const runJudge = process.argv.includes("--judge") || !!rejudgePath;
const dryRun = process.argv.includes("--dry-run");
const rerank = process.argv.includes("--rerank");
// Retrieval depth: measured +10pp overall going 15 → 30 (see BENCHMARKS.md).
const top = Number(arg("top") ?? 30);
process.env.SYNAPSE_EMBED_PROVIDER ??= "local";

// --only qid1,qid2 reruns specific questions (diagnostic scoped tests).
const only = arg("only")?.split(",");
// --split dev|holdout enforces the frozen tuning/clean-room boundary
// (packages/evals/data/longmemeval-split.json). Tune on dev; holdout is
// measured once, at the end, and never tuned against.
let splitName = arg("split");
let splitIds: Set<string> | undefined;
if (splitName) {
  const splitFile = new URL("../data/longmemeval-split.json", import.meta.url);
  const split = JSON.parse(readFileSync(splitFile, "utf8")) as Record<string, string[]>;
  if (!Array.isArray(split[splitName])) throw new Error(`Unknown split: ${splitName}`);
  splitIds = new Set(split[splitName]);
}
// --shard i/n splits the run across parallel processes. Round-robin (not
// contiguous) so every shard gets the same category mix.
const shardArg = arg("shard");
const [shardIdx, shardCount] = shardArg ? shardArg.split("/").map(Number) : [0, 1];

const questions = rejudgePath
  ? []
  : (await loadDataset(variant))
      .filter((q) => !only || only.includes(q.question_id))
      .filter((q) => !splitIds || splitIds.has(q.question_id))
      .filter((_, i) => shardCount! <= 1 || i % shardCount! === shardIdx!)
      .slice(0, limit);
if (!rejudgePath)
  console.log(
    `LongMemEval ${variant}: ${questions.length} questions, minScore=${minScore}` +
      `${splitName ? `, split=${splitName}` : ""}${shardArg ? `, shard=${shardArg}` : ""}`,
  );

const outDir = join(homedir(), ".synapse", "bench");
// Shard suffix: parallel shards must not clobber each other's hypotheses.
const shardTag = shardArg ? `_shard${shardIdx}of${shardCount}` : "";
const hypPath = join(outDir, `hypotheses_${variant}${splitName ? `_${splitName}` : ""}${shardTag}.jsonl`);
const lines: string[] = [];
const records: Record<string, unknown>[] = [];
const byType = new Map<string, { total: number; correct: number }>();
// Rejudge writes beside its input by default — never over it, so old and new
// verdicts stay diffable. "rejudged-" as a PREFIX, not a suffix: bench-merge.mjs
// globs shard*.json, and shard0.rejudged.json would be merged as a second shard.
const outPath =
  arg("out") ?? (rejudgePath ? join(dirname(rejudgePath), `rejudged-${basename(rejudgePath)}`) : undefined);
let errors = 0;
// Reseeded from the input file on --rejudge: a rejudged round must not claim
// this process's retrieval settings (bench-merge.mjs copies config into history.json).
let config: Record<string, unknown> = { minScore, top, rerank, model: process.env.SYNAPSE_LLM_MODEL ?? null, judgeModel: arg("judge-model") ?? null };

// Resume: a run interrupted at question 80 of 85 used to lose all 80. Reload
// prior records from --out, skip those questions, and keep their verdicts.
const done = new Set<string>();
if (outPath && process.argv.includes("--resume") && existsSync(outPath)) {
  const prior = JSON.parse(readFileSync(outPath, "utf8")) as { records?: { question_id: string; question_type: string; correct: boolean }[] };
  for (const r of prior.records ?? []) {
    done.add(r.question_id);
    records.push(r);
    const t = byType.get(r.question_type) ?? { total: 0, correct: 0 };
    t.total++;
    if (r.correct) t.correct++;
    byType.set(r.question_type, t);
  }
  if (done.size) console.log(`Resuming: ${done.size} question(s) already done, skipping.`);
}

/** Write results after every question so an interrupted run keeps its work. */
function flush(): void {
  if (!outPath) return;
  let total = 0;
  let correct = 0;
  for (const v of byType.values()) {
    total += v.total;
    correct += v.correct;
  }
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        variant,
        split: splitName ?? null,
        shard: shardArg ?? null,
        config,
        overall: { total, correct, accuracy: total ? correct / total : 0 },
        byType: Object.fromEntries(
          [...byType.entries()].sort().map(([k, v]) => [k, { ...v, accuracy: v.correct / v.total }]),
        ),
        errors,
        records,
      },
      null,
      2,
    ),
  );
}

if (rejudgePath) {
  const prior = JSON.parse(readFileSync(rejudgePath, "utf8")) as {
    variant?: string;
    split?: string | null;
    config?: Record<string, unknown>;
    records?: { question_id: string; question_type: string; question: string; gold: string; hypothesis: string }[];
  };
  variant = prior.variant ?? variant;
  splitName = prior.split ?? splitName;
  // Retrieval settings come from the original run; only the judge model is ours.
  if (prior.config) config = { ...prior.config, judgeModel: arg("judge-model") ?? null };
  const prev = prior.records ?? [];
  console.log(`Rejudging ${prev.length} record(s) from ${rejudgePath}`);
  for (let i = 0; i < prev.length; i++) {
    const r = prev[i]!;
    // question_type is already catOf(): "abstention" for _abs ids. judgePrompt
    // keys abstention off the id, so the stored type stays the reporting key.
    try {
      const ok = await judge({ ...r, answer: r.gold }, r.hypothesis);
      const t = byType.get(r.question_type) ?? { total: 0, correct: 0 };
      t.total++;
      if (ok) t.correct++;
      byType.set(r.question_type, t);
      records.push({ ...r, correct: ok });
      flush();
      console.log(`[${i + 1}/${prev.length}] ${r.question_type}${ok ? " ✓" : " ✗"}`);
    } catch (err) {
      // Same rule as the main loop: one API error must not discard the batch.
      errors++;
      console.log(`[${i + 1}/${prev.length}] ${r.question_type} ERR: ${(err as Error).message.slice(0, 120)}`);
    }
  }
}

for (let i = 0; i < questions.length; i++) {
  const q = questions[i]!;
  if (done.has(q.question_id)) continue;
  // A single API error (quota, rate limit, timeout) must not discard the whole
  // run: record it, keep going, and still write hypotheses + print the table.
  try {
    const hypothesis = await answerQuestion(q, minScore, dryRun, rerank, top);
    lines.push(JSON.stringify({ question_id: q.question_id, hypothesis }));
    let verdict = "";
    if (runJudge) {
      const ok = await judge(q, hypothesis);
      const t = byType.get(catOf(q)) ?? { total: 0, correct: 0 };
      t.total++;
      if (ok) t.correct++;
      byType.set(catOf(q), t);
      verdict = ok ? " ✓" : " ✗";
      // Gold + hypothesis on every record: a critic diagnosing a category needs
      // to read the actual misses, not just the score.
      records.push({
        question_id: q.question_id,
        question_type: catOf(q),
        question: q.question,
        gold: q.answer,
        hypothesis,
        correct: ok,
      });
      flush();
    }
    console.log(`[${i + 1}/${questions.length}] ${q.question_type}${verdict}`);
  } catch (err) {
    errors++;
    console.log(`[${i + 1}/${questions.length}] ${q.question_type} ERR: ${(err as Error).message.slice(0, 120)}`);
  }
}
if (errors > 0) console.log(`\n${errors} question(s) errored and were skipped.`);

// Rejudge produced no hypotheses — writing here would clobber the real run's file.
if (!rejudgePath) {
  writeFileSync(hypPath, lines.join("\n") + "\n");
  console.log(`\nHypotheses written to ${hypPath} (compatible with upstream evaluate_qa.py)`);
}

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

  // --out writes machine-readable results so a critic can merge shards and
  // diff rounds without re-parsing stdout.
  if (outPath) {
    flush();
    console.log(`Results JSON written to ${outPath}`);
  }
}
