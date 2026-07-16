# Mneme — Personal AI Memory OS

[![CI](https://github.com/Danialsamadi/memory-os/actions/workflows/ci.yml/badge.svg)](https://github.com/Danialsamadi/memory-os/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

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
  mcp-server/      stdio MCP server (Claude Code/Desktop/Cursor)
packages/
  core/            Zod schemas, scoring helpers, ID generation
  store/           SQLite repository, retrieval, jobs
  embeddings/      provider interface + hash/OpenAI embeddings
  sdk/             MnemeClient + tool definitions + provider adapters
  evals/           32 golden cases + lifecycle test
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

Weights defined in `DEFAULT_RANK_WEIGHTS` (`packages/core/src/scoring.ts`). Retrieval is 100% non-LLM; the LLM is used only in consolidation and conflict detection.

## Quick start

```bash
pnpm install
pnpm test                              # all tests
pnpm eval                              # eval harness (32 cases)
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

## Use from any AI provider

**MCP (Claude Code, Claude Desktop, Cursor — verified live with Claude Code):**

```bash
claude mcp add --scope user mneme -- pnpm --dir /path/to/memory-os mcp
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "mneme": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/memory-os", "mcp"]
    }
  }
}
```

The server stores to `~/.mneme/mneme.db` by default (override with `MNEME_DB`). Verified end-to-end: one agent session wrote a fact via `memory_write`, a fresh session recalled it via `memory_retrieve`. Tip: if your host agent has its own memory feature (Claude Code does), add "Use the mneme MCP tools for storing and recalling user memories" to your `CLAUDE.md`.

**Anthropic / OpenAI / any OpenAI-compatible router** (OpenRouter, Groq, Ollama, Mistral):

```ts
import { toAnthropicTools, toOpenAiTools, parseToolCall, executeMemoryTool, MnemeClient } from "@mneme/sdk";

const client = new MnemeClient({ baseUrl: "http://localhost:8787" });
// pass toAnthropicTools() to the Messages API, or toOpenAiTools() to Chat Completions
// on any tool call the model returns:
const { name, args } = parseToolCall(providerToolCall);
const result = await executeMemoryTool(client, name, args);
```

Every provider path shares the same guards: Zod validation on all inputs and agent-write importance capped at 0.8 (prompt-injection protection).

## Evals

| Metric | Value |
|--------|-------|
| Golden cases | 32 |
| Precision@5 | 0.984 |
| Stale-fact rate | 0.000 |
| Pass rate | 0.969 |

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

## License

MIT — see [LICENSE](LICENSE).
