/**
 * Merge one round's shard results into a single record, append it to the round
 * history, and print the per-category table against the published Zep numbers.
 * Invoked by bench-round.sh; env: LABEL, SPLIT, ELAPSED, ROUNDS.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const { LABEL, SPLIT, ELAPSED, ROUNDS } = process.env;
const dir = join(ROUNDS, LABEL);

// The bar: highest published per-category number across competing memory systems
// (packages/evals/data/baselines.json — collected, sourced, and caveated there).
// Only `comparable: true` entries count: recall@k and oracle-split numbers are
// real but measure something else, so they cannot be a target for accuracy.
const BASELINES = JSON.parse(
  readFileSync(new URL("../packages/evals/data/baselines.json", import.meta.url), "utf8"),
);
const CATS = BASELINES.categories;
const RIVALS = BASELINES.providers.filter((p) => p.comparable && p.overall !== null);
const bestIn = (cat) =>
  RIVALS.reduce(
    (best, p) => (p.byCategory?.[cat] != null && p.byCategory[cat] > (best.score ?? -1)
      ? { score: p.byCategory[cat], who: p.name } : best),
    { score: null, who: null },
  );
const BAR = Object.fromEntries(CATS.map((c) => [c, bestIn(c)]));
const BAR_OVERALL = RIVALS.reduce((b, p) => (p.overall > (b.score ?? -1) ? { score: p.overall, who: p.name } : b), { score: null, who: null });

const shards = readdirSync(dir)
  .filter((f) => f.startsWith("shard") && f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
if (!shards.length) throw new Error(`No shard results in ${dir}`);

const byType = {};
const records = [];
let total = 0;
let correct = 0;
let errors = 0;
for (const s of shards) {
  for (const [t, v] of Object.entries(s.byType)) {
    byType[t] ??= { total: 0, correct: 0 };
    byType[t].total += v.total;
    byType[t].correct += v.correct;
  }
  total += s.overall.total;
  correct += s.overall.correct;
  errors += s.errors ?? 0;
  records.push(...(s.records ?? []));
}
for (const v of Object.values(byType)) v.accuracy = v.correct / v.total;

// A round that lost questions is not a smaller round, it is a different one:
// errors are not distributed evenly across categories, so the survivors are a
// biased sample. This actually happened — 143 of 169 questions failed on a
// transient CLI error and the remaining 26 merged cleanly as "96.2%", above
// every published system. Refuse rather than record. ERRORS_OK=1 to override
// for a deliberately partial diagnostic run.
const errRate = errors / (total + errors);
if (errors > 0 && errRate > 0.02 && !process.env.ERRORS_OK) {
  console.error(
    `\nREFUSING TO RECORD: ${errors} of ${total + errors} questions errored (${(errRate * 100).toFixed(1)}%).\n` +
      `The ${total} that survived are a biased sample, not a smaller benchmark.\n` +
      `Fix the cause and re-run (--resume keeps completed questions), or set ERRORS_OK=1 to record it anyway.`,
  );
  process.exit(1);
}

const round = {
  label: LABEL,
  split: SPLIT,
  // NOTE= one line on what changed this round. A score jump that came from a
  // harness/judge fix must not read as a retrieval win on the progress page.
  note: process.env.NOTE || null,
  elapsedSec: Number(ELAPSED),
  config: shards[0].config,
  overall: { total, correct, accuracy: total ? correct / total : 0 },
  byType,
  errors,
};
writeFileSync(join(dir, "merged.json"), JSON.stringify({ ...round, records }, null, 2));

const histPath = join(ROUNDS, "history.json");
const history = existsSync(histPath) ? JSON.parse(readFileSync(histPath, "utf8")) : [];
// Re-running a label replaces its entry rather than duplicating it.
const idx = history.findIndex((r) => r.label === LABEL && r.split === SPLIT);
if (idx >= 0) history[idx] = round;
else history.push(round);
writeFileSync(histPath, JSON.stringify(history, null, 2));

const pct = (n) => (n * 100).toFixed(1).padStart(5) + "%";
console.log(`\n== ${LABEL} (${SPLIT}) — ${total} questions, ${ELAPSED}s${errors ? `, ${errors} errors` : ""}`);
console.log(`${"category".padEnd(28)} ${"synapse".padStart(6)} ${"bar".padStart(6)} ${"delta".padStart(7)}  n     held by`);
let losing = [];
for (const cat of CATS) {
  const v = byType[cat];
  if (!v) continue;
  const { score, who } = BAR[cat];
  // A category with no published number anywhere cannot be won or lost — print
  // the score and say so rather than inventing a target.
  if (score === null) {
    console.log(`${cat.padEnd(28)} ${pct(v.accuracy)} ${"   n/a"} ${"      -"}`.padEnd(58) + `  ${v.correct}/${v.total}  (unpublished by all)`);
    continue;
  }
  const d = v.accuracy - score;
  if (d < 0) losing.push({ cat, delta: d, n: v.total, who });
  console.log(
    `${cat.padEnd(28)} ${pct(v.accuracy)} ${pct(score)} ${(d >= 0 ? "+" : "") + (d * 100).toFixed(1) + "pp"}`.padEnd(58) +
      `  ${v.correct}/${v.total}  ${who}`,
  );
}
const od = round.overall.accuracy - BAR_OVERALL.score;
console.log(
  `${"OVERALL".padEnd(28)} ${pct(round.overall.accuracy)} ${pct(BAR_OVERALL.score)} ${(od >= 0 ? "+" : "") + (od * 100).toFixed(1) + "pp"}`.padEnd(58) +
    `  ${correct}/${total}  ${BAR_OVERALL.who}`,
);

losing.sort((a, b) => a.delta - b.delta);
console.log(
  losing.length
    ? `\nLosing in ${losing.length}: ` +
        losing.map((l) => `${l.cat} (${(l.delta * 100).toFixed(1)}pp vs ${l.who}, n=${l.n})`).join(", ")
    : "\nBeating every published number in every category present.",
);
console.log(`\nmerged -> ${join(dir, "merged.json")}\nhistory -> ${histPath}`);
