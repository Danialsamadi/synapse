# LongMemEval harness + abstention — design

Date: 2026-07-23. Follows the landscape comparison (docs/COMPARISON.md): measure
Synapse on the benchmark the field uses, and fix the weakest measured ability
(abstention) in the same change.

## 1. Abstention

- `RetrieveRequestSchema` gains optional `minScore` (0–1, no default at the schema
  level — existing callers unchanged).
- `RetrievalService.retrieve`: after scoring, drop candidates below `minScore`.
  If nothing survives, return empty `memories` — callers can distinguish "no
  relevant memories" from "here's weakly-related noise."
- MCP `memory_retrieve`: accepts `minScore`; when the result is empty, the tool
  returns an explicit `{"memories": [], "note": "No sufficiently relevant memories
  found — do not fabricate; say you don't know."}` so agents abstain instead of
  hallucinating.
- Tests: filtered vs unfiltered retrieval; empty-result note in the MCP tool.

## 2. LongMemEval harness (packages/evals)

Dataset: `xiaowu0162/longmemeval-cleaned` on HuggingFace (MIT). Start with the
**oracle** variant (evidence sessions only); the same runner takes `_s` later.

Runner `packages/evals/src/longmemeval.ts` (invoked via
`pnpm --filter @synapse/evals longmemeval [--limit N] [--variant oracle|s]`):

1. **Fetch + cache** the dataset JSON to `~/.synapse/bench/` (plain fetch, no auth).
2. **Per question** (isolated in-memory repository, local MiniLM embeddings):
   - Ingest: each session turn becomes an episodic `writeMemory` with the session
     timestamp prefixed into the content (`[2023/05/20 (Sat) 02:21] user: ...`) —
     retrieval recency scoring is bypassed this way, but the answering model sees
     real timestamps, which is what temporal questions need. No schema change.
   - Retrieve: question as query, limit 15 (BEAM's sweet spot), `minScore` from
     CLI flag (default 0.25) so abstention is exercised.
   - Answer: `SYNAPSE_LLM_*` OpenAI-compatible model; prompt = retrieved memories
     + question + "if the memories don't contain the answer, say you don't know."
3. **Output**: `hypotheses.jsonl` (`{question_id, hypothesis}`) — byte-compatible
   with the upstream `evaluate_qa.py` judge — plus a built-in TS LLM judge
   (same yes/no correctness prompt, abstention questions judged on refusing)
   printing an accuracy table per question type.
4. README gets the results table once a full run passes.

Cost: oracle ≈ 500 answer calls + 500 judge calls on a mini-tier model — a few
dollars; `--limit` for smoke runs.

## Out of scope
Digest v2, time-aware query parsing, graph traversal (ranked next; see COMPARISON).

## Implementation order
1. `minScore` in core schema + retrieval + tests
2. MCP tool param + abstention note + test
3. Harness runner + fetch/cache + answering
4. Built-in judge + accuracy table; smoke run with `--limit 20`
