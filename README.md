# Mneme — Personal AI Memory OS

> Chat history is a log. Mneme is a brain.

Mneme is a **local-first personal memory operating system** that gives AI agents durable, typed long-term memory. It extracts semantic facts from episodic conversations, detects and resolves conflicts, decays stale information, and retrieves relevant memories with a hybrid scoring pipeline — all running on local SQLite with full user control over export and purge.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Agent / CLI / SDK                                      │
│    ├── memory_write  (episodic / semantic / procedural)  │
│    └── memory_retrieve  (hybrid scoring + token budget)  │
├─────────────────────────────────────────────────────────┤
│  API  (Hono · /v1/memories · /v1/jobs · /v1/conflicts) │
├─────────────────────────────────────────────────────────┤
│  Store  (better-sqlite3 · WAL · migrations V1/V2)       │
│    ├── MemoryRepository  (CRUD, links, quarantine, jobs) │
│    ├── RetrievalService  (hybrid ranker)                 │
│    └── Jobs: consolidate · conflict · decay · purge      │
├─────────────────────────────────────────────────────────┤
│  Embeddings  (provider interface · HashEmbeddingProvider)│
│  LLM  (OpenAI-compatible · FakeLlm for tests)           │
└─────────────────────────────────────────────────────────┘
```

## Monorepo layout

```
apps/
  api/             HTTP API (Hono) + inspector page
  demo-agent/      tool-calling demo agent
packages/
  core/            Zod schemas, scoring helpers, ID generation
  store/           SQLite repository, retrieval, jobs
  embeddings/      provider interface + hash embeddings
  sdk/             MnemeClient + tool definitions
  evals/           30 golden cases + lifecycle test
  cli/             mneme CLI
scripts/
  demo.sh          north-star demo script
```

## Retrieval scoring

Hybrid score per candidate memory:

```
score = 0.40·vector + 0.20·keyword + 0.15·importance
      + 0.10·recency - 0.10·decay - 0.05·conflict
```

Weights defined in `DEFAULT_RANK_WEIGHTS` (`packages/core/src/scoring.ts`). Retrieval is non-LLM (PRD N-10); LLM is used only in consolidation and conflict detection.

## Quick start

```bash
pnpm install
pnpm test                              # all tests
pnpm eval                              # eval harness (30 cases)
pnpm dev:api                           # http://localhost:8787

# CLI
pnpm --filter @mneme/cli start remember semantic "User prefers TypeScript"
pnpm --filter @mneme/cli start query "TypeScript preference"
pnpm --filter @mneme/cli start export

# Inspector
open http://localhost:8787/inspector

# North-star demo (requires API running)
./scripts/demo.sh
```

## Evals

| Metric | Value |
|--------|-------|
| Golden cases | 30 |
| Precision@5 | 0.983 |
| Stale-fact rate | 0.000 |
| Pass rate | 0.967 |

Lifecycle test proves the full pipeline: episode → extraction → conflict detection → supersession → retrieval excludes stale fact.

## Privacy

- **Export:** `GET /v1/export` — full JSON dump of all non-deleted memories
- **Purge:** `POST /v1/purge` — hard-deletes rows, embeddings, and links
- **Auth:** set `MNEME_TOKEN` env var to require Bearer auth on all `/v1/*` routes
- **Audit:** export and purge actions are logged to the audit table

## 2-minute reviewer script

```bash
pnpm install && pnpm test && pnpm eval
pnpm dev:api &
sleep 1

# Write and retrieve
curl -s -X POST http://localhost:8787/v1/memories \
  -H 'Content-Type: application/json' \
  -d '{"type":"semantic","content":"User lives in Vancouver","tags":["location"]}'

curl -s -X POST http://localhost:8787/v1/memories/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"query":"Where do I live?","limit":3}' | python3 -m json.tool

# Inspector
open http://localhost:8787/inspector

# Export
curl -s http://localhost:8787/v1/export | python3 -m json.tool
```

## Teach mode

```bash
open lessons/index.html
```

| # | Lesson | Week |
|---|--------|------|
| 01 | [Memory is not a log](./lessons/01-memory-is-not-a-log.html) | 1 |
| 02 | [Typed store & contracts](./lessons/02-typed-store-and-contracts.html) | 1 |
| 03 | [Hybrid retrieval & budgets](./lessons/03-hybrid-retrieval-and-budgets.html) | 2 |
| 04 | [Agent tools & SDK](./lessons/04-agent-tools-and-sdk.html) | 2 |
| 05 | [Consolidation, conflict, forgetting](./lessons/05-consolidation-conflict-forgetting.html) | 3 |
| 06 | [Privacy, evals, portfolio](./lessons/06-privacy-evals-portfolio.html) | 4 |
