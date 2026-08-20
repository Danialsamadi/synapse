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
| **engram-v3, Haiku answerer, debugged harness** | **96.0%** Haiku-judged / **76.0%** Sonnet-judged (same answers) | end-to-end QA accuracy, LLM-judged | None |
| engram-v3 (original run, stronger answerer) | 96.0% (48/50) | end-to-end QA accuracy, LLM-judged | None |
| engram-v3, Haiku, top-30, pre-debug harness | 80.0% (40/50) | end-to-end QA accuracy | None |
| engram-v3, Haiku / Sonnet, top-15, pre-debug | 70.0% / 70.0% | end-to-end QA accuracy | None |
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

### The harness is part of the system: 80% → 96% with zero retrieval changes

A systematic autopsy of all 10 misses in the 80% run found **zero true
retrieval misses** — every loss was harness-inflicted. Three root causes,
each confirmed by minimal reproduction and scoped rerun:

1. **CLI agent hijack.** `claude -p` is a coding agent; with
   `--append-system-prompt` its project context, hooks, and agent framing
   competed with the benchmark role. A memory phrased like a task request
   ("what's the right approach?") could hijack the session — benchmark
   answers came back about this repo's git status. Fixed with a full
   `--system-prompt` override, neutral cwd, argv prompt delivery. One
   reproducible miss went 0% → 100%.
2. **Answer-prompt defects.** Memories are raw turns that never name the
   project, so models refused ("Arclight isn't mentioned in the memories")
   while holding the answer — fixed with one grounding sentence. "Answer in
   one short sentence" forced detail-dropping on multi-part questions —
   fixed with "concisely but completely". Hedging counter-questions turned
   correct answers into judged failures — fixed with "do not hedge".
3. **Judge strictness.** "Semantically equivalent to the gold answer"
   failed correct answers that carried *more* detail than gold or expressed
   dates in a different format. The judge now checks containment of the
   gold answer's key facts.

Validated full-run result after the fixes: **96.0% (48/50)** with Haiku —
matching the original strong-answerer run. Per-category: 100% in seven of
nine categories (multi-session 8/8, multi-hop 7/7, temporal 8/8,
knowledge-update 5/5); recurring-pattern 80% (up from 40%); cross-agent
85.7%. Both remaining misses contain the gold facts and passed in scoped
reruns — i.e. they look like judge noise, quantified next via a Sonnet
judge (`--judge-model`).

**Integrity disclosure:** these prompt fixes were written while inspecting
specific failed questions. The wording is generic (grounding, completeness,
containment) — nothing references any question's content — but this is
test-set-informed tuning and we label it as such, the same standard we
apply to MemPalace's tuned 100%. The clean-room check is running the same
harness on LongMemEval_s (500 unseen questions) — see Roadmap.

### The judge was not an error bar — it was broken, and we measured how

The section below (written earlier) treated judge disagreement as noise around
a true score. That was too generous. On LongMemEval-S we calibrated the judges
against human adjudication and one of them is simply unusable.

**Method.** 74 items were adjudicated by hand from the question, the gold
answer, and the model's answer *only* — no judge verdict visible, no retrieved
memories, no question source. Natural negatives were too few to tell a strict
judge from a lenient one, so 19 more were manufactured: known-correct answers
with exactly one fact corrupted (`38`→`41`, `Nike`→`Adidas`, `Revolution Hall`
→`Doug Fir`, an abstention turned into a confident fabrication, an event order
reversed). Every item, its label, and the one label we later corrected are in
`packages/evals/data/judge-calibration.json`.

**Two numbers per judge, never one** — a judge that always answers yes wins on
overall agreement:

| judge | accepts human-correct | rejects human-wrong (natural) | rejects manufactured |
|---|---|---|---|
| **haiku** | **97.8%** (44/45) | 100% (8/8) | **100%** (19/19) |
| opus | 95.6% (43/45) | 100% (8/8) | 100% (19/19) |
| sonnet | **31.1%** (14/45) | 100% (8/8) | 94.7% (18/19) |

Sonnet-as-judge rejects roughly two thirds of correct answers. It returns a
bare `no` to *"You met Sophia at a coffee shop in the city"* against gold
*"a coffee shop in the city"*, and to *"Revolution Hall"* against gold
*"Revolution Hall"* — reproduced by hand across system-prompt variants, while
haiku and opus accept both. Haiku's high recall is accuracy rather than
leniency: it rejects **all 19** corrupted answers.

The judge is therefore frozen at haiku in `scripts/bench-round.sh`, on this
evidence and not on preference.

**What that cost us.** The first two LongMemEval-S dev rounds used the sonnet
judge and scored 48.5% and 31.4%. Re-judging the *identical answers* with the
calibrated judge gives **76.3%**. No memory, retrieval setting, or prompt
changed between them.

**Integrity disclosure.** The labels are ours, not a third party's. One label
(`195a1a1b`) was corrected after a judge disagreed with it: re-reading the
untruncated answer showed it recommended phone apps against a rubric that
excludes phone use. The correction was verified against the rubric text rather
than deferred to the judge, and is recorded on the item.

### A partial round is not a smaller round

A 169-question round lost 143 questions to a transient CLI failure. The harness
caught each error per question and continued, so the 26 survivors merged
cleanly as **96.2% — above every published system**. Errors do not distribute
evenly across categories, so the survivors were a biased sample, not a shorter
benchmark. `scripts/bench-merge.mjs` now refuses to record any round that lost
more than 2% of its questions, and `ClaudeCliLlm.complete` retries with
backoff. The false round was deleted from the history rather than footnoted.

### The judge is the biggest error bar

We re-judged the **identical 50 answers** from the 96.0% run with Sonnet
instead of Haiku: **76.0%**. The two judges disagree on 14 of 50 verdicts
(28%) — Sonnet rejects 12 answers Haiku accepted and accepts the 2 it
rejected. Spot-checks show the disagreement pattern, not random noise:
gold answers are long and multi-clause; Haiku passes an answer containing
the core facts, Sonnet demands every clause. (A separate full run with
Sonnet judging freshly generated Haiku answers scored 82.0% — between the
two, as expected when answer variance stacks on judge variance.)

We do not know which judge is "right" — resolving that needs human
adjudication or clause-level scoring. What we know, and publish: **on this
benchmark, judge choice moves the headline by 20 points on identical
answers — more than any retrieval or model change we measured.** Treat any
LLM-judged accuracy claim (ours and everyone else's) as having that error
bar unless the judge, its prompt, and a judge-agreement number are
published with it.

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

- **Dev-informed, holdout-clean.** This no longer claims "no tuning on test
  items". The LongMemEval-S **dev** split (169q) has been inspected question by
  question, and the question-time anchoring fix was found by reading dev misses.
  We label that honestly rather than deny it. What protects the claim is the
  split, not our restraint: the **holdout** (331q) is measured once, at the end,
  with the judge and config already frozen, and is never tuned against. The
  distinction we hold to is mechanism versus fitting — `req.now` corrects a
  clock that was wrong for every query in every deployment, and would be a bug
  fix with no benchmark attached. A threshold moved until dev improved would
  not be, and is not shipped that way.
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
| engram-v3, Haiku, debugged harness | ✅ **96.0%** (48/50) — validated full run |
| engram-v3, Haiku / Sonnet / top-30 matrix (pre-debug) | ✅ 70% / 70% / 80% — see table above |
| Sonnet judge over Haiku answers (judge-noise bound) | ✅ 76.0% same-answers re-judge / 82.0% fresh run — 28% verdict disagreement |
| Human adjudication or clause-level scoring of the 14 disputed verdicts | ⏳ resolves which judge is right |
| engram-v3 with consolidation enabled | ⏳ the remaining lever for recurring-pattern — the harness skips the consolidation job, so those questions never get their distilled semantic fact |
| Sonnet answerer at top-30 | ⏳ best-known config from both measured levers combined |
| LongMemEval-S dev split (169q), calibrated haiku judge | ✅ **76.3%** — above Zep 71.2% and full-context gpt-4o 60.2%; below Mem0 94.4% |
| LongMemEval-S question-time anchoring (`req.now`) | ✅ 0→4 of the 14 zero-retrieval questions recovered at identical settings; full-round number pending |
| `parseTimeWindow` word numerals ("four weeks ago") | ⏳ matches nothing today; 2 of the 9 remaining abstentions. Ships alone — extending the parser was measured zeroing 2 single-session-user questions |
| Retrieval depth top 30→50 | ⏳ capped at 50: `RetrieveRequestSchema.limit` is `.max(50)`, so a number measured at top=100 is not reproducible through the API or SDK |
| LongMemEval-S holdout (331q) | ⏳ measured once, after the judge and config are frozen; never tuned against |
| Retrieval recall R@5 (MemPalace-comparable metric) | ⏳ needs labelled-session scoring in the harness |
