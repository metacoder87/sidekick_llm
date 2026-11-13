# Sidekick LLM — Deep Assessment & Remediation Report

**Prepared for:** Sidekick LLM product/engineering  
**Subject:** Breaking changes — Expert vaults showing "0 Saved Chunks" and answers not cited/linked to sources  
**Scope:** Full codebase assessment (renderer, main process, shared config, tests, docs)  
**Date:** 2026-11-11  
**Status:** Final

---

## 1. Executive Summary

Sidekick LLM is a well-architected, offline-first Electron desktop AI app. Its core bet — local inference + local vector vaults ("Experts") with verifiable, deep-linked citations — is sound and, in large part, already implemented. The two symptoms you reported are **not cosmetic**; they share a single root cause that has been present since the embedding contract was introduced:

> **The configured embedding model does not resolve to a usable local vector model, so every embedding call silently returns `null`, retrieval is skipped entirely (vector *and* keyword), and the model is told to answer "from expertise only." The result: vaults look empty/ungrounded, no source cards render, and the persona is ignored.**

The code contains the *infrastructure* to fix this (preflight checks, re-indexing, `retrievableChunkCount`, source cards, citation lists) but the **chat path was not wired to fail loudly or degrade gracefully**, unlike the ingest/research paths which already use `checkEmbedding()`. That asymmetry is the breaking change.

This report covers: what works, the root-cause analysis of both reported symptoms, what to cut/fix/optimize (prioritized), what to add to reach industry leadership, and a phased action plan.

---

## 2. What Works (Strengths — keep and build on)

These are solid, production-grade foundations. Do not rewrite them.

| Area | What works | Evidence |
|------|-----------|----------|
| **Offline-first architecture** | Pluggable LLM provider (built-in `node-llama-cpp` or Ollama), SQLite corpus with WAL, nothing leaves the machine except user-initiated web search/model downloads. | `ARCHITECTURE.md` §1; `electron/llmProvider.cjs` |
| **SQLite corpus + migrations** | Schema versioning, transactional migrations, backup-before-migrate, `PRAGMA integrity_check`, export/import round-trips. | `electron/repository.cjs` (SCHEMA_VERSION 9, MIGRATIONS) |
| **Encryption & audit** | Opt-in AES-256 (SQLCipher) at rest, OS keychain passphrase caching, auto-lock on idle, hash-chained tamper-evident audit log. | `repository.cjs` rekey/audit; `ipc.cjs` security handlers |
| **AI Expert / vault model** | `specialist_hubs` + `specialist_chunks` with embedding provenance (`embedding_model`, `embedding_dim`), per-hub `chunkCount` and `retrievableChunkCount`. | `repository.cjs` schema + `listSpecialistHubs()` |
| **Federated (multi-Expert) retrieval** | Query embedded once, each vault searched, cosine + BM25 fused via RRF, globally re-ranked across vaults, per-expert grounding tracked. | `electron/contextBuilder.cjs`, `electron/retrieval.cjs` |
| **Hybrid retrieval** | Vector (cosine) + BM25/FTS with reciprocal-rank fusion; catches both paraphrase and exact terms (clause numbers, API symbols). | `retrieval.cjs` `fuseHybrid`; `repository.cjs` `searchSpecialistKeyword` |
| **Citations infrastructure** | Web-search `[n]` citations (`CitationsList`) AND specialist source cards (`SourceCards`) built from retrieved chunks (never parsed from model prose), with deep links / text fragments and page anchors. | `src/components/CitationsList.jsx`, `SourceCards.jsx`, `src/lib/citations.js` |
| **Roundtable mode** | Each Expert speaks in its own grounded voice, moderator consolidates, per-turn citations preserved as attributed messages. | `electron/ipc.cjs` roundtable branch; `electron/roundtable.cjs` |
| **Memory vault** | Fact extraction with canonical de-duplication, relevance-ranked recall, cross-conversation vector recall, rolling summary. | `electron/memory/memoryManager.cjs` |
| **Expert packs** | Portable versioned export/import of a single Expert (persona + vault chunks + notes), with embedding-model mismatch detection and re-index offer. | `repository.cjs` `exportExpertPack`/`importExpertPack` |
| **Tests** | Offline, deterministic suite covering repository CRUD/migrations, embedding contract, PDF extraction, memory dedup/ranking, search fallback, GGUF downloads, Ollama NDJSON. | `test/*.test.cjs` |

---

## 3. Root-Cause Analysis of the Two Reported Symptoms

### Symptom A — Each Expert shows but "0 Saved Chunks"

The Specialist Gallery renders `{hub.chunkCount || 0} vector chunks` (`src/components/SpecialistGallery.jsx:86`). `chunkCount` is a `COUNT(*)` over *all* rows in `specialist_chunks` for that hub (`repository.cjs:1645`), so it is independent of the embedding model. If it reads 0, there are genuinely no chunk rows for that hub — OR the user is looking at the more honest metric `retrievableChunkCount`, which *is* embedding-model-dependent.

`retrievableChunkCount` counts only chunks whose `embedding_model` matches the currently configured setting (`repository.cjs:1646`). Two common scenarios make it 0:

1. **Embedding model switched without re-index.** Default `embeddingModel` is now `nomic-embed-text-v1.5` (built-in GGUF, `ggufCatalog.json`). Older configs used Ollama's `nomic-embed-text`. Migration v9 rewrites the *setting* but does **not** re-embed existing chunks, so legacy chunks keep `embedding_model = 'nomic-embed-text'` (or NULL) and become invisible — `retrievableChunkCount = 0` even though `chunkCount > 0`.
2. **Expert installed "persona only," or research/ingestion failed fast.** `specialist.installFromCatalog` and `research.*` handlers call `ollama.checkEmbedding()` up front and return `researched: false` / `success: false` with 0 chunks when the embedding model is unavailable (`ipc.cjs:593-597, 713-717`). The hub is created (persona works) but the vault stays empty.

### Symptom B — No responses cited / linked to sources

This is the *same* root cause, surfaced in the chat path:

1. On each turn, `buildChatContext` embeds the planned queries via `ollama.generateEmbedding({ model: embeddingModel, ... })` (`contextBuilder.cjs:138`).
2. `generateEmbedding` wraps everything in `try/catch` and returns `null` on any failure — missing GGUF, wrong model, load error — with **no error surfaced** (`llama/llamaCppProvider.cjs:416-432`).
3. Back in `contextBuilder.cjs:139`, a `null` embedding is skipped, so the `embeddings` array ends up empty.
4. **The structural flaw:** the keyword (BM25) search is *inside* the `for (… of embeddings)` loop (`contextBuilder.cjs:153-158`). When embeddings is empty, **both** vector search **and** keyword search are skipped. Retrieval yields zero matches for every Expert.
5. `topChunks.length === 0` → `grounded: false` (`contextBuilder.cjs:227`) → the prompt tells the model *"No matching knowledge was found … answer from expertise only, and say so"* (`contextBuilder.cjs:195`) → `GroundingBadge` renders the ungrounded warning and **no `SourceCards` render** (`ChatView.jsx:161-166`).
6. Web-search citations (`citations` array) are also empty when web search is off or returns nothing, so `CitationsList` renders nothing either.

Result: the Expert's persona is present in the system prompt but has no retrieved knowledge to anchor it, so a small model drifts to a generic voice, and no citations or source links appear. This matches the `DEBUGGING_REPORT.md` (Kevin Flynn scenario) exactly.

**Why ingest "works" but chat "fails silently":** Every ingest/research/notes handler preflights with `ollama.checkEmbedding()` and fails loudly with an actionable reason (`ipc.cjs:493,517,544,689,744`). The chat path does **not**. That asymmetry is the breaking change.

---

## 4. What Needs Fixed (Prioritized)

### P0 — Fix the silent retrieval failure (causes both symptoms)

1. **Add an embedding preflight to the chat path.** In `electron/ipc.cjs` `chat:sendMessageStream`, call `ollama.checkEmbedding(embeddingModel)` before `buildChatContext`. If it fails, attach a structured `groundingDisabled` reason to the turn so the UI renders a distinct, actionable banner (e.g., *"Embedding model `nomic-embed-text-v1.5` isn't downloaded — grounding disabled. Download it from Settings → Local Model & Engine."*) instead of the generic ungrounded badge. Mirror the preflight already used by ingest/research/notes.

2. **Ungate keyword search from embedding success.** In `electron/contextBuilder.cjs`, run `repository.searchSpecialistKeyword(hub.id, query, 8)` *outside* the `for (… of embeddings)` loop and fuse it with vector results when those exist. A missing embedding model should degrade to "keyword-only results," not "zero results."

3. **Make `generateEmbedding` failures diagnosable.** `llama/llamaCppProvider.cjs:429` swallows every error and returns `null`. Return a structured `{ vector, error }` or throw a typed error so the caller can distinguish "model missing" from "model loaded but errored."

4. **Quiet the Jinja red herring.** Pass `additionalRenderParameters: { tools: null, custom_tools: null, builtin_tools: null }` when building the chat wrapper for models with tool-conditional templates (Llama 3.1/3.2), or lower engine log level to `warn`. Cosmetic, but the stack trace masks real errors (`DEBUGGING_REPORT.md` Bug 2).

### P1 — Fix the "0 chunks" / stale-vault experience

5. **Re-index on embedding-model change.** Migration v9 updates `embeddingModel` but not stored vectors. Add an explicit re-index flow: when `embeddingModel` changes, detect chunks whose `embedding_model != current`, offer "Re-index all Experts now," and run `researchWorker.reindexHub` per hub. Until re-indexed, show a warning banner on the affected Expert.

6. **Show retrievable vs. total chunk count.** `SpecialistGallery` shows only `chunkCount`. Show both `chunkCount` and `retrievableChunkCount`, and when they diverge render a "⚠️ N chunks are not retrievable with the current embedding model — re-index" call-to-action. This prevents a hub from looking stocked while returning zero results.

7. **Embedding-model availability guard in Settings UI.** When the active engine is built-in and `embeddingModel` isn't a downloaded GGUF, show an explicit warning and a one-click "download the required embedding model" action (`nomic-embed-text-v1.5` is already flagged `required: true` in `ggufCatalog.json`).

### P2 — Hardening

8. **Surface storage-layer errors instead of swallowing them.** `SpecialistGallery.loadHubs`, background memory tasks, and several `catch (_e) { /* ignore */ }` blocks silently drop errors. Log at minimum; surface user-facing notices for operations the user initiated.

---

## 5. What Needs Cut / Optimized

| Item | Recommendation |
|------|----------------|
| **Committed build artifacts / node_modules** | `node_modules/`, `build/`, `dist/`, `release/`, `*.log`, and `__pycache__/` appear to be present in the working tree. Confirm they are in `.gitignore`; large binaries (the `.exe`, `.dll`, `resources.pak`) should not be versioned. |
| **Broad silent `catch` blocks** | `SpecialistGallery.loadHubs` (`catch { /* Ignore */ }`), `contextBuilder` web-search/memory/specialist/suggest catches, and background `Promise.allSettled(...).catch(() => {})` hide failures. Replace ignored catches with logging + optional user notice for user-initiated actions. |
| **Redundant embedding loads** | Each chat turn embeds planned queries; expert-suggestion embeds the raw query again. Reuse a single query embedding where possible (minor). |
| **`listUserMemories` in-memory de-dup scan** | Fine for small tables, but cap it or move de-dup to SQL if memory tables grow large. Low priority. |

Nothing in the codebase needs to be *cut* functionally — the feature set is coherent. The "cut" work is repo hygiene and removing silent error suppression.

---

## 6. What Can Be Added (Roadmap to Industry Leadership)

To make Sidekick a rock-solid industry leader that adds tremendous user value, layer these on top of the fixed core:

### A. Trust & Verification (differentiator vs. black-box chatbots)
- **Inline citations** in answer text, not just a source list — highlight which sentences are grounded in which chunk, with hover previews.
- **Grounding verification:** after generation, check that claims map back to retrieved chunks; flag answers where the model asserts something absent from sources. Offer an "Answer from sources only / refuse when ungrounded" mode.
- **Conversation-level source bibliography** — one consolidated reference list per thread.

### B. Retrieval quality
- **Global cross-vault reranking** (already noted as planned in `ARCHITECTURE.md` §4) — current top-k-per-vault can drown a small specialist's strong match in a large panel's weak ones.
- **Cross-encoder reranker** for the final top-k, plus query expansion / hyde for recall.
- **Recency + reinforcement weighting** in vault and memory ranking.

### C. Zero-config embedding experience
- **Auto-download the required embedding model** on first run / when missing, with progress and a clear "retrieval is offline until this completes" state.
- **Auto re-index** whenever `embeddingModel` changes (with user confirmation for large vaults).

### D. Expert experience
- **Vault health dashboard** per Expert: chunk count, retrievable count, sources, last indexed, stale-vector warning, one-click re-index, "train from this conversation" note creation.
- **Expert marketplace / pack publishing** — export packs already exist; add import-from-URL and a community pack directory (optional, opt-in).
- **Multi-source ingestion:** YouTube transcripts, URLs, Notion/Confluence-style imports (build on existing scraper).

### E. Operations & quality
- **Evaluation harness:** golden-question set per Expert persona; measure grounding rate, citation precision, persona adherence. `BENCHMARKS.md` exists — extend it into CI.
- **CI/CD pipeline:** lint, unit tests (extend `contextBuilder` tests — `ARCHITECTURE.md` calls it "the most valuable and least-tested surface"), build, code-sign, auto-updater verification.
- **Error boundaries + crash reporting** (offline, local-only) so breaking changes surface before users do.
- **Performance:** lazy-load the embedding model only when retrieval is needed; cache query embeddings within a session.

### F. Polish & UX
- **Empty/vault states:** when an Expert has 0 retrievable chunks, the chat composer should warn *"This Expert has no indexed knowledge — answers will not be cited"* before the user sends.
- **Source quality indicators:** domain, date, and page precision on every source card.
- **Dark theme consistency** and accessibility (keyboard navigation, ARIA labels).

---

## 7. Recommended Action Plan

### Phase 1 — Stop the bleeding (this week)
1. Add `ollama.checkEmbedding()` preflight to `chat:sendMessageStream`; surface actionable grounding-disabled banner.
2. Move keyword search outside the embeddings loop in `contextBuilder.cjs`.
3. Return structured errors from `generateEmbedding` instead of swallowing.
4. Quiet the Llama 3.1 Jinja error (`tools: null` render params).

### Phase 2 — Make vaults honest (week 2)
5. Show `retrievableChunkCount` alongside `chunkCount` in Specialist Gallery; add re-index CTA when they diverge.
6. Add Settings guard + one-click download for missing required embedding model.
7. Add migration-time / setting-change re-index detection for stale `embedding_model` chunks.

### Phase 3 — Harden & test (week 3–4)
8. Replace ignored `catch` blocks with logging/user notices for user-initiated ops.
9. Add unit/integration tests for `contextBuilder` (chat path, grounding-disabled path, hybrid retrieval).
10. Add CI lint + test gate; confirm `.gitignore` excludes `node_modules`, `build`, `dist`, `release`, logs.

### Phase 4 — Industry-leading differentiators (quarter)
11. Inline citations + grounding verification / "sources only" mode.
12. Global cross-vault reranker + cross-encoder.
13. Evaluation harness (golden QA per Expert) wired into CI.
14. Expert vault health dashboard + marketplace packs.

---

## 8. Bottom Line

Your two reported symptoms are **one bug with two faces**: the embedding model is unavailable for the active engine, so `generateEmbedding` silently returns `null`, retrieval (vector *and* keyword) is skipped, and every answer falls back to ungrounded model weights with no citations and no source links. The fix is small and localized (`ipc.cjs` chat preflight + `contextBuilder.cjs` ungated keyword search), but the broader work — making the embedding contract visible, re-indexable, and fail-loud everywhere — is what turns Sidekick from a promising prototype into a trustworthy, cited, industry-leading local AI assistant.

The codebase already has the right bones (provider pluggability, SQLite + FTS5, embedding provenance, hybrid retrieval, source cards, roundtable, encryption, audit, export/import). Fix the retrieval failure mode, add the missing UX honesty around retrievable chunks, and invest in verification/evaluation, and Sidekick will be genuinely hard to beat on the "local, private, verifiable AI" value proposition.
