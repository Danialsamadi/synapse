# synapse-os

**Synapse — local-first long-term memory for AI agents, over MCP.**

> Chat history is a log. Synapse is a brain.

Gives any MCP-capable agent (Claude Code, Claude Desktop, Cursor, OpenCode…) durable, typed memory on local SQLite: entity-key supersession ("I moved jobs" replaces the old employer instead of coexisting with it), conflict detection, decay with spaced reinforcement, feedback-driven confidence, and a credential write-gate. Retrieval is hybrid (vector + BM25 + importance + recency − decay) and 100% LLM-free.

## Install

```bash
claude mcp add --scope user synapse -- npx -y synapse-os
```

Or any MCP client: stdio server, command `npx`, args `["-y", "synapse-os"]`.

## Tools

| Tool | What it does |
|---|---|
| `memory_write` | Store a typed memory; `entityKey` makes it a current-value slot with automatic supersession. Credentials are rejected. |
| `memory_retrieve` | Hybrid-scored recall with trust qualifiers ("stored 8 months ago — may be outdated"). |
| `memory_digest` | Always-on core memory block for session start. |
| `memory_feedback` | `helpful` / `stale` / `wrong` — moves confidence, disputes, and durability. |

Data lives in `~/.synapse/synapse.db`. Full docs, benchmarks (96.0% engram-v3, methodology and caveats included), and source: [github.com/Danialsamadi/synapse](https://github.com/Danialsamadi/synapse).

GPL-3.0-only.
