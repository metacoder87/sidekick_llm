# Sidekick LLM — Architecture

This document describes how Sidekick is built as of the current codebase. It is the
canonical technical reference; [ROADMAP.md](ROADMAP.md) covers intent and direction,
and [sidekick_plan.md](sidekick_plan.md) is the original design sketch (historical).

---

## 1. System overview

Sidekick is an offline-first Electron desktop app. Two local services back it — the
**Ollama** HTTP server (inference + embeddings) and a **SQLite** database (the
corpus). Nothing leaves the machine except optional, user-initiated web search.

```
┌──────────────────────────────────────────────────────────────────────┐
│ RENDERER (React 18 + Vite)                                            │
│  Sidebar · ChatView · Composer · Settings & Memory Vault ·           │
│  Specialist Picker (multi-select panel) · Specialist Trainer         │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  contextBridge IPC  (electron/preload.cjs)
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ MAIN PROCESS (Node in Electron)                                      │
│  ipc.cjs — handler registry & the message pipeline                   │
│  ┌──────────────┬───────────────┬────────────────┬────────────────┐  │
│  │ Ollama client│ MemoryManager │ DeepResearch   │ Search + Scrape│  │
│  │ (chat/embed) │ (facts/summary│  Worker        │ (multi-provider│  │
│  │              │  /RAG recall) │ (ingest/research│  + fallback)   │  │
│  ├──────────────┴───────────────┴────────────────┴────────────────┤  │
│  │ ConversationRepository — SQLite: schema, migrations, backup,   │  │
│  │ FTS5, vector search, corpus export/import                      │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────┬──────────────────────────────────────────┘
                 ┌──────────┴───────────┐
                 ▼                      ▼
        ┌─────────────────┐    ┌────────────────────┐
        │ Ollama (local)  │    │ SQLite (sidekick.db│
        │ 11434           │    │  + WAL + backups)  │
        └─────────────────┘    └────────────────────┘
```

### Process & security model

- **Context isolation on, `nodeIntegration` off.** The renderer has no Node or
  filesystem access; it talks to the main process only through the narrow API
  exposed in [`electron/preload.cjs`](electron/preload.cjs) via `contextBridge`.
- **Channel registry.** All IPC channel names live in
  [`shared/channels.json`](shared/channels.json), imported by both preload and the
  main process so names can never drift.
- **CSP.** [`index.html`](index.html) restricts `connect-src` to localhost, matching
  the offline-first model.
- Renderer assets use a **relative base** (`vite.config.mjs` `base: './'`) so the
  packaged build loads correctly under Electron's `file://` protocol.

---

## 2. The message pipeline

`chat:sendMessageStream` in [`electron/ipc.cjs`](electron/ipc.cjs) assembles a
layered system prompt on every turn, then streams the model's reply back over IPC
events. Layers, in order:

1. **Base instruction** — "You are Sidekick…"
2. **User profile** — name, role, stack, tone, global instructions.
3. **Specialist panel** — for each consulted Expert: persona + instructions, plus
   its top vault matches (federated retrieval, §4).
4. **Contextual memory** — relevance-ranked user facts + cross-conversation vector
   recall + the rolling conversation summary (§5).
5. **Web search context** — scraped results with `[n]` citations, when enabled.

The reply is generated with the user's **chat model**; tokens are pushed to the
renderer via `events:streamUpdate`, finalized with `events:streamComplete`
(carrying citations and specialist grounding), and persisted. Three background
jobs then run non-blocking: rolling summary, fact extraction, and message
embedding.

> This handler is the most valuable and least-tested surface in the codebase;
> extracting a `ContextBuilder` is a tracked ROADMAP item.

---

## 3. Model roles (routing)

Three distinct model roles, so no single choice is overloaded (ROADMAP invariant #5):

| Role | Setting | Used for | Default |
|---|---|---|---|
| **Chat / reasoning** | `activeModel` | user-facing answers | user's free choice |
| **Embedding** | `embeddingModel` | all vectors (vaults, memory) | `nomic-embed-text` (768-d) |
| **Background / utility** | `backgroundModel` | summaries, fact extraction, research query generation | empty → falls back to chat model |

Embeddings are **always** produced by the dedicated embedding model, decoupled from
the chat model, so switching chat models never changes vector dimensions or orphans
a vault.

---

## 4. AI Experts & retrieval

An **Expert** (`specialist_hubs`) is a persona + a private vector vault
(`specialist_chunks`). Vaults are built by the **DeepResearchWorker**
([`electron/research/deepResearch.cjs`](electron/research/deepResearch.cjs)):

- **Document ingestion** — PDF (via `pdf-parse` v2 `PDFParse` class), or text/md/
  json/csv → chunked (~800 chars, 150 overlap) → embedded → stored.
- **Web Deep Research** — `deriveSearchQueries()` turns a topic *or a long research
  brief* into concrete queries (explicit quoted queries → short topic verbatim →
  LLM decomposition → heuristic). Each query runs through `performWebSearch`
  (configured provider → DuckDuckGo → Wikipedia fallback); result snippets are
  indexed directly and pages are scraped, chunked, embedded, and stored (cap 10
  sources).
- **Re-index** — `reindexHub()` re-embeds stored `chunk_text` with the current
  embedding model in place, repairing vaults built under a different/older model.

### The embedding contract (write boundary)

A chunk without a valid, dimension-matched vector is **invisible** to retrieval, not
merely degraded — so the system treats embeddings as a load-bearing invariant:

- `assertValidEmbedding` rejects empty/non-finite vectors at the write boundary.
- Every vector row stores `embedding_model` and `embedding_dim`.
- Retrieval (`searchSpecialistVectorMemory`) filters by dimension **and** model, so
  mismatched/legacy vectors are *excluded and counted as such*, never silently
  scored `0`.
- Hubs report `chunkCount` **and** `retrievableChunkCount`; the UI warns and offers
  re-indexing when they diverge. Ingest/research report real counts and honest
  failure reasons — never a bare `{success:true}`.

### Federated retrieval (panel of Experts)

When multiple Experts are consulted, the query is embedded once; each vault is
searched (cosine similarity over the model-matched rows); every expert's persona is
layered in with its matches, and grounding is tracked per expert. The prompt asks
the model to integrate the panel and **surface disagreements rather than flatten
them**. (Global cross-vault reranking is the next planned refinement — currently
top-k per vault.)

---

## 5. Memory (MemoryManager)

[`electron/memory/memoryManager.cjs`](electron/memory/memoryManager.cjs) makes the
corpus **compound instead of degrade**:

- **Fact extraction** — background LLM pass (gated by trigger phrases) writes facts
  to `user_memories`. Writes are **de-duplicated** on a canonical form, so repeats
  refresh one memory rather than accumulating near-duplicates.
- **Relevance-ranked recall** — `rankMemoriesByRelevance` selects facts by lexical
  overlap with the current question (recency as tie-breaker), so a burst of
  unrelated facts can't evict the ones that matter.
- **Cross-conversation vector recall** — the query embedding is matched against
  `message_embeddings` (dimension-filtered) for relevant past context.
- **Rolling summary** — older turns are compressed into `conversations.summary` by
  the background model.

---

## 6. Data model (SQLite)

Managed by [`electron/repository.cjs`](electron/repository.cjs). Schema version is
tracked in `PRAGMA user_version` (currently **2**).

| Table | Purpose |
|---|---|
| `conversations` | thread metadata, rolling `summary` |
| `messages` | chat turns (`system`/`user`/`assistant`) |
| `user_profile` | identity, role, stack, tone, global instructions |
| `user_memories` | extracted / user-defined facts (de-duplicated) |
| `message_embeddings` | message chunk vectors (`embedding_model`, `embedding_dim`) |
| `specialist_hubs` | Expert persona + config |
| `specialist_chunks` | vault chunks + vectors (`embedding_model`, `embedding_dim`) |
| `settings` | key/value config (models, providers, keys, panel selection) |
| `message_search`, `conversation_search` | FTS5 virtual tables (BM25) |

### Migrations, backup, integrity

- **Migration runner** — an ordered `MIGRATIONS` list keyed to `SCHEMA_VERSION`,
  applied transactionally. `addColumnIfMissing` makes column additions safe on both
  fresh and legacy databases (migrations run before `initialize()`).
- **Backup-before-migrate** — upgrading a database that already holds data first
  WAL-checkpoints and copies it to `sidekick.db.bak-v<from>-<timestamp>` (keeps the
  most recent `MAX_BACKUPS`).
- **Integrity check** — `PRAGMA integrity_check` on open; the result is surfaced to
  the renderer as a warning banner rather than failing silently.
- **Corpus export/import** — `exportAll()` emits the full corpus (conversations +
  messages, memories, profile, hubs + vault chunks *including embeddings*) in a
  versioned envelope; `importAll()` restores it transactionally and idempotently
  (`INSERT OR IGNORE`). This also underpins portable / shareable Experts.

---

## 7. Web search & scraping

[`electron/search/searchService.cjs`](electron/search/searchService.cjs) provides a
provider-agnostic `performWebSearch` (DuckDuckGo, SearXNG, Tavily, Brave) with a
resilience chain: configured provider → DuckDuckGo → Wikipedia (a stable JSON API).
It never throws; it returns `[]` only when every source is genuinely empty.
[`scraper.cjs`](electron/search/scraper.cjs) extracts main text from HTML with a
per-request timeout.

---

## 8. Testing

The suite runs under both plain Node and the Electron native runtime (for
`better-sqlite3`). It favors deterministic, offline tests: repository CRUD +
migrations + backup + export/import round-trips, the embedding contract
(dimension-mismatch exclusion, write-boundary rejection), PDF extraction against a
generated fixture, memory dedup + ranking, search fallback and query-derivation
paths, and Ollama NDJSON parsing. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to
run and extend it.
