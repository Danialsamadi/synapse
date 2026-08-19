/**
 * Pre-slice a LongMemEval dataset into per-shard files so parallel benchmark
 * shards each parse ~1/N of the data. The full _s file is 277MB and parses to
 * multiple GB in V8 — on an 8GB machine that caps you at one shard. Slicing
 * first is what makes parallelism affordable.
 *
 * Writes ~/.synapse/bench/longmemeval_<split><i>.json, consumable directly as
 * `longmemeval --variant <split><i>` (loadDataset prefers an existing file).
 *
 * Usage: pnpm --filter @synapse/evals shard --split dev --shards 6
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const splitName = arg("split") ?? "dev";
const shards = Number(arg("shards") ?? 6);
const dir = join(homedir(), ".synapse", "bench");
const source = join(dir, `longmemeval_${arg("variant") ?? "s"}.json`);
if (!existsSync(source)) throw new Error(`Missing dataset: ${source}`);

const splitFile = new URL("../data/longmemeval-split.json", import.meta.url);
const split = JSON.parse(readFileSync(splitFile, "utf8")) as Record<string, string[]>;
const ids = split[splitName];
if (!Array.isArray(ids)) throw new Error(`Unknown split: ${splitName}`);
const idSet = new Set(ids);

console.log(`Parsing ${source} ...`);
const all = JSON.parse(readFileSync(source, "utf8")) as { question_id: string; question_type: string }[];
const picked = all.filter((q) => idSet.has(q.question_id));
console.log(`${splitName}: ${picked.length} questions -> ${shards} shards`);

for (let i = 0; i < shards; i++) {
  // Round-robin so every shard gets the same category mix.
  const slice = picked.filter((_, idx) => idx % shards === i);
  const out = join(dir, `longmemeval_${splitName}${i}.json`);
  writeFileSync(out, JSON.stringify(slice));
  const cats = new Set(slice.map((q) => q.question_type));
  console.log(`  shard ${i}: ${slice.length} questions, ${cats.size} categories -> ${out}`);
}
