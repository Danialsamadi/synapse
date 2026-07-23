# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Open-source developers running MCP-capable AI agents (Claude Code, Claude Desktop,
Cursor, OpenCode) who want their agents to have durable, local, private long-term
memory. They install `synapse-mcp` for their own use; they evaluate the project
through the README, the benchmark numbers, and the inspector. The maintainer
(Danial) is also a daily user, but the design target is the adopting stranger.

## Product Purpose

Synapse is a local-first personal memory operating system for AI agents: typed
long-term memory (episodic/semantic/procedural/working) on local SQLite, exposed
over MCP, HTTP API, and CLI. Success = a stranger installs it in one command,
their agent recalls facts across sessions, and they can see and trust exactly
what is stored, why it was retrieved, and how it changes over time.

## Positioning

The lifecycle is the moat: entityKey supersession, semantic dedup-on-insert,
conflict detection/resolution, decay half-lives, feedback-driven trust
qualifiers, and a full audit trail — the parts of agent memory the field
(Letta, LlamaIndex, Memori) is weakest at (see docs/COMPARISON.md). Runtime
stays library-shaped: no agent framework lock-in, the agent keeps its own loop.

## Operating Context

- Installed via `npx -y synapse-mcp` into an MCP client; memory lives at
  `~/.synapse/synapse.db`. Multiple agents may share the one DB file (WAL +
  busy_timeout).
- The inspector (`/inspector` on the local API, Hono-served static HTML) is the
  trust window: feed of audit events, memory browser with provenance drawer,
  analytics, health. Operate mode: developers debugging/verifying memory.
- Retrieval quality is benchmarked against LongMemEval; numbers go in the README.

## Capabilities and Constraints

- Tools: memory_write, memory_retrieve (minScore abstention, time-aware),
  memory_digest (budgeted, pinned-first, sectioned), memory_feedback.
- Local embeddings by default (all-MiniLM-L6-v2, no API key); hash/OpenAI
  selectable. LLM features (extraction, conflict resolution, benchmark) need an
  OpenAI-compatible key.
- Inspector is a single self-contained HTML file — no build step, no external
  CDNs, inline SVG charts only.
- Undecided: npm org/scope beyond `synapse-mcp`; Python SDK (planned Phase 3);
  sqlite-vec index (deferred until latency warrants).

## Brand Commitments

Name: Synapse. Banner: `Synapse.png`. Tagline (binding): "Chat history is a log.
Synapse is a brain." Voice (binding): plain-spoken, technical, evidence-first,
no hype — claims are backed by tests, benchmarks, or honest caveats (e.g. the
analytics tab discloses audit-log pruning instead of implying full history).

## Evidence on Hand

- 70+ passing tests across packages; 32-case eval harness; LongMemEval harness
  (`packages/evals/src/longmemeval.ts`) — real benchmark numbers pending an LLM
  key; do not fabricate numbers before a run.
- docs/COMPARISON.md — honest field comparison incl. named gaps.
- No testimonials, no user counts, no case studies — never invent them.

## Product Principles

1. Local-first and inspectable: every memory, retrieval, and mutation is
   visible and auditable by the owner; nothing leaves the machine by default.
2. Deterministic runtime, reasoning model: memory writes/lifecycle are code
   policy, never model whim.
3. Evidence before claims: benchmark numbers, test counts, and disclosed
   caveats over adjectives.
4. Library, not framework: integrate into any agent loop; never require ours.
5. Strangers first: one-command install and a trustworthy first 10 minutes
   outrank maintainer convenience.

## Accessibility & Inclusion

Sensible defaults for the web inspector: keyboard reachability and readable
contrast; no formal WCAG target committed.
