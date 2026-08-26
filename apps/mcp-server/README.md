# synapse-os

**Synapse — long-term memory for AI agents: stdio MCP server + CLI, on local SQLite.**

> Chat history is a log. Synapse is a brain.

Gives any MCP-capable agent (Claude Code, Claude Desktop, Cursor, OpenCode, Hermes…) durable, typed memory: entity-key supersession ("I moved jobs" replaces the old employer instead of coexisting with it), conflict detection, decay with spaced reinforcement, feedback-driven confidence, and a credential write-gate. Retrieval is hybrid (vector + FTS5/BM25 + importance + recency − decay) and LLM-free.

## Install

```bash
claude mcp add --scope user synapse -- npx -y synapse-os
```

Or any MCP client: stdio server, command `npx`, args `["-y", "synapse-os"]`. Env vars go in the client's `env` object (for Hermes: an `env:` YAML mapping, not `--env` args).

Constrained containers (small /tmp, blocked install scripts):

```bash
npm install -g synapse-os --ignore-scripts
cd "$(npm root -g)/synapse-os" && npm rebuild better-sqlite3
```

## CLI

The same binary is a full CLI over the same database (no args = MCP server, so existing configs keep working):

```bash
synapse-os remember semantic "User prefers TypeScript"
synapse-os query "typescript preference"
synapse-os list | get <id> | delete <id> | import <file.md> | export
synapse-os reembed                      # after switching embedding provider/model
synapse-os backup [dest] | restore <src> --force
synapse-os mcp                          # explicit MCP mode
```

## Embeddings — honest defaults

`npx -y synapse-os` does **not** download ML runtimes. Default provider selection:

1. `SYNAPSE_EMBED_PROVIDER` set → that provider (`hash` | `openai` | `local`).
2. Else `SYNAPSE_EMBED_API_KEY` or `SYNAPSE_EMBED_BASE_URL` set → `openai` (any OpenAI-compatible endpoint, including Ollama).
3. Else → `hash`, with a loud startup warning: **not semantic.** The vector term is disabled; retrieval works on FTS5 keyword search + importance/recency/confidence. Good for structured/keyword recall, blind to paraphrase.

Real semantic recall, lightest path (Ollama): `SYNAPSE_EMBED_PROVIDER=openai SYNAPSE_EMBED_BASE_URL=http://localhost:11434/v1 SYNAPSE_EMBED_MODEL=nomic-embed-text`. Heaviest path: `SYNAPSE_EMBED_PROVIDER=local` needs an explicit `npm i @huggingface/transformers` (pulls the ONNX runtime, ~100MB+; model downloads once from HuggingFace). **After switching providers run `synapse-os reembed`.**

## Tools

| Tool | What it does |
|---|---|
| `memory_write` | Store a typed memory; `entityKey` makes it a current-value slot with automatic supersession. Don't use `entityKey` for run/event logs — each write would supersede the previous run; use `type: "episodic"` + tags instead. Credentials are rejected. |
| `memory_retrieve` | Hybrid-scored recall with trust qualifiers ("stored 8 months ago — may be outdated"). |
| `memory_digest` | Always-on core memory block for session start. |
| `memory_feedback` | `helpful` / `stale` / `wrong` — moves confidence, disputes, and durability. |

Data lives in `~/.synapse/synapse.db` (override: `SYNAPSE_DB`). WAL mode allows concurrent readers while the server runs: `sqlite3 "file:$HOME/.synapse/synapse.db?mode=ro" "..."` or just `synapse-os list`.

**Scope notes:** this package is the stdio MCP server + CLI. The HTTP API and Inspector UI live in the monorepo, not in this package. Benchmarked at personal scale (~1K memories, linear vector scan); 10K+ is unproven. Full docs, benchmarks (96.0% engram-v3, methodology and caveats included), and source: [github.com/Danialsamadi/synapse](https://github.com/Danialsamadi/synapse).

GPL-3.0-only.
