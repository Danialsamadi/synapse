# Changelog

All notable changes to Synapse are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-08-26

### Added
- CLI inside the published `synapse-os` package: `remember`, `query`, `list`, `get`,
  `delete`, `import`, `export`, `reembed`, `backup`, `restore` — same store, env,
  and write guards as the MCP server. No args (or `mcp`) still starts the stdio
  MCP server, so existing `npx -y synapse-os` client configs keep working.
- Hermes / constrained-environment guide (`integrations/hermes/`): correct
  `env:`-object MCP YAML, `--ignore-scripts` install path, Ollama embeddings,
  episodic cron-log patterns (no entityKey on run logs), WAL read-only inspect.
- Startup embedding report on stderr: active provider + whether vectors are
  semantic; loud warning in hash mode. `GET /health` now reports the same.
- Daily TTL/decay re-sweep in long-lived MCP processes (was startup-only).

### Changed
- **Breaking (defaults):** embedding provider default is no longer `local`.
  Selection: explicit `SYNAPSE_EMBED_PROVIDER` wins; a configured
  `SYNAPSE_EMBED_API_KEY`/`SYNAPSE_EMBED_BASE_URL` implies `openai`; otherwise
  `hash`. `npx -y synapse-os` no longer forces the transformers.js/ONNX stack —
  `@huggingface/transformers` moved from a hard dependency to an optional peer
  (install it explicitly for `SYNAPSE_EMBED_PROVIDER=local`).
- Non-semantic embeddings (hash) no longer inject noise: the vector score term
  is disabled, retrieval candidacy is FTS5-keyword-only, and write-time semantic
  dedup/absorb is skipped. Golden-case evals are now measured in this worst-case
  mode (precision@5 0.969, stale 0.000, pass 0.969).
- Episodic memories are never semantically absorbed/deduped — distinct cron run
  logs with near-identical wording all survive (exact-content dedup still applies).
- README: honest provider matrix (size/network/toolchain per provider), local-first
  and scale claims scoped to what is measured, stdio-vs-HTTP packaging clarified.
- Graph-aware retrieval: 1-hop link expansion — a hit on a "chapter" memory pulls
  its "book" along via part_of/related_to links at half score, filling leftover
  limit slots; supersedes/contradicts edges are never followed. New `part_of`
  link relation.
- Plug-and-play embeddings: `SYNAPSE_EMBED_MODEL` now selects the local HF model;
  `synapse reembed` re-embeds every memory after a provider/model switch; README
  gains a provider matrix (local, custom HF model, Ollama, OpenAI, hash).
- Inspector first-run guide: "?" panel explaining the feed's tick colors, drawer
  provenance, analytics, and health — auto-opens once, Escape closes overlays.
- Inspector color redesign: "bioelectric" palette (cobalt current, teal writes,
  ochre supersession, vermilion conflict, cyan dedup) composed for both themes.
- Inspector fonts: system stacks replace Google Fonts — the page now makes zero
  external requests, matching the local-first promise.
- Inspector dark mode: composed dark palette (not inverted), system-default with
  a header toggle persisted in localStorage; all colors flow through tokens.
- Inspector motion: new feed events land with an action-colored pulse, analytics
  bars grow in with capped stagger; respects prefers-reduced-motion.
- Inspector Analytics tab: 14-day write/retrieval activity and lifecycle charts
  (inline SVG), retrieval quality stats (latency, candidates, empty-result and
  dedup rates), hot-memories table, cold share — backed by GET /v1/analytics.
- Inspector: dedup/absorb feed events rendered with links + filterable; Health tab
  shows the active embedding provider.
- Multi-agent write safety: busy_timeout=5000 alongside WAL, so concurrent
  writers wait instead of failing with SQLITE_BUSY.
- Digest v2: token budget, pinned memories never cut (Letta priority-0 semantics),
  typed sections with usage descriptions in the rendered text.
- Time-aware retrieval: relative time phrases in queries ("yesterday", "last week",
  "3 days ago") map onto since/until filters; explicit filters still win.
- LongMemEval benchmark harness (`pnpm --filter @synapse/evals longmemeval`):
  oracle/S variants, dry-run mode, built-in LLM judge with per-ability accuracy,
  upstream-compatible hypotheses.jsonl.
- Abstention: `minScore` on retrieval (core schema, RetrievalService, MCP
  `memory_retrieve`); empty results carry an explicit don't-fabricate note.
- Local semantic embeddings by default (all-MiniLM-L6-v2 via transformers.js, 384 dims,
  ~25MB one-time download, no API key). `SYNAPSE_EMBED_PROVIDER=hash|openai` overrides.
- Semantic dedup-on-insert in the shared `writeMemory()` path: cosine ≥ 0.95 returns the
  existing memory, 0.92–0.95 absorbs (tag union + freshness touch). Skipped for
  entityKey writes, where supersession is the intended resolution.

### Fixed
- memory_retrieve now includes each memory's createdAt — without it, agents
  could not answer "what did I tell you today" even when retrieval returned
  the right memories.
- Retrieval no longer compares embeddings of mismatched dimensions (different
  providers); such pairs score 0 instead of noise.

## [0.2.0] - 2026-07-22

### Added
- Publishable `synapse-mcp` npm package — install with `claude mcp add synapse -- npx -y synapse-mcp`.
- Versioned schema migrations (`PRAGMA user_version`); fails closed when a database
  was written by a newer version of Synapse.
- `synapse backup [dest]` (online SQLite backup, safe while running) and
  `synapse restore <src> --force`.
- MCP-server preflight that auto-rebuilds `better-sqlite3` after a Node upgrade
  (monorepo dev only).

### Changed
- **Breaking:** project renamed Mneme → Synapse. Packages `@mneme/*` → `@synapse/*`,
  env vars `MNEME_*` → `SYNAPSE_*`, CLI command `mneme` → `synapse`, data dir
  `.mneme/` → `.synapse/`.
- **Breaking:** CLI and HTTP API default database path is now `~/.synapse/synapse.db`
  (was `./.synapse/synapse.db` relative to the working directory). Set `SYNAPSE_DB`
  to keep an existing location.
- `better-sqlite3` upgraded to v12 (prebuilt binaries for current Node versions).

## [0.1.0]

Initial development: memory tools (`memory_write`, `memory_retrieve`, `memory_digest`,
`memory_feedback`), hybrid retrieval scoring, entityKey supersession, conflict
detection, decay, consolidation jobs, audit log, inspector UI, HTTP API, CLI, evals.
