# Synapse production-readiness — Phase 1 (ops) design

Date: 2026-07-22. Approved approach: "Trustable core" (harden + close credibility gaps).
Context: competitor research across sqlite-memory, agentmem, AIngram, Memori, CortexaDB,
engram variants showed Synapse leads on memory lifecycle but trails on install story,
retrieval credibility, and ops hygiene.

## Phases

- **Phase 1 (this spec):** packaging + release ops.
- **Phase 2:** local embeddings default, dedup-on-insert (reject ≥0.95 cosine, absorb
  0.92–0.95), LongMemEval subset benchmark published in README.
- **Phase 3:** thin Python client on PyPI wrapping the HTTP API.

## Phase 1 scope

### 1. npm package `synapse-mcp`
- `apps/mcp-server` becomes publishable: name `synapse-mcp`, `private: false`, `bin`.
- tsup bundles `@synapse/{core,store,embeddings,sdk}` into `dist/` (noExternal);
  `better-sqlite3` and `@modelcontextprotocol/sdk` stay external deps (prebuilds).
- Install story: `claude mcp add synapse -- npx -y synapse-mcp`.
- Startup guard: on `ERR_DLOPEN_FAILED` loading better-sqlite3, print an actionable
  rebuild hint instead of dying silently (monorepo preflight keeps auto-rebuild).

### 2. Unified DB path
- One helper: `SYNAPSE_DB` env override, else `~/.synapse/synapse.db`.
- CLI and API today default to `./.synapse/synapse.db` (cwd-relative) — they switch to
  the shared helper. Breaking for anyone relying on cwd-relative default; called out in
  CHANGELOG.

### 3. Schema migrations
- `PRAGMA user_version` + ordered `MIGRATIONS` array in `@synapse/store`, run in a
  transaction at repository open.
- Existing pre-versioning DBs (user_version=0, tables present): migrations are
  idempotent (`IF NOT EXISTS`), so replay-and-stamp adopts them safely.
- Fail closed: DB with `user_version` greater than the code knows → throw with a clear
  message, never write.

### 4. Backup / restore
- `synapse backup [dest]` — better-sqlite3 native `.backup()` (online-safe under WAL);
  default dest `<db>.backup-<iso-date>`.
- `synapse restore <src>` — refuses unless `--force`, copies over the live DB path.

### 5. Release hygiene
- CHANGELOG.md (keep-a-changelog), version 0.2.0, semver from here on.
- SECURITY.md (report channel, local-first threat model pointer to existing privacy doc).
- `.github/workflows/publish.yml`: on `v*` tag → build, test, `npm publish --provenance`
  (requires `NPM_TOKEN` secret — manual setup step).

## Out of scope (Phase 1)
Knowledge-graph links, RRF scoring, signed entries, Docker image, Python SDK.

## Testing
- Migration runner: unit tests — fresh DB, legacy v0-with-tables DB, future-version DB
  fails closed.
- Backup/restore: round-trip test on a temp DB.
- Package: `npm pack` smoke — run the packed tarball's bin against a temp DB and do a
  write/retrieve round-trip.
