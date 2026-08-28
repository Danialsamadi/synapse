# Synapse on Hermes (constrained agent hosts)

Field-tested setup for Hermes-style gateways: small `/tmp`, no native toolchain, no GPU runtime, MCP over stdio.

## Install

```bash
npm install -g synapse-os
# If install scripts are blocked, or better-sqlite3 lacks a prebuilt binary:
npm install -g synapse-os --ignore-scripts
cd "$(npm root -g)/synapse-os" && npm rebuild better-sqlite3
```

`synapse-os` does not depend on transformers.js/ONNX — nothing large downloads.

## MCP config

Env vars belong in an `env:` **object** in `config.yaml`. `hermes mcp add --env KEY=VAL` currently writes `--env` into `args:` instead — write the YAML directly:

```yaml
mcpServers:
  synapse:
    command: node
    args:
      - /usr/local/lib/node_modules/synapse-os/dist/index.js
    env:
      SYNAPSE_DB: /root/.synapse/synapse.db
      SYNAPSE_EMBED_PROVIDER: hash
```

(`command: npx, args: ["-y", "synapse-os"]` also works where npx is allowed.)

## Embeddings in a constrained container

- `hash` (shown above): zero deps, zero network, **not semantic**. Retrieval = FTS5 keyword + importance/recency/confidence. Roughly 80% useful for structured cron logs; blind to paraphrase ("fuzzy recall").
- Real embeddings without heavy installs: Ollama on the host —

  ```yaml
    env:
      SYNAPSE_EMBED_PROVIDER: openai
      SYNAPSE_EMBED_BASE_URL: http://localhost:11434/v1
      SYNAPSE_EMBED_MODEL: nomic-embed-text
  ```

  After switching, re-embed existing memories once: `synapse-os reembed`.

## Logging cron runs (episodic memories that stay retrievable)

Rules that make run histories work:

- `type: "episodic"`, one write per run.
- **Never set `entityKey` on run logs.** `entityKey` is a current-value slot — each new run would *supersede* the previous one and your history collapses to "latest only". (Use `entityKey` only for the job's *config/current-state* fact, e.g. `cron.tech-news-curator`.)
- Put stable identifiers in the content and tags; pass `occurredAt` for the run time.

```json
{
  "name": "memory_write",
  "arguments": {
    "type": "episodic",
    "content": "Iran Internet Monitor run 2026-08-21T18:00:42Z (run_id=iim-4821): success. 40/40 endpoints polled, 3 anomalies, source=cron.",
    "tags": ["iran-monitor", "cron-run"],
    "occurredAt": "2026-08-21T18:00:42Z"
  }
}
```

Episodic writes are exempt from semantic dedup/absorb — near-identical run lines on consecutive days are all kept (only byte-identical content dedups).

## Querying run history

```json
{ "name": "memory_retrieve",
  "arguments": { "query": "iran monitor runs last week", "tags": ["iran-monitor"], "limit": 20 } }
```

- Relative time phrases ("yesterday", "last week", "3 days ago") become date filters automatically; event time is `occurredAt`, not write time.
- In hash mode, keyword matching drives recall — keep consistent job names/tags in content ("Iran Internet Monitor", `run_id=`), and filter by `tags` for precision.

## Feedback from chat surfaces (Telegram etc.)

Wire "that's outdated" replies to `memory_feedback`: `{ "id": "<memory id from retrieve>", "verdict": "stale" }` — lowers confidence, disputes the memory, and hides it from default retrieval. `helpful` does the reverse.

## Upgrades: restart long-lived MCP processes

Hosts that spawn `npx -y synapse-os` per session pick up upgrades automatically. Gateway/watchdog hosts that keep one MCP process alive for days do **not** — the old code keeps serving until the process restarts. Field incident: a pre-0.4.0 process kept absorbing writes with hash-vector dedup for a day after the 0.4.0 upgrade. After upgrading: restart the synapse MCP process (or the gateway).

To check which version is actually serving, read the newest `startup` audit row:

```bash
sqlite3 "file:/root/.synapse/synapse.db?mode=ro" \
  "SELECT detail, created_at FROM audit_log WHERE action='startup' ORDER BY created_at DESC LIMIT 1"
```

## If the CLI and the MCP server seem to disagree

SQLite WAL is **not** eventually consistent — any reader sees all committed writes immediately, including uncheckpointed ones (verified with a live writer holding the DB open). If the two paths return different results, the cause is one of:

1. **Version skew** — a stale pre-upgrade MCP process (check the `startup` audit above). Old versions also had different retrieval candidacy, so the *same query* can return different results across versions.
2. **Different databases** — `SYNAPSE_DB` set in the MCP `env:` but not in your shell (or vice versa); each path silently uses its own file. Compare paths first.
3. **Hash-mode candidacy** — in hash mode, `query` only surfaces memories with FTS keyword overlap; `list` shows everything. A memory "missing" from a query but present in `list` is a wording mismatch, not a storage problem.

**Restore needs the server stopped.** `synapse-os restore` refuses while a running MCP server/gateway holds the database — restoring under a live holder strands that process's writes on the old file. Stop the gateway (or the synapse child process), restore, then start it again.

If a write "disappeared", check the dedup/absorb audit rows — since 0.4.1 they carry the discarded content (`droppedContent`), so a false-positive merge is recoverable:

```bash
sqlite3 "file:/root/.synapse/synapse.db?mode=ro" \
  "SELECT detail FROM audit_log WHERE action IN ('dedup','absorb') ORDER BY created_at DESC LIMIT 5"
```

## Inspecting the DB while the gateway holds it

The DB is WAL-mode — concurrent readers are safe: `synapse-os list`, `synapse-os export`, or read-only SQL from any process allowed to run it:

```bash
sqlite3 "file:/root/.synapse/synapse.db?mode=ro" \
  "SELECT type, status, substr(content,1,80) FROM memories ORDER BY created_at DESC LIMIT 20"
```
