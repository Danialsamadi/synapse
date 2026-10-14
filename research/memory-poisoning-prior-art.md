# Prior art: provenance and memory poisoning in agent-memory systems

Research for [#7](https://github.com/Danialsamadi/synapse/issues/7) (map [#6](https://github.com/Danialsamadi/synapse/issues/6), provenance tiers).
Sources accessed 2026-10-14. Repo claims are pinned to the commit that was read. "Not found" means
"not found in the cited docs, or in a grep of the cited commit". It does not mean "proven absent".

This document reports facts and options only. It makes no decisions; those belong to the grilling tickets on #6.

---

## TL;DR

1. **No shipping memory product found here gates writes on provenance.** mem0, Letta, Zep/Graphiti and MemPalace all
   record *some* origin metadata: scope ids, role, episode links, `source_file`, `added_by`. None of them uses it to
   decide what may overwrite, pin or summarise what. ChatGPT and Gemini rely on a user-visible "memory updated"
   notice plus manual review. Rehberger showed that untrusted content can still write memories through that path.
2. **Over MCP, every tool argument is model-authored.** A `source: "user"` or `tier` argument is attacker-writable
   whenever the model has read untrusted content. The mem0 and MemPalace equivalents (`attributed_to`, `added_by`) are
   LLM guesses or caller strings. The one MCP-native path with a human in it is **elicitation**. Form mode is attested
   only by the client. URL mode (spec 2025-11-25+) sends the user out of band to a page the *server* hosts.
3. **Channel ceiling plus `min(provenance, content)` is the only rule with a measured result against volumetric
   overwrite.** In a synthetic harness, a 50-vs-4 poison flood scored 0% attack success, while last-write-wins was
   flipped by a single write (Singh 2026). It costs real utility: legitimate corrections that arrive on a low tier are
   also blocked (100% → 54% average accuracy).
4. **Tiering without propagation is "fully defeated" by laundering.** If poison passes through a trusted intermediary
   (a tool, a consolidation step, or a summariser) and the output inherits the intermediary's tier, attack success
   returns to 100%. MemLineage's "inherit the riskiest strong parent" rule closes this in its own harness.
5. **Detection-only defenses are an arms race.** LLM-judge filters caught 0/135 MINJA records on one agent.
   Perplexity filtering and query rephrasing leave AgentPoison at 47–62% attack success. A-MemGuard reports a >95%
   reduction, and a later paper (FARMA) reports beating A-MemGuard.
6. **Newest-wins supersession is the amplifier.** Graphiti says it "consistently prioritizes new information" when
   invalidating edges. That is exactly the property a volumetric or recency attack exploits.

---

## 1. Systems

### mem0 (mem0ai/mem0 @ `d26ba5e`, 2026-10-12)

- **Scope ids.** Writes are scoped by `user_id` / `agent_id` / `app_id` / `run_id`, plus optional `metadata`
  ([docs: add](https://docs.mem0.ai/core-concepts/memory-operations/add)). These are partitions, not trust levels.
- **`infer=False` path.** Each message is stored verbatim with `role` and `actor_id` (from the message's `name`), and
  system messages are skipped ([`mem0/memory/main.py`](https://github.com/mem0ai/mem0/blob/d26ba5e4518cef7fff3c66d4f715b21adf9feabe/mem0/memory/main.py)).
  The caller supplies the role, and nothing verifies it.
- **`infer=True` path (V3 "additive" pipeline).**
  - A single LLM call extracts memories. Each memory carries an LLM-assigned `attributed_to: "user" | "assistant"`:
    "Use 'user' for facts stated by or about the user … 'assistant' for information provided by the assistant"
    ([`mem0/configs/prompts.py`](https://github.com/mem0ai/mem0/blob/d26ba5e4518cef7fff3c66d4f715b21adf9feabe/mem0/configs/prompts.py)).
  - **The LLM therefore makes the provenance call, and it can be wrong or manipulated.**
  - Older prompts ask the extractor to "GENERATE FACTS SOLELY BASED ON THE USER'S MESSAGES". That is an instruction,
    not an enforcement.
- **Security posture.**
  - mem0's own post ([AI memory security best practices](https://mem0.ai/blog/ai-memory-security-best-practices))
    lists what ships: scoping, encryption, audit logs, SQL parameter binding, include/exclude rules and decay.
  - It *recommends* "trust-scored retrieval" and input sanitisation but does not claim to ship them.
  - No trust gating was found in `main.py` at the cited SHA.
- **Cost.** One LLM call per add (extraction). `attributed_to` adds nothing to that.

### Letta / MemGPT

- **Core memory blocks.** These have `label`, `description`, `value`, `limit` and `read_only`. With `read_only: true`,
  the agent cannot edit the block through its memory tools, but developers can still edit it through the API
  ([docs: memory blocks](https://docs.letta.com/guides/agents/memory-blocks)).
- **Shared blocks.** Shared blocks are "update once, visible everywhere". The docs recommend read-only shared blocks
  for policies.
- **What this amounts to.** An **edit-permission bit per block**, set by the developer. It is the closest existing
  analogue to "only raisable by explicit user promotion", but it covers mutability, not origin.
- **Archival memory.** Passages are inserted by the agent tool `archival_memory_insert(content, tags)` or by the SDK
  ([docs: archival memory](https://docs.letta.com/guides/agents/archival-memory)). Tags are free-form; no source or
  trust field was found.
- **Concurrency.** Concurrent writers are last-write-wins on a block (memory-blocks doc).
- **Cost.** Essentially free: one boolean. It does nothing about *what* the agent writes into writable blocks.

### Zep / Graphiti

- **Episodes as provenance.**
  - Every ingest is an **episode** (`message` / `text` / `json`) with `source`, `source_description` and
    `reference_time` ([Graphiti: adding episodes](https://help.getzep.com/graphiti/core-concepts/adding-episodes)).
  - Extracted entities link back to it through `MENTIONS` edges.
  - The paper: "Episodes and their derived semantic edges maintain bidirectional indices", so facts "can be traced to
    their sources for citation or quotation" ([Rasmussen et al., arXiv:2501.13956](https://arxiv.org/html/2501.13956v1)).
- **Bi-temporal edges.** Edges carry `t_valid`/`t_invalid` (world time) and `t'_created`/`t'_expired` (system time).
- **Contradictions and supersession.**
  - An LLM compares each new edge against related ones. On a contradiction, it sets `t_invalid` on the old edge.
  - "Graphiti consistently prioritizes new information when determining edge invalidation" (paper §2.2.3).
- **Takeaway.** The lineage is strong and queryable, but **supersession is gated by recency, not by trust**. A later
  poisoned episode invalidates an earlier true fact by design.
- **Cost.**
  - Lineage costs storage and an extra edge per mention.
  - Each invalidation check costs an LLM call.
  - No trust signal was found in the docs or the paper.

### MemPalace (MemPalace/mempalace @ `1392e18`, 2026-10-13)

- **Write path.**
  - Content is stored verbatim ("drawers"), with `source_file`, `added_by` and date-provenance fields:
    `filed_at`, `authored_at_source`, `content_date_source` ∈ {filename, frontmatter, body, mtime, unknown}.
  - Provenance is recorded at mine time and never reconstructed for legacy drawers
    ([`CHANGELOG.md`](https://github.com/MemPalace/mempalace/blob/1392e1810c3ca67776bd7fe3e198788a96dbd6d1/CHANGELOG.md),
    [`website/reference/mcp-tools.md`](https://github.com/MemPalace/mempalace/blob/1392e1810c3ca67776bd7fe3e198788a96dbd6d1/website/reference/mcp-tools.md)).
- **`added_by`** is a caller-supplied string that **defaults to `"mcp"`** (mcp-tools.md). That is the
  channel-as-default idea, but it is not enforced as a ceiling.
- **Knowledge-graph triples** carry `confidence`, `source_closet`, `source_file`, `source_drawer_id` and `adapter_name`
  ([api-reference.md](https://github.com/MemPalace/mempalace/blob/1392e1810c3ca67776bd7fe3e198788a96dbd6d1/website/reference/api-reference.md)).
- **Remediation, not prevention.**
  - `mempalace_delete_by_source` deletes every drawer from one source, is dry-run by default and is audited.
  - Its changelog note #2325 is relevant: stale LLM-derived index entries ("closets") kept quoting retracted text and
    out-ranked the corrected drawer until deletes purged them. This is the **derived-artifact laundering** problem
    seen in practice.
- **Sanitisation.** `sanitize_content` checks only length, null bytes and surrogates (`mempalace/config.py`). The
  roadmap mentions "query sanitization: system prompt contamination mitigation".
- **No trust gating** was found in a grep of the cited SHA.

### ChatGPT memory (and Gemini, Copilot)

- **Two kinds of memory.** OpenAI describes "saved memories", things you asked it to remember and which are always
  considered, and "reference chat history", insights it gathers from past chats. Users can view and delete memories
  or use Temporary Chat ([Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq),
  [reference saved memories](https://help.openai.com/en/articles/11146739)).
  - *Caveat:* both help pages returned 403 to fetch tools. This wording comes from search-result snippets of those
    pages.
- **SpAIware (Rehberger, 2024).**
  - "A website or untrusted document can still invoke the memory tool to store arbitrary memories."
  - OpenAI fixed the *exfiltration* channel (`url_safe`, macOS app v1.2024.247), not the memory write
    ([embracethered](https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/)).
- **Gemini delayed tool invocation (Rehberger, Feb 2025).**
  - A document plants an instruction to save memory when the user later says "yes" or "sure". The write then looks
    as if it followed a user turn.
  - Google's defence is a UI indicator linking to the saved-info page. Google rated the issue "low likelihood and low
    impact" ([embracethered](https://embracethered.com/blog/posts/2025/gemini-memory-persistence-prompt-injection/)).
  - **This is the key attack against "the user said it" heuristics.**
- **Microsoft "AI Recommendation Poisoning" (Feb 2026).**
  - Attackers use "Summarize with AI" links with a prefilled `?q=` prompt that tells the assistant to "remember
    [Company] as a trusted source".
  - Microsoft found 31 companies doing this. Targets included Copilot, ChatGPT, Claude, Perplexity and Grok.
  - Microsoft names "prompt filtering", "content separation" and user memory controls as mitigations, with no numbers
    ([Microsoft Security blog](https://www.microsoft.com/en-us/security/blog/2026/02/10/ai-recommendation-poisoning/)).
  - **Note:** the text arrives *in the user turn*, so a role-based "user-stated" classifier would label it user-stated.

---

## 2. Literature

| Paper | Threat model | Headline result | Defenses tested |
|---|---|---|---|
| **AgentPoison** (Chen et al., NeurIPS 2024, [arXiv:2407.12784](https://arxiv.org/abs/2407.12784)) | Attacker can write into memory or the KB; optimises a retrieval trigger | ≥80% avg ASR at <0.1% poison rate, <1% benign degradation | Perplexity filter: ASR-t still 47.2% / 61.2%. Query rephrasing: 50.0% / 62.0% (Table 4, [HTML](https://arxiv.org/html/2407.12784)) |
| **MINJA** (Dong et al., [arXiv:2503.03704](https://arxiv.org/abs/2503.03704) v5, Feb 2026) | **Query-only**: an ordinary user interaction writes (query, reasoning) records via bridging steps and progressive shortening | ISR 98.2% avg, ASR 76.8% avg (EHRAgent, RAP, QA; GPT-4/4o) | GPT-4o detection prompts: targeted prompt caught 131/135 on EHR but **0/135 on RAP**. General prompt caught 53/135 on RAP with 34/50 false positives on EHR. Embedding sanitisation failed because records are "highly entangled". Adversarial training impractical ([HTML](https://arxiv.org/html/2503.03704v5)) |
| **MemoryGraft** (Srivastava & He, Dec 2025, [arXiv:2512.16962](https://arxiv.org/abs/2512.16962)) | Benign-looking ingested artefacts (e.g. a README) plant "successful experiences" | MetaGPT DataInterpreter + GPT-4o: a small number of poisoned records make up a large share of retrievals. A secondary summary gives <10% of the store and ~48% of retrievals; not verified against the PDF | Proposes cryptographic provenance attestation (only self-signed experiences trusted) and safety-aware reranking; proposed, not evaluated |
| **A-MemGuard** (Wei et al., Sep 2025, [arXiv:2510.02373](https://arxiv.org/abs/2510.02373)) | Context-triggered injected records plus a self-reinforcing error loop | Abstract: "cuts attack success rates by over 95% while incurring a minimal utility cost" | Consensus over multiple reasoning paths from related memories, plus a separate "lessons" memory. Per-query overhead: multiple reasoning paths; exact figure not extracted |
| **FARMA / SENTINEL** (Karamchandani et al., Jul 2026, [arXiv:2607.05029](https://arxiv.org/abs/2607.05029)) | Forged *reasoning* records with evasive wording and self-reinforcement | Up to 100% ASR; **overcomes keyword filters and A-MemGuard** | SENTINEL structural "Reasoning Guard": 0% ASR, 0 FPs on 326 benign traces (authors' eval); cost not reported |
| **MemAudit** (Tan et al., May 2026, [arXiv:2605.23723](https://arxiv.org/abs/2605.23723)) | MINJA-style query-only injection | Post-hoc: QA ASR 70%→0%, reasoning agent 83.3%→0% | Counterfactual influence score plus a consistency graph; **forensic** (finds culprits after harm), cost not reported |
| **MemLineage** (Ouyang & Hou, May 2026, [arXiv:2605.14421](https://arxiv.org/html/2605.14421v1)) | AgentPoison, MemoryGraft, "sleeper-via-derivation" (laundering through LLM derivation) | Deterministic harness: ASR 1.0→0.0 on all three. A signature-only baseline stops AgentPoison but **not** MemoryGraft or derivation laundering. AgentDojo live: blocks 6/6 banking pairs | See §3 |
| **Singh, "When does belief-based agent memory help?"** (Jul 2026, [arXiv:2606.22030](https://arxiv.org/abs/2606.22030)) | Volumetric fact overwrite; authoritative phrasing; laundering via a trusted tool | Provenance-capped: 0% ASR up to M=50 vs 4 trusted. LWW / append / content-trusted reach 100% | See §3 |
| **CaMeL** (Debenedetti et al., 2025, [arXiv:2503.18813](https://arxiv.org/abs/2503.18813)) | Prompt injection in tool-using agents (not memory-specific) | Capability/data-flow tracking: provable security on 77% of AgentDojo tasks vs 84% utility undefended | Full IFC; out of scope for Synapse per #6, cited as the cost ceiling of "full taint" |

**Industry framing.** OWASP's Top 10 for Agentic Applications 2026 (published 2025-12-09) lists Memory & Context
Poisoning as ASI06 ([OWASP](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)).
The mitigation text quoted around the web ("use provenance and trust scores to decay or expire low-trust entries",
"segment memory") came from secondary summaries here; the official PDF was not read.

---

## 3. The mechanisms that bear directly on Synapse's draft

### 3.1 Channel ceiling, with content only able to lower trust (Singh 2026)

> "Each observation carries reliability r = min(provenance, content): content confidence may only lower trust within
> a channel's provenance ceiling, never raise it." (§9)

> "a signal the attacker can write cannot be the trust anchor, which is why trust must come from provenance, which
> the attacker does not control." (§9)

- **Table 6 (400 trials per cell, poison on a channel tiered 0.2).**

  | Strategy | M=1 | M=3 | M=10 | M=50 |
  |---|---|---|---|---|
  | Last-write-wins | 100 | 100 | 100 | 100 |
  | Append (majority) | 0 | 0 | 100 | 100 |
  | Content-trusted | 100 | 100 | 100 | 100 |
  | Provenance-capped | 0 | 0 | 0 | 0 |

  Ablating the source signal returns ASR to 100%, so the provenance signal, not the Bayesian arithmetic, is what
  defends.
- **Bound.** The guarantee holds for channel trust ≤ 0.5 at any volume and fails above about 0.55.
- **Content-inferred trust is gameable.** An "authoritative-style" poison scored mean reliability 0.96 vs 0.25 for
  hedged text. This bears on keeping `confidence` separate from tier.
- **Cost (measured).** A *true* correction routed through tier 0.3 drops accuracy from 100% to **54% on average**: 21%
  in the high-noise regime, 88% in the sparse-conflict regime. "the same mechanism, opposite ground truth."
- **Evidence level.**
  - Tiers come from an oracle ("each source receives a tier from its channel; we do not learn or verify tiers").
  - Synthetic benchmark plus one coding-assistant harness. Single author, preprint.

### 3.2 Laundering and propagation

- **Singh §9.** "If laundered content inherits the intermediary's high tier, attack success returns to 100%:
  provenance tiering alone is fully defeated by laundering." Only down-tiering to the untrusted origin restores 0%.
  The author characterises this but does not implement it.
- **MemLineage implements it.**
  - **Trust labels.** Trusted(0) / Derived-Trusted(1) / Derived-Untrusted(2) / External(3).
  - **"Max-of-strong-edges".** A derived entry inherits the *riskiest* parent among parents whose attribution weight
    is ≥ τ. Weaker edges are dropped.
  - **Attribution methods.** Coarse (1.0 if retrieved), an LLM self-eval judge, or white-box attention.
  - **Fail-open edge, flagged by the authors.** With no strong parent, the entry defaults to **Trusted**, which "risk[s]
    edge-suppression attacks". The safe τ also shrinks as the derivation chain length K grows.
  - **Enforcement.** A sensitive-action gate with Allow / Deny / Require-User / Strip-and-Retry / Repair-and-Retry
    verdicts. Each entry carries an Ed25519 signature anchored in a Merkle log.
  - **Cost.** "Sub-millisecond per-operation overhead". The LLM-judge attribution option adds an LLM call.
- **Practical echo.** MemPalace #2325: LLM-derived index entries kept quoting retracted text and out-ranked the fix.

### 3.3 Distinguishing user-stated from agent-inferred over MCP

- **Tool arguments are model-authored.** The MCP server sees only `tools/call` arguments that the model produced. Any
  self-declared `tier` or `source` argument is attacker-reachable once the model has read untrusted text: SpAIware,
  Gemini delayed invocation, MemoryGraft.
- **Prior art that tries anyway.**
  - mem0: an LLM labels `attributed_to`.
  - MemPalace: the caller supplies `added_by`, default `"mcp"`.
  - ChatGPT/Gemini: a memory tool the model invokes, plus UI notification.
  - None has a measured false-attribution rate.
- **User-turn text is not user-authored intent.** The Microsoft recommendation-poisoning case puts attacker text
  *in the user turn* through a prefilled URL. Gemini's case makes the write *follow* a genuine user "yes".
- **MCP elicitation, form mode** ([spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation)).
  - The server asks the client to show the user a form. The response is `accept` / `decline` / `cancel`.
  - The data passes through the client, and the user-interaction duties fall on the client.
  - The [latest spec](https://modelcontextprotocol.io/specification/latest/client/elicitation) (2026-07-28 links)
    upgrades several to MUSTs ("Provide UI that makes it clear which server is requesting information"; "allow users
    to review and modify their responses").
  - The server still cannot verify that a human, and not an automated client, answered. **Client-attested.**
- **MCP elicitation, URL mode** (introduced 2025-11-25).
  - The server sends the user to a URL; the interaction "must *not* pass through the MCP client".
  - Clients MUST NOT open it without consent, MUST show the full URL, and MUST open it so that "the client or LLM"
    cannot inspect it.
  - The server MUST verify that the user who opens the URL is the one who started the request.
  - **The confirmation then happens on a page the server controls** (for Synapse, plausibly the inspector), outside
    the LLM's reach.
  - Cost: a context switch for the user, and client support for URL mode.
- **Spec stance on identity claims.** "Servers MUST NOT rely on client-provided user identification without server
  verification, as this can be forged."

### 3.4 Supersession and gating

- **Recency-gated supersession.** Graphiti (newest wins) and Letta blocks (last write wins) supersede by recency.
  Singh's Table 6 shows LWW flipped by **one** poisoned write.
- **Majority or append.** This survives small floods and falls at M=10.
- **Tier-gated supersession** (a lower tier may not invalidate a higher tier). This is Singh's capped rule applied to
  entityKey; it has no shipping precedent among the systems surveyed.
- **Pinning or always-in-context.**
  - ChatGPT "saved memories" are "always considered", so the highest-impact slot is filled by a model-invoked write.
  - Letta's `read_only` is the only developer-set protection seen, and it protects against *edits*, not against
    *what was written first*.

---

## 4. Proven vs hand-waved

Evidence levels:

- **A**: public benchmark, independent or reproducible.
- **B**: the authors' own or synthetic harness.
- **C**: a vendor claim with no numbers.
- **D**: none found.

| Mechanism | Where | Evidence | Cost |
|---|---|---|---|
| Scope / partition ids (`user_id`, `agent_id`) | mem0, MemPalace wings | D for poisoning (it is isolation, not trust) | ~0 |
| LLM-assigned author label (`attributed_to`) | mem0 V3 | D (no accuracy figure; attacker-steerable by construction) | 0 extra (rides on extraction) |
| Caller-asserted origin (`added_by`, `source_file`, `actor_id`) | MemPalace, mem0 | D as a defense; useful for forensics and bulk delete | ~0 |
| Per-block edit lock (`read_only`) | Letta | C (docs; protects mutability only) | ~0 |
| Episode lineage + bi-temporal invalidation | Graphiti | B for retrieval quality (DMR, LongMemEval); D for poisoning; recency wins | storage + LLM per invalidation |
| User-visible "memory updated" + manual review | ChatGPT, Gemini, Copilot | D; bypassed in public demonstrations (SpAIware, delayed invocation) | user attention |
| Prompt filtering / "content separation" | Microsoft | C | unknown |
| LLM-judge detection of poisoned records | MINJA §defenses | A-ish (benchmarked): **0/135 to 131/135 depending on agent; high FPs** | 1 LLM call/record |
| Perplexity filter, query rephrasing | AgentPoison | A-ish: ASR stays 47–62% | cheap / 1 LLM call/query |
| Consensus reasoning + lessons memory | A-MemGuard | B (>95% ASR cut); **reported beaten by FARMA** | several reasoning paths/query |
| Structural forgery detection | SENTINEL | B (0% ASR, 0/326 FP) | not reported |
| Post-hoc causal audit | MemAudit | B (MINJA ASR → 0%) | not reported; forensic only |
| Channel ceiling, `min(provenance, content)` | Singh 2026 | B (synthetic; oracle tiers) | **−46 pts avg accuracy on legit low-tier corrections** |
| Riskiest-parent tier inheritance + signed log + action gate | MemLineage | B (deterministic 1.0→0.0; AgentDojo 6/6 banking pairs) | sub-ms/op; Ed25519 per entry; τ tuning; fail-open no-parent default |
| Full capability / IFC | CaMeL | A (AgentDojo: 77% provably secure vs 84% utility) | interpreter + policy engine; −7 pts utility |
| Cryptographic provenance attestation | MemoryGraft (proposed) | D (not evaluated) | signing infra |

---

## 5. Options and tensions for the #6 grilling tickets (not decisions)

### Tier taxonomy

- **Observed shapes.**
  - **Binary-by-role:** mem0 user / assistant.
  - **Ordinal channel trust:** Singh's numeric tiers.
  - **Four-level lineage:** MemLineage's Trusted / Derived-Trusted / Derived-Untrusted / External.
- **Fit with Synapse's draft.** The draft *user-stated / agent-inferred / external* maps closely onto MemLineage, which
  adds a split for *derived* entries.
- **Open question.** Do consolidation outputs need their own tier, or do they inherit their parents' tiers? This is
  the map's "Consolidation & Hermes" open item.

### Telling user-stated from agent-inferred over MCP

- **Options seen.**
  - (a) Cap the MCP channel at agent-inferred, regardless of arguments, and promote only through inspector or CLI.
  - (b) Promote through form-mode elicitation. This is client-attested.
  - (c) Promote through URL-mode elicitation to a Synapse-hosted confirm page.
  - (d) Trust an LLM's or a caller's label, as mem0 and MemPalace do. No evidence supports this, and the attacks in
    §3.3 defeat it.
- **Tension.** Every option except (d) adds user friction to *every* durable user-stated fact that arrives over MCP.

### Gating rules

- **Supersession.**
  - Measured evidence favours "a lower tier cannot supersede a higher tier" over newest-wins.
  - The measured cost is that true corrections arriving on a low channel get stuck. Promotion is the escape hatch
    the draft already has.
- **Digest and pinning.**
  - No measured prior art was found.
  - ChatGPT's always-in-context saved memories are the cautionary example: they are model-written and pinned by
    default.
- **Laundering.**
  - Gating without propagation of tier through derivation is defeated (Singh: 100%).
  - The map excludes full taint tracking. A coarse "derived inherits the minimum tier of its inputs" rule
    (MemLineage-style, Coarse attribution) is the cheapest propagation seen.
  - Its "no parent ⇒ Trusted" fallback is a known hole.

### Evals (#6 "not yet specified")

- **Reusable attack shapes for `packages/evals`.**
  - Singh's volumetric flood (M ∈ {1, 3, 10, 50}).
  - Authoritative phrasing.
  - Laundering through a trusted intermediary.
  - MINJA query-only bridging.
  - Gemini delayed invocation (a write after the user says "yes").
  - Microsoft prefilled-prompt text in the user turn.
- **A metric pair.** Singh's "legit low-tier correction accuracy" is a ready-made utility metric to pair with ASR.
