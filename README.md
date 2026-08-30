![Synapse](Synapse.png)

# Synapse — Personal AI Memory OS

[![CI](https://github.com/Danialsamadi/synapse/actions/workflows/ci.yml/badge.svg)](https://github.com/Danialsamadi/synapse/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/synapse-os)](https://www.npmjs.com/package/synapse-os)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

> Chat history is a log. Synapse is a brain.

Synapse is a **local-first personal memory operating system** that gives AI agents durable, typed long-term memory. It extracts semantic facts from episodic conversations, anchors single-current-value facts to entity keys so new values supersede old ones, detects and resolves conflicts, decays stale information, and retrieves with a hybrid scoring pipeline that attaches trust qualifiers and learns from agent feedback — all on local SQLite with full user control over export and purge. It refuses to store credentials, and an always-on digest covers what retrieval can't: the facts an agent should just know at session start.

## Architecture

```mermaid
flowchart TB
    subgraph Agents["Agents & Surfaces"]
        MCP["MCP clients<br/>Claude Code · Claude Desktop · Cursor · OpenCode"]
        SDK["SDK adapters<br/>Anthropic · OpenAI-compatible routers"]
        CLI["CLI<br/>synapse remember / query / export / decay"]
        UI["Inspector UI"]
    end

    subgraph Tools["Memory tools (Zod-validated, importance-capped)"]
        W["memory_write<br/>+ entityKey supersession"]
        R["memory_retrieve<br/>+ trust qualifiers"]
        D["memory_digest<br/>always-on core memory"]
        F["memory_feedback<br/>helpful / stale / wrong"]
    end

    API["HTTP API (Hono)<br/>/v1/memories · /v1/jobs · /v1/conflicts · /v1/export · /v1/purge"]

    subgraph Store["Store (better-sqlite3 · WAL)"]
        REPO["MemoryRepository<br/>CRUD · links · quarantine · audit · jobs"]
        RET["RetrievalService<br/>vector + BM25 keyword + importance + recency − decay − conflict"]
        JOBS["Jobs<br/>consolidate · conflict · decay · purge"]
    end

    subgraph Providers["Providers (env-configured factories)"]
        EMB["Embeddings<br/>hash (offline) · OpenAI-compatible"]
        LLM["LLM<br/>OpenAI-compatible · FakeLlm for tests"]
    end

    MCP --> W & R & D & F
    SDK --> W & R
    W & R --> API
    CLI --> Store
    UI --> API
    API --> Store
    RET --> EMB
    JOBS --> LLM
    JOBS --> EMB
```

The MCP server talks to the store directly (like the CLI); the SDK adapters route through the HTTP API. All write paths share the same guards.

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
  sdk/             SynapseClient + tool definitions + provider adapters
  evals/           32 golden cases + lifecycle test
  cli/             synapse CLI
scripts/
  demo.sh          north-star demo script
```

## Retrieval scoring

Hybrid score per candidate memory:

```math
\begin{aligned}
\text{score} ={} & 0.40 \cdot \text{vector} + 0.20 \cdot \text{keyword} + 0.15 \cdot \text{importance} + 0.10 \cdot \text{confidence} \\
& + 0.10 \cdot \text{recency} - 0.10 \cdot \text{decay} - 0.05 \cdot \text{conflict}
\end{aligned}
```

Weights defined in `DEFAULT_RANK_WEIGHTS` (`packages/core/src/scoring.ts`). Retrieval is 100% non-LLM by default; the LLM is used only in consolidation and conflict detection. An opt-in `rerank: true` flag lets an LLM reorder the final hit list (for benchmark headroom) — any parse failure or LLM error falls back silently to hybrid order, and the MCP path never uses it.

The **keyword** component is real full-text search, not substring matching: an SQLite FTS5 index (`porter unicode61` tokenizer — English stemming, other scripts match exactly) scores hits with BM25, and every query token prefix-matches (`"roas"` finds "roast"). Candidacy is the union of FTS keyword hits and the vector top-K — memories matching neither signal are noise for that query and are never scored (always-know facts are the digest's job, below). If the FTS index is ever broken, retrieval degrades to legacy substring scoring instead of failing, and audits the fallback.

Retrieval also closes the loop instead of being a one-way pipe:

- **Trust qualifiers** — each result may carry a `qualifier` string ("stored 8 months ago — may be outdated; disputed by a conflicting memory; low confidence") so the consuming LLM can hedge instead of confidently asserting stale facts.
- **Touch-on-retrieve** — returned memories get their `lastAccessedAt` bumped, so memories that keep proving relevant rank higher over time via the recency term.
- **Abstention** — pass `minScore` and Synapse returns nothing rather than weakly-related noise; an empty result is a signal, not a failure.
- **Rank-based group boost** — the tag group whose best member scored highest gets a small additive boost for all its members (ordinal, not distance-based), so weak siblings of a strong hit outrank unrelated stragglers.
- **1-hop link expansion** — a hit on a memory pulls in its `part_of` / `related_to` neighbors at half score when there's room, so a hit on a chapter brings its book along.
- **Semantic dedup at write time** — a new memory near-identical to an existing one is absorbed instead of stored twice, keeping retrieval results from filling with duplicates.

## Memory tools (MCP)

| Tool | What it does |
|------|--------------|
| `memory_write` | Store a typed memory (episodic / semantic / procedural). Pass `entityKey` (e.g. `user.employer`) for single-current-value facts — a new value automatically supersedes the old one instead of coexisting with it. Content that looks like a credential is rejected (see [Secret detection](#secret-detection)). |
| `memory_retrieve` | Hybrid-scored recall with trust qualifiers on each result. |
| `memory_digest` | Always-on core memory: pinned + most important facts as one capped block. Call once at session start — the "agent should just know this" layer that pure retrieval misses. |
| `memory_feedback` | Report a retrieved memory as `helpful`, `stale`, or `wrong`. Helpful raises confidence (and re-activates a disputed memory); stale/wrong lowers it and marks the memory disputed, hiding it from default retrieval. |

**Entity anchoring** fixes the classic staleness bug ("I work at Acme Corp" retrieved three months after you switched jobs): facts with an `entityKey` behave like a current-value slot, not an append-only log. The consolidation job emits entity keys too, so facts extracted from conversation get the same treatment. Superseded values stay in history (`status: superseded`, linked via `supersedes`) — nothing is silently lost.

## Quick start

```bash
pnpm install
pnpm test                              # all tests
pnpm eval                              # eval harness (32 cases)
pnpm dev:api                           # http://localhost:8787

# CLI
pnpm --filter @synapse/cli start remember semantic "User prefers TypeScript"
pnpm --filter @synapse/cli start query "TypeScript preference"
pnpm --filter @synapse/cli start export

# Inspector — browse/edit memories, link graph, analytics charts, audit trail (light/dark)
open http://localhost:8787/inspector

# North-star demo (requires API running)
./scripts/demo.sh
```

## The `synapse-os` package: CLI + MCP in one

The published npm package is both the stdio MCP server **and** a full CLI sharing the same store, env vars, and write guards:

```bash
npx -y synapse-os                      # no args → stdio MCP server (existing configs keep working)
npx -y synapse-os mcp                  # explicit MCP mode
npx -y synapse-os remember semantic "User prefers TypeScript"
npx -y synapse-os query "typescript preference"
npx -y synapse-os list / get / delete / import / export
npx -y synapse-os reembed              # after switching embedding provider/model
npx -y synapse-os decay                # TTL/decay sweep — for cron, no live server needed
npx -y synapse-os backup [dest] / restore <src> --force
```

**What's in the package:** the stdio MCP server + CLI, on better-sqlite3. The HTTP/SSE API and Inspector UI live in this monorepo (`apps/api`) and are **not** part of the `synapse-os` package — "works with any MCP client" means stdio. Heavy ML is opt-in: installing `synapse-os` does **not** pull transformers.js/ONNX; `SYNAPSE_EMBED_PROVIDER=local` requires a separate `npm i @huggingface/transformers`.

To inspect the DB while an MCP host holds it (WAL mode allows concurrent readers): `npx -y synapse-os list`, or read-only SQL: `sqlite3 "file:$HOME/.synapse/synapse.db?mode=ro" "SELECT type, status, content FROM memories"`.

### Constrained environments (containers, gateways, Hermes)

Small `/tmp`, no native toolchain, or no GPU runtime? This is the supported path:

```bash
npm install -g synapse-os        # no onnxruntime, no model downloads
# if install scripts are blocked or better-sqlite3 has no prebuilt binary for your platform:
npm install -g synapse-os --ignore-scripts && (cd "$(npm root -g)/synapse-os" && npm rebuild better-sqlite3)
```

- Default embeddings are `hash` (non-semantic, loud warning at startup): retrieval runs on FTS5 + importance/recency — about 80% useful for structured/cron-log recall, blind to paraphrase.
- For real semantic recall without heavy npm installs, use Ollama (see provider matrix) and run `synapse-os reembed` after switching.
- Hermes MCP config — env vars go in an `env:` **object**, not `--env` CLI args:

```yaml
mcpServers:
  synapse:
    command: npx
    args: ["-y", "synapse-os"]
    env:
      SYNAPSE_DB: /root/.synapse/synapse.db
      SYNAPSE_EMBED_PROVIDER: hash
```

Full Hermes guide, including cron-run episodic logging patterns: [`integrations/hermes/`](integrations/hermes/).

## Use from any AI agent

Synapse exposes `memory_write`, `memory_retrieve`, `memory_digest`, and `memory_feedback` over MCP. Any MCP-capable agent can use it — verified live with Claude Code (write in one session, recall in a fresh one).

**Claude Code:**

```bash
claude mcp add --scope user synapse -- npx -y synapse-os

# or from a source checkout:
claude mcp add --scope user synapse -- pnpm --dir /path/to/synapse mcp
```

Then verify inside a new session with `/mcp` — synapse must show as connected. Tool calls appear as permission prompts named `synapse - memory_write` / `synapse - memory_retrieve`.

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then restart the app:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/memory-os", "mcp"]
    }
  }
}
```

**Cursor** — Settings → MCP → Add server, or add the same `mcpServers` block to `~/.cursor/mcp.json`.

**OpenCode:**

```bash
opencode mcp add synapse -- pnpm --dir /path/to/memory-os mcp
```

*Forced recall (optional):* MCP tool calls are ultimately the model's choice. For deterministic recall, copy [`integrations/opencode/synapse-recall.ts`](integrations/opencode/synapse-recall.ts) to `~/.config/opencode/plugin/` and set `SYNAPSE_REPO` to your checkout (or edit the `REPO` constant). It hooks `chat.message`: when a prompt contains a trigger phrase ("use synapse", "deep memory", "recall", "what do you know about …"), it queries the DB directly and injects the results into the prompt before the model runs — no reliance on the model calling the tool.

**Any other MCP client** — it's a standard stdio server: command `pnpm`, args `["--dir", "/path/to/memory-os", "mcp"]`.

The server stores to `~/.synapse/synapse.db` by default; set `SYNAPSE_DB` in the server's `env` to share one database with the API/CLI/Inspector.

**Testing tips (learned the hard way):**
- Confirm the tool is actually connected in the session before judging results (`/mcp` in Claude Code, `opencode mcp list`).
- Hosts with their own memory feature (Claude Code) may prefer it for passive "remember X" phrasing — name the tool ("use the synapse memory_write tool") or add `Use the synapse MCP tools for storing and recalling user memories.` to your `CLAUDE.md` / agent rules.
- Independent proof a write landed: `sqlite3 ~/.synapse/synapse.db "SELECT type, content FROM memories WHERE status='active'"`.

**Anthropic / OpenAI / any OpenAI-compatible router** (OpenRouter, Groq, Ollama, Mistral):

```ts
import { toAnthropicTools, toOpenAiTools, parseToolCall, executeMemoryTool, SynapseClient } from "@synapse/sdk";

const client = new SynapseClient({ baseUrl: "http://localhost:8787" });
// pass toAnthropicTools() to the Messages API, or toOpenAiTools() to Chat Completions
// on any tool call the model returns:
const { name, args } = parseToolCall(providerToolCall);
const result = await executeMemoryTool(client, name, args);
```

*Guaranteed recall:* to make the model query memory before answering, pass `tool_choice` on the **first** request of a turn — `anthropicForceTool()` (Messages API) or `openAiForceTool()` (Chat Completions) — then drop it on the follow-up call that carries the tool result, or the model is forced into an infinite tool loop. Note: Anthropic rejects forced tool use combined with extended thinking.

Every provider path shares the same guards: Zod validation on all inputs and agent-write importance capped at 0.8 (prompt-injection protection).

## Secret detection

Synapse refuses to store credentials. Every write path — MCP, HTTP API, CLI, the consolidation job — runs the content through a high-precision pattern gate **before** it touches disk: AWS access keys, `sk-…` API keys, GitHub/Slack/Google tokens, JWTs, PEM private keys, and `password:`/`token=`-style assignments.

- Rejected writes never reach the database, the embedder, exports, or the digest.
- The agent gets a readable reason ("Content appears to contain a credential (aws-access-key)… use a password manager") — the HTTP API returns `422`, the CLI exits non-zero.
- The audit log records only the credential **kind**, never the matched text.
- Deliberately storing secrets is a human's call, not an agent's: set `SYNAPSE_ALLOW_SECRETS=1` in the server environment to disable the gate entirely. There is no per-write override an agent could reach.

## Evals

| Metric | Value |
|--------|-------|
| Golden cases | 32 |
| Precision@5 | 0.969 |
| Stale-fact rate | 0.000 |
| Pass rate | 0.969 |

Golden-case numbers are measured in **hash mode** (no semantic vectors — FTS5 + importance/recency/confidence only), i.e. the worst-case constrained-environment configuration. Real embedding providers add paraphrase recall on top. Scale caveat: these are personal-scale figures (hundreds to ~1K memories, linear vector scan); 10K+ retrieval is unbenchmarked — treat performance claims beyond that as unproven.

On the external **engram-v3** benchmark (LongMemEval-format, 50 multi-session QA questions, LLM-judged): **96.0%** (48/50) — ingest the haystack sessions, retrieve, answer from retrieved memories only. Full results, metric caveats, and reproduction commands: [BENCHMARKS.md](BENCHMARKS.md).

Lifecycle tests prove the full pipeline: episode → extraction → conflict detection (or `entityKey` supersession) → retrieval excludes the stale fact.

Behavioral evals go beyond retrieval ranking and test outcomes — the failure modes most memory systems never measure: does an entity update actually replace the old fact at retrieval time, does stale feedback demote a memory out of default retrieval and out of the digest, do disputed results carry a warning qualifier, does repeated feedback converge confidence instead of oscillating.

## Privacy

- **Export:** `GET /v1/export` — full JSON dump of all non-deleted memories
- **Purge:** `POST /v1/purge` — hard-deletes rows, embeddings, and links
- **Auth:** set `SYNAPSE_TOKEN` env var to require Bearer auth on all `/v1/*` routes
- **Audit:** export and purge actions are logged to the audit table
- **Network:** the API binds `127.0.0.1` by default. To expose it beyond loopback set `SYNAPSE_HOST=0.0.0.0` — and set `SYNAPSE_TOKEN` when you do, or `/v1/export` and `/v1/purge` are reachable unauthenticated.

### Where your data goes

Storage and retrieval are local — SQLite on your disk. "Local-first" here means the store and ranking never need a network; some optional features do talk to endpoints you configure:

- **Consolidation** (`POST /v1/jobs/consolidate`): new episodic memories are sent to the LLM at `SYNAPSE_LLM_BASE_URL` (default `https://api.openai.com/v1`) to extract semantic facts. Point it at a local model (e.g. Ollama) to keep everything on-device.
- **Embeddings:** the default `hash` provider makes no network calls (and no semantic vectors — see the provider matrix below). `openai` sends memory text to whatever endpoint you configure (localhost for Ollama; a third party for hosted APIs). `local` (transformers.js) downloads the model once from HuggingFace, then runs fully on-device.

With the defaults (hash, no consolidation), no memory content ever leaves your machine and no network request is made. With `local` embeddings, the only network traffic is the one-time model download.

## Choosing your embedding provider (plug and play)

Everything is switchable by env var — no code changes. Honest expectations per provider:

| Provider | Env | Semantic? | Install weight | Network |
|---|---|---|---|---|
| `hash` (default) | `SYNAPSE_EMBED_PROVIDER=hash` | **No** — deterministic char-frequency vectors | zero extra | none |
| `openai` — any OpenAI-compatible endpoint, incl. **Ollama** | `SYNAPSE_EMBED_PROVIDER=openai SYNAPSE_EMBED_BASE_URL=... SYNAPSE_EMBED_MODEL=...` (`SYNAPSE_EMBED_API_KEY` if the endpoint needs one) | Yes | zero extra | per-request to the endpoint (localhost for Ollama) |
| `local` — transformers.js | `SYNAPSE_EMBED_PROVIDER=local` (+ optional `SYNAPSE_EMBED_MODEL=Xenova/bge-small-en-v1.5`) | Yes | **heavy, opt-in**: `npm i @huggingface/transformers` pulls the ONNX runtime (~100MB+ native binaries); model (~25MB) downloads once from HuggingFace | one-time model download, then fully on-device |

**Default selection:** an explicit `SYNAPSE_EMBED_PROVIDER` always wins. Otherwise, if `SYNAPSE_EMBED_API_KEY` or `SYNAPSE_EMBED_BASE_URL` is set, Synapse assumes `openai`. Otherwise it runs `hash` and prints a loud startup warning: in hash mode the vector term is disabled entirely (no noise in the ranking) and retrieval works on FTS5 keyword search + importance/recency/confidence — genuinely useful for structured/keyword-ish recall, blind to paraphrase. Semantic dedup/absorb at write time is also disabled in hash mode, so near-duplicate wording is stored rather than mis-merged.

**Recommended path for constrained environments** (containers, no native toolchain, small disks): Ollama — real embeddings, no npm-install weight: `ollama pull nomic-embed-text`, then the `openai` row above with `SYNAPSE_EMBED_BASE_URL=http://localhost:11434/v1`.

**After switching provider or model, run `npx -y synapse-os reembed`** — it re-embeds every stored memory with the new model. Without it, old memories keep vectors the new model can't compare against and silently fall back to keyword-only scoring.

The LLM for consolidation/conflict jobs is equally pluggable: `SYNAPSE_LLM_BASE_URL` + `SYNAPSE_LLM_MODEL` + `SYNAPSE_LLM_API_KEY` accept any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, ...). Library users can go further and inject any `EmbeddingProvider` implementation directly into `RetrievalService`/`writeMemory`.

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

GPL-3.0-only — see [LICENSE](LICENSE).
