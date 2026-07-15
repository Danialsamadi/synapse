# Mneme — Personal AI Memory OS

> Chat history is a log. Mneme is a brain.

TypeScript monorepo for a **long-term personal memory layer**: typed memories, hybrid retrieve (Week 2), consolidation & conflict (Week 3), export/purge & inspector (Week 4).

| Doc | Purpose |
|-----|---------|
| [`PRD.md`](./PRD.md) | Product requirements |
| [`BUILD-PLAN.md`](./BUILD-PLAN.md) | 4-week day-by-day plan |
| [`MISSION.md`](./MISSION.md) | Why you’re learning/building this |
| [`lessons/`](./lessons/) | Interactive teach lessons (open in browser) |
| [`RESOURCES.md`](./RESOURCES.md) | High-trust sources |

## Quick start

```bash
cd memory-os
pnpm install
pnpm test
pnpm --filter @mneme/cli start remember semantic "User prefers TypeScript"
pnpm --filter @mneme/cli start list
pnpm dev:api   # http://localhost:8787/health
```

## Workspace layout

```
apps/
  api/           HTTP API (Hono)
  worker/        consolidation jobs (stub → Week 3)
  demo-agent/    thin consumer
  inspector/     UI (placeholder → Week 4)
packages/
  core/          Zod schemas, scoring helpers
  store/         SQLite repository
  embeddings/    provider interface + hash embed
  sdk/           MnemeClient
  evals/         golden cases
  cli/           mneme CLI
```

## Teach mode

This directory is also a **standing teaching workspace**.

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

Reference cards: [glossary](./reference/glossary.html) · [score formula](./reference/score-formula.html) · [architecture](./reference/architecture.html)

Every lesson has **top nav + prev/next**. After quizzes, log exit tickets in `learning-records/`.

## Status

Scaffold + Lesson 01 ready. Hybrid retrieve, worker, and full eval harness follow `BUILD-PLAN.md`.
