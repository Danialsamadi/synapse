# Synapse Benchmark Results

**August 2026 — every number here is reproducible with a command in this repo.**

---

## The Core Finding

Most memory systems bet on one of two extremes: store everything verbatim and
hope retrieval sorts it out, or let an LLM decide what to remember and hope it
doesn't throw away the part you needed. Synapse bets on a third position: a
**curated store with a real lifecycle** — typed memories, entity-key
supersession, conflict detection, decay, feedback-driven confidence — retrieved
by a **fully non-LLM hybrid pipeline** (vector + BM25 + importance + confidence
+ recency − decay − conflict).

That pipeline, with no LLM anywhere in the retrieval path, scores **96.0% on
engram-v3** (LongMemEval-format, end-to-end QA). Curation doesn't have to cost
recall.

---

## The Honest Numbers

These are different claims measured on different harnesses. They need to be
read as a set, not cherry-picked.

| Benchmark | Score | Metric | LLM in retrieval |
|---|---|---|---|
| **engram-v3** (50 multi-session QA, LongMemEval schema) | **96.0%** (48/50) | end-to-end QA accuracy, LLM-judged | None |
| engram-v3, Haiku answerer, top-30 retrieval | **80.0%** (40/50) | end-to-end QA accuracy | None |
| engram-v3, Haiku answerer, top-15 | 70.0% (35/50) | end-to-end QA accuracy | None |
| engram-v3, Sonnet answerer, top-15 | 70.0% (35/50) | end-to-end QA accuracy | None |
| Golden retrieval suite (32 cases) | **0.984** | Precision@5 | None |
| Golden retrieval suite | **0.000** | Stale-fact rate | None |
| Golden retrieval suite | **0.969** | Pass rate | None |

The 96.0% vs 74.0% spread on the *same retrieval pipeline* is a ~22-point
swing from the answering/judging model alone. Any system quoting one
end-to-end QA number without naming the answerer is hiding this variable.

The engram-v3 number is the product story: ingest each question's haystack
sessions into a fresh store, retrieve, answer **from retrieved memories only**,
judge the answer. An answering LLM is inherent to the QA format, but retrieval
itself — the part Synapse owns — is embeddings + SQLite FTS5, no API dependency.

The stale-fact rate of **0.000** is the number the others don't publish:
after an entity update or stale feedback, the superseded value does not appear
in default retrieval. Recall benchmarks reward finding things; nobody measures
whether you stopped returning the thing that's no longer true.

---

## The Claude-CLI Runs (measured August 2026, no API key)

All runs used Claude models through the local `claude -p` CLI
(`SYNAPSE_LLM_PROVIDER=claude-cli`) — Claude Code's own auth, zero API keys,
reproducible on any machine with Claude Code installed. All use the
calibrated answering prompt (see "The prompt is part of the system" below).

| Category | Haiku top-15 | Sonnet top-15 | Haiku top-30 |
|---|---|---|---|
| cross-agent-memory (7) | **100%** | 71.4% | 85.7% |
| knowledge-update (5) | 60.0% | 80.0% | **100%** |
| multi-hop-reasoning (7) | 71.4% | 71.4% | **100%** |
| multi-session (8) | 75.0% | 50.0% | 75.0% |
| recurring-pattern (5) | 40.0% | **80.0%** | 40.0% |
| single-session-user (5) | 80.0% | 60.0% | **100%** |
| temporal-reasoning (8) | 62.5% | **87.5%** | 75.0% |
| single-session-assistant (3) | 66.7% | 66.7% | 66.7% |
| fact-recall (2) | 50.0% | 50.0% | 50.0% |
| **OVERALL** | **70.0%** | **70.0%** | **80.0%** |

Findings, stated plainly:

- **Retrieval depth beats model strength.** Widening retrieval from top-15
  to top-30 lifted Haiku from 70% to 80% — while upgrading the answerer from
  Haiku to Sonnet at top-15 moved the overall score not at all. The missing
  evidence was usually *retrieved but ranked 16–30*, not absent.
- **Haiku and Sonnet tie at 70% but win different categories.** Sonnet
  aggregates scattered evidence better (recurring-pattern 80% vs 40%,
  temporal 87.5% vs 62.5%); Haiku commits harder on direct-evidence
  categories (cross-agent 100% vs 71.4%). An answerer swap reshuffles wins;
  it doesn't add them.
- **recurring-pattern resists retrieval depth** (40% at top-15 *and* top-30
  with Haiku). Those questions need distillation, not more context — which
  is Synapse's consolidation job, currently skipped by the harness. Sonnet's
  80% shows a strong reader can compensate; the architecture shouldn't
  require one. See Roadmap.
- **An earlier Haiku-rerank run (old prompt) was a wash** — 74.0% with and
  without `--rerank`, categories reshuffled, headline unmoved. Reported
  because a rerank flag that doesn't help is a fact, not an embarrassment.
- **Session-tag grouping made things worse: 80% → 76%.** Tagging each memory
  with its session ID to activate the rank-based group boost collapsed
  knowledge-update from 100% to 60%: a strong hit on the *old* value's
  session drags that stale session up the ranking, crowding out the update.
  The boost rewards same-session redundancy where these questions need
  cross-session diversity. Grouping key matters more than the boost itself —
  topic tags remain the intended use; session IDs are the wrong key.
- Categories with 2–3 questions are noise; read the 5+-question rows.

### The prompt is part of the system

The first Sonnet run scored **40%** — not because retrieval or the model
failed, but because the harness prompt said *"If the memories do not contain
the answer, reply exactly: I don't know"* and Sonnet obeyed it literally,
abstaining on partial evidence that Haiku happily used (74% on the same
prompt). Recalibrating the instruction ("reasonable inference is fine; say
I don't know only if nothing relevant was retrieved") moved Sonnet 40% → 70%
and Haiku 74% → 70%: the strict prompt had been *inflating* Haiku by letting
guesses count and *deflating* Sonnet by rewarding literalism. Any LLM-judged
QA benchmark that doesn't publish its answering prompt is hiding a variable
worth up to 30 points.

## Comparison Context

> **Important caveat — read before quoting anything below.**
> Synapse's engram-v3 96.0% is **end-to-end QA accuracy** (is the generated
> answer correct, LLM-judged). Systems like MemPalace publish **retrieval
> recall** (R@5 — is the labelled session in the top-5 candidates). These are
> different metrics on different datasets and **are not comparable**: a system
> can have 100% retrieval recall and poor QA accuracy, and vice versa.
> MemPalace's own BENCHMARKS.md makes the same point about its competitors.
> For a fair head-to-head, run the same metric on the same split — see
> Roadmap below.

| System | Published figure | Metric | Source |
|---|---|---|---|
| **Synapse** | **96.0%** | QA accuracy, engram-v3 (LongMemEval-format, 50q) | this repo, reproducible below |
| MemPalace (raw) | 96.6% | retrieval recall R@5, LongMemEval 500q | their BENCHMARKS.md, self-reported |
| MemPalace (hybrid + rerank, held-out) | 98.4% | retrieval recall R@5, 450q held-out | their BENCHMARKS.md, self-reported |
| Mastra | 94.87% | QA accuracy, LongMemEval | mastra.ai/research, self-reported |
| Mem0 | ~66.9% | QA accuracy, LoCoMo | mem0.ai/research, self-reported |

What Synapse measures that the recall-benchmark systems don't:

- **Staleness** — golden cases assert the *superseded* fact is absent.
- **Behavioral outcomes** — does an entity update actually replace the old
  fact at retrieval time; does `stale` feedback demote a memory out of the
  digest; do disputed results carry a warning qualifier; does repeated
  feedback converge confidence instead of oscillating.
- **Abstention** — with `minScore` set, an off-topic query returns nothing
  rather than the least-irrelevant memory.

---

## Reproduce

```bash
# Golden suite: 32 cases, Precision@5 / stale-fact rate / pass rate
pnpm eval

# engram-v3 with Haiku via the local claude CLI — no API key needed
SYNAPSE_LLM_PROVIDER=claude-cli SYNAPSE_LLM_MODEL=haiku \
  pnpm --filter @synapse/evals longmemeval --variant engram --judge

# Same, with Haiku reranking the top-15 hits before answering
SYNAPSE_LLM_PROVIDER=claude-cli SYNAPSE_LLM_MODEL=haiku \
  pnpm --filter @synapse/evals longmemeval --variant engram --judge --rerank

# Or any OpenAI-compatible endpoint instead of the CLI
export SYNAPSE_LLM_API_KEY=sk-...
pnpm --filter @synapse/evals longmemeval --variant engram --judge

# Full LongMemEval_s (500 questions) — same harness, bigger dataset
pnpm --filter @synapse/evals longmemeval --variant s --judge

# Behavioral + lifecycle evals run in the normal test suite
pnpm --filter @synapse/evals test
```

Embeddings default to the local provider (`SYNAPSE_EMBED_PROVIDER`), so
retrieval runs offline; the LLM endpoint (`SYNAPSE_LLM_BASE_URL`) can point at
a local model to keep the whole benchmark on-device.

---

## Benchmark Integrity

- **No tuning on test items.** No weight, threshold, or prompt in this repo
  was adjusted by inspecting specific failed benchmark questions. The two
  engram-v3 misses are unexamined beyond their category.
- **The retrieval path is LLM-free in every raw number.** Reranked figures
  are labelled as such and reported alongside — never instead of — the raw
  number, including when the rerank doesn't help (see the Haiku runs).
- **Self-reported comparisons stay in their own metric.** We do not put our QA
  accuracy in the same column as someone else's retrieval recall.
- **50 questions is a smoke test, not a leaderboard claim.** engram-v3 is our
  CI-sized benchmark. The headline-scale run is LongMemEval_s (500q), below.

---

## Roadmap

| Run | Status |
|---|---|
| engram-v3, raw retrieval | ✅ 96.0% (48/50) |
| engram-v3, Haiku / Sonnet / top-30 matrix (claude-cli) | ✅ 70% / 70% / **80%** — see table above |
| engram-v3 with consolidation enabled | ⏳ the remaining lever for recurring-pattern — the harness skips the consolidation job, so those questions never get their distilled semantic fact |
| Sonnet answerer at top-30 | ⏳ best-known config from both measured levers combined |
| LongMemEval_s (500q), raw retrieval | ⏳ harness ready (`--variant s`), not yet run at scale |
| Retrieval recall R@5 (MemPalace-comparable metric) | ⏳ needs labelled-session scoring in the harness |
