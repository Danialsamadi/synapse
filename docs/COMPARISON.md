# Synapse vs the agent-memory landscape

How Synapse compares to production memory systems (Letta/MemGPT, LlamaIndex Memory),
the academic benchmarks (LongMemEval, LoCoMo, BEAM), and practitioner consensus
(CoALA taxonomy, HF forum, field guides). Written 2026-07-23.

## The consensus, and where Synapse stands

Across every serious source, the same architecture keeps winning:

| Consensus principle | Synapse |
|---|---|
| Runtime owns memory; the model is only the reasoning engine | ✅ Deterministic `writeMemory()` path — dedup, supersession, conflict policy are code, not model whim |
| Typed records with metadata (type, timestamp, source, confidence, status) | ✅ Four CoALA types (episodic/semantic/procedural/working) + importance, confidence, sourceRefs, status |
| "Persist broadly, retrieve narrowly" — hot/cold split | ✅ SQLite store + hybrid-scored top-k with token budget; digest for always-hot facts |
| Vector search alone is insufficient — pair with keyword/structured/temporal | ✅ Hybrid score: vector + keyword + importance + recency − decay − conflict; since/until filters |
| Summaries bleed; prefer structured fact extraction | ✅ Episodic → semantic fact extraction with entityKey anchoring, not prose summaries |
| Forgetting is the hardest open problem | ✅ Strongest area: decay half-lives, supersession chains, feedback (helpful/stale/wrong), purge |
| Over-retrieval harms reasoning (K≈15 sweet spot, per BEAM) | ✅ Capped limits + token-budget packing |
| Privacy: erasure, audit trails | ✅ Audit log, export, purge, local-first by default |

Synapse independently converged on the field's consensus architecture — and is ahead
of most named systems on lifecycle (the thing practitioners call hardest).

## Against the named systems

**Letta (MemGPT).** The reference for *self-editing* memory: size-capped memory
blocks pinned into context, archival search, sleep-time consolidation. Its praised
property — evict-but-never-delete — Synapse shares (superseded ≠ deleted). Its
criticized property — nondeterministic agent-driven writes that accumulate wrong
facts — is exactly what Synapse's deterministic write path avoids. What Letta has
that Synapse's digest lacks: per-block size limits, priorities, and descriptions
that force curation. What Letta costs: your whole agent must live inside its
runtime. Synapse is a library/MCP server; any agent keeps its own loop.

**LlamaIndex Memory.** Automatic fact extraction with token-budget flushing —
reliable but shallow. Its #1 criticism (vector-only retrieval: no keyword, no
temporal, no entities) is precisely what Synapse's hybrid scorer and entityKey
model address. Its priority-based truncation (priority 0 = never cut) is worth
copying into the digest.

**Benchmarks.** LongMemEval (ICLR 2025, MIT, 500 questions) shows commercial
assistants drop 30–60% accuracy on sustained interaction; weakest abilities are
temporal reasoning, knowledge updates, and abstention. Synapse's entityKey
supersession is purpose-built for knowledge updates; temporal filtering exists but
isn't query-aware; abstention is unhandled. BEAM (ICLR 2026) finds contradiction
resolution the open problem across all systems — Synapse ships conflict
detection/resolution today, which is rare. LoCoMo is cheap but has a
non-commercial license and lexical-F1 scoring issues; LongMemEval is the benchmark
Synapse targets.

## Honest gaps

1. **No published benchmark number** — every credible competitor posts one.
2. **Digest is a flat dump** vs Letta's budgeted, prioritized, described blocks.
3. **No abstention signal** — retrieval always returns top-k, even when nothing is
   actually relevant; benchmarks punish this hard.
4. **Temporal queries aren't parsed** — "since"/"until" filters exist but the
   system doesn't map "last week" onto them.
5. **No knowledge-graph traversal** — links exist (supersedes/supports/derived_from)
   but retrieval doesn't walk them. The field disagrees on whether this matters;
   only graph-native systems push it.
