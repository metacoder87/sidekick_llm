# Sidekick LLM — Engineering Roadmap

> **Read this first.** This document is the single source of truth for where the
> project is going and *why*. It is written to be picked up cold — by a future
> session, a collaborator, or the author six months from now — without the
> conversation that produced it. If you change direction, change this file.

Last updated: 2026-07-26 (Stage 1, 2, 2.5 complete; Expert Library shipped)

---

## 1. What this project actually is

Sidekick is **a personal knowledge system with a conversational interface** — not
a local ChatGPT clone. The durable artifact is **the corpus** (memories, profile,
Specialist vaults, notes). The LLM is a *lens* onto that corpus, not the source of
truth. The model is swappable and disposable; the corpus is not.

**Every design decision favors the corpus.** When in doubt, protect, enrich, or
make portable the accumulated knowledge — never the chat shell.

### The thesis
An assistant you *own*, that accumulates your knowledge and your experts, beats a
rented one that forgets you. It must:
- run fully **local, offline-capable, zero-cost, private, secure**;
- get **more valuable over time** (month 12 >> month 1);
- let the user build **"AI Experts"** — NotebookLM-style notebooks scoped to a
  topic, grounded in documents + curated web research;
- support **consulting multiple Experts at once** ("a cohesive brain with
  associations the user pulls together").

### The NotebookLM principle (the north star)
NotebookLM's real insight is **not** "chat with documents." It is: *the model may
only speak about what you gave it, and it must show you where.* That grounding
constraint is what makes Experts trustworthy — and is the precondition for the
medical/legal use cases being useful rather than reckless.

### Intended use cases (author's own words, preserved)
Niche coding experts (Python/JS/TS/C/…), medical (train on a specialty + upload
personal records → understand what doctors say, cross-reference, know when to seek
a second opinion), legal, travel, nutrition, style, auto mechanics, art history,
Shakespeare, quantum physics — anything, as need arises. The assistant should be
able to research a topic on the web and either add findings to an existing Expert
or spin up a new one.

### Stance: facts, not guardianship (the defining principle)
The application is **not a moral or ethical guardian for the user. It is a brain
that presents the raw, unfiltered, grounded truth so the user can decide.** To be an
effective decision-maker, one must have all relevant facts *and* be able to
understand them — delivering both is the entire goal.

- Experts **may reach independent conclusions and make recommendations**, including
  ones that contradict a professional the user consulted. Doing effective due
  diligence and concluding *"this doesn't line up and needs further investigation"*
  is a **desired**, high-value behavior — not something to suppress.
- What is **forbidden** is *distorting, omitting, or spinning* the facts to fit any
  narrative — the doctor's, a corporation's, a stock model's built-in corporate/
  political bias, or the model's own prior. Never lie about the facts or build a
  misleading narrative to reinforce a presumed "correct" view.
- Concretely: a **medical** Expert reads the user's records + relevant journals and
  presents raw facts + its reasoning + a recommendation, all cited. A **legal**
  Expert reads a contract *exactly as written* and surfaces the buried details in
  plain bullet points in minutes — a personal, zero-cost **advocate** on the user's
  side, free of the affiliation biases a censored stock model would carry.
- Not all locally-installed models are uncensored; the **application's** job is to
  keep the *presentation* of facts honest and grounded regardless of the model
  chosen. The safeguard against a model's confident hallucination is **citation +
  fact/inference separation** (invariants #1, #9), **not** censorship.

### Trajectory
Primary use case *right now*: the author's personal sidekick — get the prototype
**fully functional and growing**. **Intended end state: licensed for others to
download and run on their own local machines.** Credible near-term milestone:
**presentation at University, with potential government research contracts** — which
raises the bar on citation rigor, provenance, and reproducibility (all already
central below), but does not change the near-term priority of a working, growing
prototype. Rule of thumb for the whole project:

> **Build the foundation as if for distribution. Build the features as if for one user.**

Foundational choices (data model, provenance, encryption, schema versioning,
export/import) are brutal to retrofit → make them now. Features are cheap to add
later, and months of real personal use will reveal which ones actually carry
value → don't over-build them up front.

---

## 2. Current state (as of 2026-07-23)

Baseline: build succeeds (`vite build`, ~175 KB JS), 11 tests pass, ~3,500 LOC,
42 tracked files. Architecture is sound: clean main/renderer split, context
isolation on, a real repository layer, a genuinely good context-assembly pipeline.

### 🔴 Known-broken (verified at runtime, not theorized)
These were reproduced against the real code and the author's own Ollama install.

1. **PDF ingestion is 100% broken — never worked.**
   [`deepResearch.cjs:3`](electron/research/deepResearch.cjs) does
   `require('pdf-parse')` and calls it as a function (`pdfParse(buffer)` at
   [`:39`](electron/research/deepResearch.cjs)). Installed `pdf-parse` is **v2.4.5**,
   which exports a **class** `PDFParse`, not a function.
   Proof: `typeof require('pdf-parse') === 'object'`; calling it throws
   `TypeError: p is not a function`. Correct v2 API:
   ```js
   const { PDFParse } = require('pdf-parse');
   const parser = new PDFParse({ data: buffer });
   const { text } = await parser.getText();
   await parser.destroy(); // REQUIRED — pdfjs worker leaks otherwise
   ```

2. **Deep Research training produces dead vaults — silently.** Chunks are
   embedded with whatever **chat** model is active. The author has **17 models
   installed and NO dedicated embedding model.** Verified embedding dims on this
   machine:
   | model | `/api/embeddings` |
   |---|---|
   | `mistral:7b` | 4096 |
   | `llama3:8b` | 4096 |
   | `qwen2.5:32b` | **5120** |
   | `gpt-oss:20b` | **ERROR: "this model does not support embeddings"** |

   `cosineSimilarity` returns `0` when vector lengths differ
   ([`repository.cjs:28`](electron/repository.cjs)). So: train under one model,
   query under another → every vault silently returns nothing. Train while a
   non-embedding model is active → chunks stored as `[]` → vault permanently dead.

3. **Failure is invisible at five layers**, and the last prints a green check:
   `generateEmbedding` swallows→`null` ([`ollama.cjs:158`](electron/ollama.cjs)) →
   `embedding || []` coerces ([`deepResearch.cjs:68,124,176`](electron/research/deepResearch.cjs)) →
   `saveSpecialistChunk` persists it ([`repository.cjs:840`](electron/repository.cjs)) →
   `chunkCount` counts dead rows ([`repository.cjs:789`](electron/repository.cjs)) →
   `runWebDeepResearch` returns `{success:true}` ([`deepResearch.cjs:188`](electron/research/deepResearch.cjs)) →
   `SpecialistModal` shows `res.message || '✅ Deep research complete!'`
   ([`SpecialistModal.jsx:68`](src/components/SpecialistModal.jsx)).
   At chat time the persona still loads even with zero retrieved chunks
   ([`ipc.cjs:319`](electron/ipc.cjs)) → the Expert *sounds* expert while knowing nothing.

4. **`depth` parameter is dead.** Destructured in `runWebDeepResearch` and never
   used → no recursive crawl. README's "multi-depth Web Deep Research" is
   unimplemented. `SpecialistModal` never sends it.

5. **Duplicate repository methods.** [`repository.cjs:285-398`](electron/repository.cjs)
   and [`:614-727`](electron/repository.cjs) define the same six methods twice
   (`updateConversationSummary`, `addUserMemory`, `listUserMemories`,
   `deleteUserMemory`, `saveMessageEmbedding`, `searchVectorMemory`). Second copy
   wins; fixes to the first are dead on arrival.

### 🟠 Security / correctness gaps (from audit, not yet fixed)
- **No `setWindowOpenHandler` / `will-navigate` guard** ([`main.cjs:6`](electron/main.cjs));
  `sandbox:false`. A clicked citation opens a remote page **with the preload
  bridge attached** → remote page can call `settings.get()` (returns API keys),
  `chat.exportAll()`, `memory.list()`. **Top security issue.**
- Renderer IPC calls have **no `try/catch`**; failed sends **destroy the user's
  typed message** ([`Composer.jsx:20`](src/components/Composer.jsx) clears draft
  before awaiting; [`App.jsx:347`](src/App.jsx) has no catch).
- Search `fetch` calls have **no timeout** and run *before* generation →
  a stalled provider hangs the composer forever ([`searchService.cjs`](electron/search/searchService.cjs), awaited at [`ipc.cjs:237`](electron/ipc.cjs)).
- Streaming is **O(n²)**: full text + full citations sent every token
  ([`ipc.cjs:358`](electron/ipc.cjs)).
- **API keys stored plaintext** in `settings`. Personal data (incl. future
  medical records) unencrypted at rest.
- **FTS rebuilt from scratch on every launch** ([`repository.cjs:196`](electron/repository.cjs)) — startup cost grows with lifetime message count.
- **Vector search is a synchronous full-scan + `JSON.parse` per row** on the main
  process, every message ([`repository.cjs:355,858`](electron/repository.cjs)).

### 🟡 Intent gaps (design, not bugs)
- **`exportAll` omits the entire corpus** — exports conversations/messages only,
  NOT memories, profile, or Specialist vaults ([`repository.cjs:580`](electron/repository.cjs)).
  The one thing of unique value is the one thing you can't get out.
- **No schema versioning, no migrations table, no backup, no integrity check.**
  Sole precedent is one ad-hoc `ALTER TABLE` in a swallowing `catch{}`
  ([`repository.cjs:186`](electron/repository.cjs)). Any migration is unguarded.
- **Memory accumulates but doesn't compound.** `extractAndSaveFacts` inserts a
  new row per trigger with no dedup/supersede/decay
  ([`memoryManager.cjs:110`](electron/memory/memoryManager.cjs)); `retrieveContext`
  takes `slice(0,10)` by recency ([`memoryManager.cjs:14`](electron/memory/memoryManager.cjs)).
  Repeat "I use Windows 11" ten times → ten rows evict everything useful. **The
  vault degrades with use — the opposite of the thesis.** Same shape in vaults
  (no chunk dedup).
- **~400 lines of dead components** (`MemoryVaultModal`, `SpecialistGallery`,
  `UserProfileModal`, `ModelSelect`, `StatusPill`) — reimplemented inline in
  `SettingsModal`. Also dead: `updateMessageContent`, `deleteMessagesAfter`.
- Docs describe unbuilt behavior in past tense (`case_study.md` "robust error
  handling"; README "Markdown formatting" — only ``` fences are parsed,
  [`ChatView.jsx:5`](src/components/ChatView.jsx)).

---

## 3. Design invariants (do not violate without updating this section)

These are cheap now, expensive to retrofit. Every stage upholds them.

1. **Cite or shut up.** Any claim traceable to a chunk shows a citation. Anything
   the model says from its own weights is visually marked **unsourced**. This is
   THE core safeguard of the whole project — it is what lets an Expert advocate,
   conclude, and recommend freely (see Stance, §1) while every factual claim stays
   verifiable. It replaces censorship as the reliability mechanism.
1a. **Fact/inference separation.** Answers must show the seam between *cited fact*
   and *the model's own reasoning/recommendation*. Structure: **raw facts (cited) →
   analysis (why) → recommendation (labeled as the model's judgment).** The user can
   always see where the record ends and the Expert's interpretation begins — this is
   what keeps the user the decision-maker while the Expert still takes a position.
2. **Provenance on every chunk.** Store source, URL/file, ingestion date,
   publication date (if known), embedding model, embedding dim, and a **trust
   tier**: `own-records` > `official/peer-reviewed` > `documentation` >
   `web-scraped`. Retrieval ranks on trust + recency, not similarity alone.
3. **The corpus is portable.** Everything exportable and importable. Vaults are
   versioned units (this also enables "starter Experts" as a product).
4. **The embedding contract is load-bearing, not best-effort.** A chunk without a
   valid, dimension-matched vector is *invisible*, not degraded. Enforce at the
   write boundary; never persist an empty/NaN vector; never report success for a
   chunk that isn't retrievable.
5. **Model routing — with the user always in control.** The *reasoning* model is
   **always the user's free choice** and must remain so: new/better models ship
   constantly and only the user knows what fits the task. Routing applies to
   *defaults and background tasks* (a small/fast model for summaries, fact
   extraction, query rewriting), never a lock on which model answers. The
   **embedding model** is pinned for dimensional consistency but is *also*
   user-selectable — changing it requires a re-index (Stage 1 Phase 4) and the UI
   must say so. Never embed with a chat model by accident; never prevent the user
   from choosing the reasoning model on purpose.
6. **Capture automatically, promote deliberately.** Auto-research is *staged*, not
   auto-trusted. Nothing enters an Expert vault (esp. medical) without a human
   promotion step. This is how growth happens without entropy/poisoning.
7. **Recency is a first-class signal.** Stale medical guidance / Python 2 idioms
   are actively harmful. Store dates; decay or flag stale chunks.
8. **Federated retrieval, not a knowledge graph (for now).** "Cohesive brain" =
   query across selected Experts → merge → rerank. Revisit graphs only if this
   proves limiting. Design the retrieval *interface* for multi-Expert from day one.
9. **Non-distortion / fact-fidelity (supersedes the earlier "no verdicts" idea).**
   Experts **may** reach independent conclusions and make recommendations, including
   ones that contradict a professional (this is a *wanted* capability — see Stance,
   §1). The hard constraint is the opposite of refusal: **never distort, omit, or
   spin facts to fit any narrative** — not the doctor's, not a corporation's, not a
   censored model's bias, not the model's own prior. The mitigation for a quantized
   model's confident-hallucination failure mode is **grounding + citation +
   fact/inference separation** (#1, #1a), *not* suppressing conclusions. If the
   corpus doesn't support a claim, the Expert says so rather than inventing it.
   Applies equally to medical, legal, and every other domain.

---

## 4. Architectural target

```
Renderer (React)
  Chat • Expert Picker (multi-select) • Notebook/Expert view • Research Inbox • Settings
        │  IPC (preload bridge)
        ▼
Main (Node/Electron)
  IPC layer
  ContextBuilder        ← extract from the 230-line sendMessageStream handler; testable
  RetrievalService      ← federated, hybrid (BM25+vector), reranked; the quality ceiling
  IngestionService      ← PDF/text/web → chunk → embed → provenance → write-boundary enforce
  MemoryService         ← dedup / supersede / decay / relevance-rank (compounding)
  ModelRouter           ← background vs embedding vs reasoning
  Repository            ← versioned schema, backup, encrypted-at-rest, portable export/import
        │
   Ollama (local)                         SQLite (corpus — the asset)
```

Key refactors implied: pull `ContextBuilder` and `RetrievalService` out of
[`ipc.cjs`](electron/ipc.cjs) so they are unit-testable in isolation.

---

## 4b. Editions & shipping strategy (decided 2026-07-24)

**Two editions, and Enterprise is a *superset* of Individual — not a different
feature bucket.** A common mistake is to file general product work (licensing,
legal, crash reporting, sqlite-vec, CI, accessibility, onboarding) under
"Enterprise." All of that belongs to the **base/Individual** product; Enterprise
adds a multi-user layer on top.

| | **Individual edition** (ship first) | **Enterprise edition** (adds, later) |
|---|---|---|
| Users | single user per install | multiple users, accounts |
| Access | app-lock + personal audit log | **RBAC**, SSO, org-level audit/compliance |
| Data | local, per-user encrypted corpus | multi-tenant isolation; likely a **server/sync** layer |
| Delivery | signed desktop installers + auto-update (electron-builder), desktop icon | **Docker / central IT deployment**; managed updates |
| Regulatory | personal use of one's own data | HIPAA/PHI scope, security reviews, SOC 2, DPAs |
| Everything else | ✅ all base features | ✅ inherits all of them |

So licensing, legal disclaimers, crash reporting, sqlite-vec, CI/lint,
accessibility, and onboarding are **Individual (Stage 5)**, inherited by Enterprise.
Only RBAC, multi-user identity/tenancy, the server/sync layer, and Docker/central
deployment are **Enterprise-specific** — a separate future track, gated on the
business-model decision (open question #4).

**Strategy: ship Individual first, then build Enterprise on top.** The Individual
product is the validated core and the foundation Enterprise extends; shipping it
first yields revenue, real users, feedback, and a reference base that de-risks the
much larger Enterprise investment (server, multi-tenancy, compliance, sales). See
the **Minimum shippable v1** bar below.

### Minimum shippable v1 (Individual) — the gate to first release
Not all of Stage 5 is required to ship. The v1 bar is:
- **Stage 4 security is non-negotiable IF medical/legal use is marketed:** encryption
  at rest + app-lock + the link-handling fix. (Shipping unencrypted while inviting
  users to store medical records is a liability.)
- **Precise citations** (Stage 2) — the core trust promise; ship with it.
- From Stage 5: **packaging + code signing + auto-update**, **license activation**,
  **legal (EULA + disclaimers)**, **basic crash reporting**, **onboarding**, and
  **CI/lint** (cheap, protects quality).
- **Can defer past v1:** sqlite-vec (until users hit ~10k+ chunks), full
  accessibility (do incrementally), multi-platform (start on one OS), starter-Expert
  marketplace.

## 4c. Market viability ladder (what is sellable, when)

Development milestones mapped to what the product can actually be *used for* at that
point. The engineering stages are the work; these are the outcomes. **Nothing before
M3 may be sold**, because encryption, packaging, licensing and legal all gate revenue.

| Milestone | Requires | Viability | Can you… |
|---|---|---|---|
| **M0 — Personal prototype** ✅ *(reached 2026-07-24)* | Stages 1–2 | Not distributable | Use it daily yourself. Corpus is safe, Experts work, citations are precise. Unencrypted, unpackaged, unsigned. |
| **M1 — Demoable** ✅ *(reached 2026-07-26)* | + Stage 2.5 Roundtable, §5a drop-a-doc, Expert Packs | Showable, not sellable | Present at University; pitch research contracts; record a demo. The differentiators are visible and real. |
| **M2 — Design-partner alpha** | + Stage 3, **Stage 4 (encryption, app-lock, audit)** | Private hand-outs only | Give it to a handful of trusted users. Sensitive data is protected, actions are auditable. Still no installer or licence. |
| **M3 — Commercial v1** 💰 | + Stage 5 minimum bar: packaging, code signing, auto-update, licence activation, EULA + disclaimers, onboarding, crash reporting, CI | **First revenue** | Sell to individuals. A stranger installs, activates, and is productive in 5 minutes. |
| **M4 — Scaled v1.x** | + sqlite-vec, multi-platform, accessibility, Stage 7 recipe packs & Teams | Growth | Support large corpora (10k+ chunks), sell Expert/Team packs, reach Mac/Linux users. |
| **M5 — v2 platform** | + Stage 8 Workflow Experts, licensed content packs | New category | Sell orchestrated deliverable production (business plans, literature reviews). Highest ceiling, highest cost. |
| **E1 — Enterprise** *(parallel)* | Stage 6 (RBAC, multi-user, server/sync, Docker) | Separate product | Sell to firms/clinics — only after Individual validates demand (open Q#4). |

**Recommended build order:** ~~Stage 2.5 → §5a quick wins → **M1 demo**~~ ✅ done →
**Stage 3** (grow safely) → **Stage 4** (encryption/app-lock/audit) → **Stage 5**
→ **M3 ship & earn** → Stage 7 → Stage 8.
The trap to avoid is building M5 features while M3 never ships.

## 5. The stages

Effort estimates are rough and assume the author + this assistant. Each stage ends
with an explicit **exit criterion** — do not advance until it's met.

> **Sequencing rule:** Stage 1 (esp. Phase −1) protects the corpus and MUST land
> before any migration or bulk re-embed. The retrieval *interface* is designed for
> multi-Expert in Stage 1 even though the multi-Expert *UI* ships in Stage 2 —
> retrofitting single→federated means touching the same code twice.
>
> **Editions note:** Stages 1–5 build the **Individual** edition. A future
> **Stage 6 — Enterprise** (RBAC, multi-user, server/sync, Docker deployment) is
> deliberately deferred; see §4b and open question #4.

---

### STAGE 1 — Trustworthy foundation  (~3 weeks)
*Goal: the corpus is safe, honest, portable, and its knowledge is actually retrievable.*

#### Phase −1 — Protect the corpus (do this FIRST, before any schema change) ✅ DONE (commit 367255c)
- [x] **Schema versioning.** `PRAGMA user_version` + ordered, transactional
      migration runner (`SCHEMA_VERSION`, `MIGRATIONS`, `runMigrations()`).
      Migration 1 is the idempotent baseline for fresh + legacy databases.
- [x] **Backup-before-migrate.** WAL-checkpoint then copy to
      `<db>.bak-v<from>-<timestamp>` before migrating a database that holds data;
      keeps most recent `MAX_BACKUPS` (5). `backupDatabase()` / `pruneBackups()`.
- [x] **Integrity check on open.** `checkIntegrity()` runs `PRAGMA integrity_check`;
      result stored on `repository.integrity`, exposed via `system:getIntegrity`,
      surfaced in the renderer as a warning banner (App.jsx bootstrap).
- [x] **Full export/import.** `exportAll()` emits the full corpus (conversations+
      messages, memories, profile, hubs + vault chunks) in a versioned envelope
      (`app`/`kind`/`schemaVersion`). `importAll()` restores transactionally +
      idempotently (INSERT OR IGNORE). Wired `chat:importAll` + sidebar buttons.
- [x] **Test:** legacy-backup-on-migrate (data intact + backup created) and full
      export→import round-trip (incl. embedding fidelity + idempotency). Suite 11→14.
- **Exit:** ✅ a bad migration can't destroy the corpus; the whole corpus round-trips.
- **Deferred to Phase 1:** the ad-hoc `ALTER TABLE summary` at
      [`repository.cjs`](electron/repository.cjs) `initialize()` still exists; fold it
      into the migration runner when Phase 1 adds the embedding-provenance columns.

#### Phase 0 — Prerequisites
- [x] `ollama pull nomic-embed-text` — done by the author; verified 768-dim live.
- [x] Delete duplicate repository block (was `:614-727`) — removed in commit 367255c.

#### Phase 1 — The embedding contract (root-cause fix) ✅ DONE (commit 21f8931)
- [x] Added `embeddingModel: 'nomic-embed-text'` to `DEFAULT_SETTINGS`, decoupled
      from the chat model. Reasoning model stays the user's free choice (invariant #5).
- [x] Every embed site routes through the pinned embedding model: ipc chat RAG +
      memory retrieve/index, deepResearch ingest + web. (`model` still used for the
      chat/summary/extract completions.)
- [x] Schema **v2** migration adds `embedding_model` + `embedding_dim` to both
      `specialist_chunks` and `message_embeddings` (defensive `addColumnIfMissing`;
      fresh DBs get them in CREATE TABLE). `SCHEMA_VERSION` drift guard added.
- [x] Retrieval filters by dimension → mismatched/legacy (NULL-dim) vectors are
      excluded, not scored 0.
- [x] `saveSpecialistChunk`/`saveMessageEmbedding` throw on empty/non-finite via
      `assertValidEmbedding`; ingest loops skip + count failures (`chunksFailed`) and
      fail honestly if nothing embeds. Export/import carry the new columns.
- [x] **Verified live** against real Ollama: PDF ingested with nomic-embed-text is
      retrievable; the old chat-model query path (4096-d vs 768-d) returns 0 by
      exclusion. Real user DB migrated v0→v2 on launch with an automatic backup.
- **Deferred (intentional):** discriminated `generateEmbedding` result → Phase 3
  (its "reason" is consumed by the pre-flight there); `Float32Array` BLOB storage
  → Phase 5 perf (would churn the just-verified export/import). Legacy NULL-dim
  rows await Phase 4 re-index.

#### Phase 2 — Fix PDF ingestion ✅ DONE (commit 6d392fb)
- [x] Swapped to the v2 `PDFParse` class API + guaranteed `parser.destroy()`.
- [x] Guard on **chunks produced** (stronger than raw-text): scanned/image/empty
      files return `{success:false, reason}`, never a silent 0-chunk success.
- [ ] `scrapePage` non-HTML skip (PDFs linked from web research) — **deferred**,
      minor; upload path is the primary flow. Revisit with Stage 3 research work.

**Build fix found during Phase 1 verification** ✅ (commit 33a1b1f): the production
build rendered a blank/black window — Vite emitted absolute `/assets/...` paths that
Electron's `file://` loader resolves to the filesystem root. Set `base:'./'`; verified
the built page mounts under `file://`. Dev mode had masked this; it would have blocked
Stage 4 packaging.

#### Phase 3 — Honest reporting ✅ DONE (commit adds `feat(specialists)`)
- [x] Ingest/research workers return real counts (`chunksCount`/`chunksFailed`,
      `totalChunks`/`totalFailed`) and `{success:false, reason}` on failure — never
      a bare `{success:true}`.
- [x] `Ollama.checkEmbedding()` pre-flight; `research.start` + `ingestFile` fail
      fast with an actionable reason before scraping/reading. **Verified live.**
- [x] `getSpecialistHub` / `listSpecialistHubs` report `retrievableChunkCount`
      (chunks embedded with the current model) alongside total `chunkCount`.
- [x] `SpecialistModal` shows honest outcomes via `describeResult` (no
      `res.message || '✅'`); shows "N of M retrievable"; warns on divergence.
- [x] Chat path tags answers with `specialistGrounding`; `ChatView` badges an
      answer as grounded (with source count) or flags it persona-only/unsourced
      (invariant #1).

#### Phase 4 — Re-index migration ✅ DONE (same commit)
- [x] `specialist:reindex` channel + `DeepResearchWorker.reindexHub` re-embeds
      stored `chunk_text` in place with the current model — cheap, no re-scrape/
      re-upload. Retrieval filters by model+dim so repaired chunks become matchable.
      **Verified live:** simulated legacy 4096-d vault (0 retrievable, 0 hits) →
      re-indexed with real nomic-embed-text → retrievable, planted fact retrieved.
- [x] `SpecialistModal` "🔧 Re-index Knowledge Vault" button, auto-shown when
      `retrievableChunkCount < chunkCount`.
- **Note:** empty-vector rows can no longer exist (Phase 1 write boundary rejects
  them), so re-index only repairs model/dim mismatches — exactly the legacy case.

> **STAGE 1 COMPLETE.** Corpus is protected, portable, honestly reported, and its
> knowledge is actually retrievable; existing vaults are recoverable. Test suite
> 11 → 20. Remaining Stage-1-adjacent polish lives in Phase 5 below.

#### Phase 5 — Provenance + citations surfaced (invariants #1, #2)
- [ ] Add trust-tier + dates to chunk schema; capture at ingestion.
- [ ] Real Markdown renderer (currently only ``` fences —
      [`ChatView.jsx:5`](src/components/ChatView.jsx)); render inline source cards.
- [ ] Mark model-weight (unsourced) statements distinctly from grounded ones.

#### Phase 6 — Regression tests (assert *retrievability*, never `success:true`)
- [ ] `require('pdf-parse')` exposes `PDFParse`; fixture PDF → non-empty text.
- [ ] Failing embedder → `chunksFailed>0` AND `saveSpecialistChunk` refuses write.
- [ ] Chunks written at dim A excluded (and *counted excluded*) when queried at dim B.
- [ ] Round-trip: ingest → retrieve returns ingested text.
- [ ] Re-index repairs a legacy mixed/empty-vector vault.
- [ ] Add a renderer test runner (Vitest) — none exists today.

**STAGE 1 EXIT CRITERIA**
- A PDF upload produces retrievable chunks, verified by a test.
- Switching chat models never breaks a vault.
- No layer can report success for a non-retrievable chunk.
- The full corpus exports and re-imports.
- A bad migration cannot destroy data.

---

### STAGE 2 — The brain works  ✅ COMPLETE
*Goal: genuinely better than searching the web — the author's stated bar. Retrieval
quality is the ceiling on everything; this stage raises it.*

- [x] **Multi-Expert selection + federated retrieval (v1).** Picker is multi-select;
      the chat handler embeds the query once, searches every selected vault, and
      layers each expert's persona + matched knowledge into a `<specialist_panel>`
      prompt. Header lists consulted experts; grounding badge reports combined
      matches + contributors; selection persists. Also pulled Deep Research query
      **decomposition** forward (deriveSearchQueries). *Verified live with a 2-expert
      panel.* (Cross-vault dedup/rerank and the shared retrieval extraction landed
      later in this stage — see the reranking and `ContextBuilder` entries below.)
- [x] **Hybrid retrieval.** Schema v4 adds an FTS5 index over vault chunks;
      `searchSpecialistKeyword` (BM25) is fused with vector similarity via RRF
      (`fuseHybrid`) per vault before cross-vault reranking. *Honest note: on three
      live probes nomic-embed-text already ranked the target first, so the measured
      gain was precision + insurance, not a dramatic win.*
- [x] **Reranking pass (score-based v1).** Each vault yields deeper candidates
      (top-8); a pure reranker (`electron/retrieval.cjs`) keeps the globally best few
      across all consulted vaults by similarity score, and grounding is credited by
      actual contribution. *Verified live on a 3-expert panel.* (Cross-encoder / LLM
      reranking remains a possible future upgrade.)
- [x] **Precise, verifiable citations — DONE.** Make every
      grounded claim traceable to an exact location — critical for the legal/medical
      use cases (invariants #1, #2).
      - **Capture location at ingestion:** chunk PDFs *per page* and store `page`
        (+ char offset within the page); for web, keep the URL and the exact quote;
        for text/md, store char range. New `specialist_chunks` columns: `location`
        (human label, e.g. "p. 12" / "§3.2"), `page`, `char_start`, `char_end`.
      - **Render source cards from the retrieved chunks, not the model's text** —
        precision is guaranteed regardless of what the model writes (NotebookLM
        model). Each card: exact quoted chunk · Expert · document/source title ·
        location · deep link.
      - **Deep links:** web → text-fragment URL (`…#:~:text=<exact quote>`) that
        scrolls to and highlights the sentence; local PDF → open at `page` (needs a
        viewer — the pdf-viewer surface or an embedded one). **Depends on the
        `setWindowOpenHandler` fix (Stage 4) since these links are clickable.**
      - Reuse/extend `CitationsList`; add a specialist-sources card list driven by
        `specialistGrounding` + the selected chunks' provenance.
      - Migration + re-ingestion note: existing chunks lack `page`/offsets; capture
        them on new ingests and offer a "re-ingest source" to backfill (the raw
        document/URL is recorded, so this is feasible for files still on disk / URLs
        still reachable).
- [x] **Query decomposition** for multi-hop — `queryPlanner.planRetrievalQueries`
      splits the question via the background model; results unioned at best score.
- [x] **Aggregation queries** — `sampleHubChunks` takes an evenly strided sample of
      the whole vault and `aggregateVault` map-reduces it on the background model,
      preserving source labels. *Verified: surveyed all 8 chunks where top-k saw 4.*
- [x] **Contradiction/absence handling (v1)** — classified questions add explicit
      opposing probes ("evidence against …", "limitations/contraindications …") so
      disagreeing passages are retrieved, and the prompt directs the model to state
      conflicts plainly rather than smoothing them over (Stance §1). *Deeper
      claim-level detection remains a future upgrade.*
- [~] **Memory that compounds** (fixes the degradation bug) — CORE DONE:
      - [x] dedup on insert (canonical-form match refreshes instead of duplicating);
      - [x] relevance-ranked retrieval (`rankMemoriesByRelevance`), not `slice(0,10)`
            by recency;
      - [x] supersede-on-contradiction (schema v6: candidates pre-filtered by overlap,
            background model decides; retired facts kept for history, hidden from retrieval);
      - [x] editable auto-extracted facts (inline edit in the Memory Vault UI);
      - [x] decay/staleness (reinforcement favours established facts; old
            unreinforced facts decay). *Verified live: "switched to Ubuntu Linux"
            retired the Windows fact, kept the unrelated one, preserved history.*
- [x] **Model routing** (invariant #5): opt-in `backgroundModel` for summaries, fact
      extraction, and research query generation (empty = chat model). Settings UI
      selector. *Verified: routes to the background model when set, falls back
      otherwise.*
- [x] **Notes as first-class objects.** Schema v5 `notes` table; `indexNote` embeds
      each note into the vault (source_type=note) and REPLACES its chunks on edit so
      stale insight never lingers. NotesPanel in the Expert modal plus a "Save as
      note" action on answers. *Verified: created → retrieved; edited → replaced;
      deleted → removed from vault.*
- [x] **Auto-suggest relevant Experts** — un-consulted vaults are probed with the
      question embedding; clearly-relevant ones (≥0.6) are offered inline, one click
      to add. *Verified: protein question suggested Nutrition (0.757), stayed silent
      about Art History.*
- [x] **Extracted `ContextBuilder`** (`electron/contextBuilder.cjs`) — ipc.cjs
      729 → 502 lines; 4 tests exercise the whole pipeline in isolation.

**STAGE 2 EXIT:** on a real topic the author uses, consulting Experts beats a web
search for accuracy + trust; memory measurably improves over a month instead of
degrading.

**STATUS (2026-07-24): all planned Stage 2 items implemented and verified.** Test
suite 25 → 50. The exit criterion is a *usage* judgement, not a code one — it is
met when the author has run real work through it for a while. Known follow-ups
carried forward rather than blocking: cross-encoder/LLM reranking (score-based v1
shipped), claim-level contradiction detection (probe-based v1 shipped), and
backfilling citation provenance for chunks ingested before schema v3 (new ingests
capture it; a "re-ingest source" action would repair older ones).

---

### STAGE 2.5 — Expert Roundtable (multi-turn deliberation)  ✅ v1+v2 SHIPPED
*Goal: when several Experts are consulted, let the user watch them actually
deliberate — each speaking in its own grounded voice, responding to each other over
N rounds — then have a moderator consolidate. This is the fullest expression of the
project thesis: multiple cited perspectives, disagreement surfaced rather than
flattened, and the user as the decision-maker (Stance §1, invariants #1/#1a/#9).*

**Today (Stage 2):** consulting N Experts produces ONE blended answer in one voice
from a single model call. The panel prompt asks it not to flatten disagreement, but
there are no distinct Expert turns and no interaction.

#### Behaviour to build
- **Mode toggle** in the composer/panel: **Synthesized** (current) vs **Roundtable**.
- **Rounds selector (N)**, visible only in Roundtable mode.
- On send, the discussion runs **round by round, Expert by Expert**, each turn
  streaming into the conversation as it is produced — the user watches it happen and
  can interject/cancel. They are in the room, not waiting outside it.
  - **Round 1:** each Expert answers the user's prompt from its own vault + the
    conversation context.
  - **Rounds 2..N-1:** each Expert sees the transcript so far and responds to the
    others — agreeing, disputing, refining, or explicitly conceding.
  - **Round N (final):** the moderator asks each Expert for a closing position.
  - **Moderator turn:** synthesizes for the user — where they agreed, where they
    disagreed and why, the facts with their sources, and the conclusions drawn.
- Every Expert turn keeps **its own grounding badge and source cards**, so each
  claim stays traceable to that Expert's vault (invariant #1).

#### Implementation sketch (foundations already in place)
- **Schema v7** — `messages` gains `expert_id`, `expert_name`, `round`,
  `turn_kind` ('expert' | 'moderator'). Each turn is its own assistant message, so
  history reloads coherently and each turn carries its own citations.
- **`RoundtableOrchestrator`** — loops rounds × Experts, building each turn's prompt
  from `ContextBuilder` (that Expert's persona + its retrieved chunks) plus the
  running transcript. Reuses the existing per-Expert retrieval from `groups`.
- **Streaming** — today one `requestId` → one message. Add a `turnId` to
  `streamUpdate`/`streamComplete` and a `discussionComplete` event; the renderer
  appends turns as they arrive.
- **Cancellation** — keep ONE AbortController for the whole discussion in
  `activeGenerations`; the orchestrator checks `signal.aborted` between turns so
  Cancel stops the round-trip immediately, not just the current token stream.
- **Retrieval policy (v1)** — retrieve once per Expert at round 1 and reuse that
  grounding for later rounds; re-retrieving per round is a later refinement (cost).

#### User controls during a discussion (decided 2026-07-24)
- **Abort** — stops the discussion immediately, keeping the turns already produced.
- **"Answer now"** — cuts the remaining rounds short and jumps straight to the
  moderator synthesis. The user is never trapped waiting for round 4.
- **Early moderator** — if every Expert passes ("nothing further to add") while
  rounds remain, the moderator wraps up immediately instead of burning turns.
- **Generous per-turn time limit** — Experts get real time to think; the guard is
  the user's Abort/Answer-now, not an aggressive timeout that truncates reasoning.
- **Explicit pass** — an Expert may decline a turn rather than padding with
  agreement; passes are shown ("Nutrition Expert had nothing to add").

#### Risks to design for — these decide whether it feels good
1. **Latency multiplies.** N rounds × E Experts + 1 moderator generations
   (4 rounds × 3 Experts = 13). On a 70B this is minutes. Mitigations: let
   Roundtable use the **background/faster model**, run **round 1 in parallel**
   (Experts don't see each other yet), cap N, and show clear progress
   ("Round 2 of 4 — Nutrition Expert speaking").
2. **Context growth.** By round 4 the transcript is large. Needs a token budget:
   summarize earlier rounds, or pass only each Expert's own last turn plus a running
   digest — otherwise small models overflow and silently truncate the system prompt.
3. **Degenerate agreement.** Local models tend to converge to "I agree with the
   previous expert," padding rounds with nothing. Mitigations: instruct Experts to
   speak only when they can **add, dispute, or refine**; allow an explicit
   "no further comment" that skips their turn; consider stopping early when a round
   adds nothing new. **This is the main quality risk — validate before raising N.**
4. **Cost/benefit of high N.** Diminishing returns past ~3 rounds. Default to 2–3.

#### Phasing
- [x] **v1 — Independent panel:** each Expert answers the prompt in its own voice
      (round 1 only), rendered as separate grounded turns + moderator synthesis.
      Parallelizable, fast, delivers most of the value.
- [x] **v2 — Deliberation:** rounds 2..N where Experts see and respond to each other,
      with the "only speak if you add something" rule and explicit passes.
      *Shipped together with v1; the transcript budget/digest is deferred to v3.*
- [~] **v3 — Polish:** convergence handling **DONE** (independent round 1,
      anti-restatement instructions, and programmatic redundancy → visible pass;
      verified on the reported 5-Expert/4-round case: max pairwise similarity 0.44).
      Still open: per-round re-retrieval, transcript export, "save the moderator
      synthesis as a Note", and a transcript digest for high N on small models.

**STATUS (2026-07-26): v1 + v2 shipped and verified live.** 2 Experts x 2 rounds +
moderator on llama3:8b ran in ~21s with correct turn order, per-turn grounding, real
cross-expert response, and a structured agreed/disagreed synthesis. Experts held
distinct positions rather than converging once turn identity was stated explicitly.
**Known limits carried forward:** transcript context is passed whole (no digest yet —
watch on small models at high N) and there is no per-round re-retrieval. Convergence
is now handled (see v3). **Field-tested 2026-07-26:** the first real 5-Expert x
4-round run exposed round-1 anchoring, since fixed — a reminder that this feature
needs real panels, not synthetic ones, to validate.

**STAGE 2.5 EXIT:** with 3 Experts and N=3 on a real question, the user sees three
distinct, individually-cited perspectives, at least one genuine disagreement or
refinement, and a moderator synthesis that is more useful than the single blended
answer — without the wait feeling unreasonable.

---

### STAGE 3 — It grows safely  (~4 weeks)
*Goal: the "always getting better" property, without entropy or corpus poisoning.*

- [ ] **Research Inbox.** Every auto/web search is *captured* — staged, attributed,
      dated, **unindexed**. Nothing enters a vault until promoted (invariant #6).
- [ ] **Deliberate promotion.** One-click promote → pick destination Expert +
      assign trust tier. Keeps "always improving" with a human in the loop.
- [ ] **Expert lifecycle tools.** Merge, split, rename, delete-with-confirm. Without
      these, auto-growth → 60 overlapping "Python*" Experts.
- [ ] **Gap detection.** "You've asked about X five times and no Expert covers it —
      create one?" → the auto-grow *feeling* without the sprawl.
- [ ] **Implement or delete `depth`.** Either bounded recursive crawl (visited-set,
      per-domain cap) or remove the param + fix the README.
- [ ] **Self-directed Expert growth (autonomous research).** On a schedule, an Expert
      proposes its own Deep Research prompts to fill gaps in its domain, runs them,
      and grows — the "Experts improve while you sleep" hook.
      - **Ground the gap detection in real signals, not model imagination:** questions
        the user actually asked that retrieved poorly (low top score / ungrounded
        answers), topics referenced inside the vault but thinly covered, and sources
        that have since been updated. An Expert asked to invent its own weaknesses
        will hallucinate them; these signals are measurable.
      - **Findings land in the Research Inbox — staged, attributed, UNINDEXED**
        (invariant #6). Autonomous *capture* is the feature; autonomous *trust* is
        the corpus-poisoning bug. Promotion stays a human click.
      - **Per-Expert autonomy setting** with a hard rule: Experts holding
        `own-records` or medical/legal trust tiers never auto-promote. A coding
        Expert may be allowed to, once the pipeline has earned trust.
      - **Show the diff** — "3 new findings for Python Expert since Tuesday" with
        what changed, so growth is legible rather than silent.
      - **Budget guards** — cap runs per day, respect robots/rate limits, and never
        run research while the user is waiting on a chat turn.

**STAGE 3 EXIT:** a month of heavy use yields a clean, trusted, non-redundant set of
Experts; no unvetted content ever silently entered a vault.

---

### STAGE 4 — Security, Privacy & Compliance  ✅ COMPLETE
*Goal: the corpus is safe at rest and access is accountable — the precondition for
trusting Sidekick with medical records, legal contracts, and other sensitive data,
and a hard prerequisite for any distribution.*

- [ ] **Close the Electron link-handling gap (do FIRST — also gates precise
      citations).** Add `setWindowOpenHandler` + a `will-navigate` guard; open
      external links via `shell.openExternal`; deny in-app navigation to remote
      origins; revisit `sandbox: true`; tighten CSP. *Today a clicked link opens a
      window that inherits the preload bridge (`window.sidekick`) — a data-exfil
      path. Flagged in the original audit; still open.*
- [x] **Encryption at rest (SQLCipher-class) ✅ SHIPPED.** Whole-file AES-256;
      opt-in, reversible, and nothing is encrypted until a user sets a passphrase.
      - **Library:** `better-sqlite3-multiple-ciphers` (drop-in for `better-sqlite3`,
        bundles AES-256 / SQLCipher-compatible). Industry-standard and the cleanest
        path here; plain `better-sqlite3` cannot do SQLCipher natively.
        **Feasibility confirmed 2026-07-26:** published at 12.11.1, an EXACT version
        match with our better-sqlite3 12.11.1 — a true drop-in at the same API level.
        Requires an electron-rebuild for the Electron 41 ABI (revertible).
      - **Adoption plan (decided):** the driver swap is safe for existing data (with
        no key set it reads plaintext databases identically), and encryption stays
        **opt-in** — the user sets a passphrase, and only then is the corpus rekeyed
        behind a fresh backup. Nobody is force-migrated.
      - **Key management:** derive the key from a user passphrase via a KDF
        (scrypt/argon2/PBKDF2); optionally cache via Electron `safeStorage`
        (OS keychain) for convenience. The key is never stored in plaintext.
      - **Migration:** rekey in place behind an automatic backup. ✅ implemented and
        verified on a copy of the real 6.4 MB corpus (16 conversations / 8 Experts /
        289 chunks identical before, during and after; 0.2s). Reversible — rekey to
        an empty passphrase decrypts back to plaintext.
      - **⚠️ Gotcha found by experiment:** SQLite rejects rekey under WAL. The
        operation must drop to journal_mode=DELETE and restore WAL afterwards.
      - ✅ **Step 2b done:** lock screen, unlock/enable/disable/change-passphrase IPC
        + UI, safeStorage (OS keychain) caching, and deferred repository construction
        with a LOCKED guard on all 46 handlers so the gate is enforced in the main
        process rather than the renderer.
      - **Threat model (state it honestly):** protects a *stolen laptop / copied
        `.db` / stolen backup*. It does **not** protect against malware running as
        the user. JSON corpus exports are plaintext by design → offer an encrypted
        export option and mark plain exports as sensitive.
- [x] **App lock (single-user local gate) ✅ SHIPPED.** Passphrase gate with optional
      OS-keychain `safeStorage` caching; the passphrase IS the encryption key. Manual
      lock available, plus **auto-lock on idle** (system-wide idle via powerMonitor,
      enforced in the main process) and immediate lock on suspend / workstation lock.
- [x] **Audit log ✅ SHIPPED.** Append-only `audit_log` table recording sensitive actions
      (corpus open, export/import, delete, Expert train/re-index, settings change,
      integrity events) with timestamp + details; optional hash-chain for
      tamper-evidence; a viewer + export in the UI. Directly serves the
      legal/medical compliance narrative. *Hash-chained (SHA-256 over the previous
      hash), verified across restarts; edited AND deleted entries both detected with
      the broken sequence number. Secret values are never recorded. Settings →
      🔒 Security & Audit shows verification, the entry list, and JSON export.*
- [x] **Dependency & supply-chain hygiene ✅ SHIPPED.** GitHub Actions CI (install
      incl. native rebuild → build → full suite → audit) on push/PR and weekly, so
      new advisories surface without any code changing. `npm run audit:prod` fails on
      high-severity production advisories; dev-only findings warn. Currently 0.

> **PRODUCT-DIRECTION DECISION — RBAC / multi-user (do NOT build speculatively).**
> Role-based access control implies *multiple users with differentiated
> permissions*, which contradicts the pure-local, single-user, "you own it" thesis.
> It only makes sense if Sidekick pivots to **organizations** (a firm/clinic), and
> that is a *different, larger product*: multi-tenant data model, almost certainly a
> server/sync layer, per-user encryption boundaries, and a genuine multi-user threat
> model — plus regulatory scope (e.g. HIPAA if handling others' PHI). Recommendation:
> ship **app-lock + audit log** for the personal product; treat **RBAC + multi-user**
> as a deliberately-scoped **"Teams / Enterprise edition"** decision, not a bolt-on.

**STAGE 4 EXIT:** ✅ met. The corpus CAN be encrypted at rest behind an app lock with
auto-lock; sensitive actions are logged in a tamper-evident chain; the link-handling
exfil path is closed; CI audits dependencies.

**STATUS (2026-07-27):** encryption is opt-in and OFF by default — the mechanism is
shipped and verified on a copy of the real corpus, but no user is force-migrated.
**Carried forward:** plaintext JSON exports are by design (an encrypted-export option
is worth adding before distribution), and the unencrypted pre-encryption backup is
left on disk for safety — the UI names its path so the user can remove it.

---

### STAGE 5 — Distribution & Commercialization  (scope depends on business model)
*Goal: a stranger can buy, install, trust, and run it — and you can support it.*

- [ ] **Packaging & delivery:** electron-builder/forge, app icons, installers,
      **code signing** (Windows Authenticode + macOS notarization), **auto-update**,
      and **multi-platform builds** (Win/Mac/Linux) for market reach.
- [ ] **License activation:** offline-verifiable signed license files / keys (no
      phone-home required, consistent with the privacy thesis).
- [ ] **Onboarding / cold-start:** guided first run — check/pull the embedding model,
      help pick a chat model, and build one genuinely useful Expert in <5 min.
- [ ] **Model management & curated recommendations.** The user always chooses the
      model (invariant #5); the app's job is to make choosing easy.
      - **Sortable/filterable model list** — by size, family, and role suitability
        (fast/small vs accurate/large vs uncensored vs embedding), reading what is
        actually installed from `/api/tags` plus recorded parameter size.
      - **Curated recommendations with one-click pull** covering the useful range:
        a small fast model (background/utility), a mid-size accurate one (chat), an
        uncensored option (Stance §1 — the user decides what they run), and the
        embedding model. Show download size and stream pull progress.
      - **Consent, not auto-download.** Models are multi-GB; silently pulling 3–5 on
        first run would consume tens of GB of the user's disk and bandwidth without
        asking. Recommend + one click to accept — never a background pull the user
        did not choose. (Also lets the app suggest sizes appropriate to their RAM/VRAM.)
      - **Role defaults** — once models exist, suggest sensible chat / background /
        embedding assignments, all overridable.
      - **Trigger points** — the recommendation screen opens automatically on first
        run and whenever the app detects **no usable models** (or no embedding
        model), so a fresh install is never a dead end.
      - **Fit to this machine** — recommend by detected RAM/VRAM and disk, marking
        options that will not run well rather than letting the user pick a 70B on a
        laptop and conclude the app is broken.
- [ ] **Publish minimum requirements up front** (README + site + installer): disk per
      model tier, RAM/VRAM for each recommended model, and the fact that Ollama is a
      prerequisite. A local-LLM app that hides its hardware cost earns refunds.
- [ ] **Starter Experts:** curated, versioned, importable vaults for common domains.
      Solve cold-start AND are a natural **licensing/revenue unit**, defensible where
      the app shell isn't. (Enabled by Stage 1 portable export/import.)
- [ ] **Performance at scale:** replace the O(n) full-scan + `JSON.parse`-per-row
      vector search with `sqlite-vec` (or an ANN index) and `Float32Array` BLOB
      vectors; remove the FTS rebuild-on-boot. Needed once vaults reach 10k+ chunks.
- [ ] **Opt-in, local-first telemetry & crash reporting.** You can't support blind
      software — but it must be off by default, transparent, and privacy-preserving.
- [ ] **Legal:** EULA, privacy policy, and explicit **medical/legal disclaimers**
      ("not professional advice"; the app presents grounded facts, the user decides —
      Stance §1 / invariant #9). Consider jurisdictional review before marketing
      medical/legal use cases.
- [ ] **Quality gates:** ESLint + Prettier + CI (test + lint + `npm audit` on every
      change); consider incremental TypeScript for the IPC/repository boundary.
- [ ] **Accessibility & polish:** keyboard navigation, screen-reader labels, focus
      management; user-facing help/docs (distinct from CONTRIBUTING.md).

**STAGE 5 EXIT:** signed, auto-updating installers on ≥2 platforms; a licensed user
is productive in 5 minutes; performance holds at 10k+ chunks; legal + support basics
are in place.

---

### STAGE 7 — Expert Teams & Marketplace  (after Individual v1 ships)
*Goal: turn Experts from something each user builds alone into something they can
acquire, share, and assemble into teams — the clearest revenue surface and the
strongest answer to cold-start.*

- [ ] **Teams (Expert groups).** Name and save a panel — "Legal Team", "Medical
      Team (allergist + nutritionist + dietitian)", "Marketing Team", "Investment
      Advisors", "Grant Writers" — and consult it in one click, in Synthesized or
      Roundtable mode. Small step up from the existing multi-select panel.
- [ ] **Expert Packs / Team Packs** — portable, versioned export of one Expert or a
      whole team (personas + vaults + notes + provenance). Builds directly on the
      Stage 1 corpus export; §5a lists the single-Expert version as an early win.
- [x] **Marketplace / library (v1) ✅ SHIPPED** — a built-in, browsable Expert
      Library: 22 curated templates across Coding/Business/Law/Medicine/Finance/
      Research/Writing/Lifestyle, searchable and category-filtered, installable in
      one click. Ships as recipe packs (persona + seed research brief run on the
      user's machine), so the licensing constraint is satisfied by construction.
      *Verified: Contract Analyst installed with 27 retrievable chunks in 7.7s.*
      Still open: remote/downloadable catalog updates and pack versioning.
- [ ] **⚠️ Content licensing is the gating risk, not the engineering.** A vault holds
      *copies of source text*. Redistributing a pack built from copyrighted journals,
      paywalled case law, or scraped books is infringement — worse in the exact
      high-stakes domains (medical, legal) where packs are most valuable. Viable
      designs, in order of preference:
      1. **Recipe packs** — ship the *persona + research plan + source URLs*, and the
         user's own machine fetches and indexes the content locally. Distributes
         know-how, not copies.
      2. **Public-domain / open-licence corpora** — statutes, PubMed abstracts,
         government publications, open-access journals, docs with permissive licences.
      3. **Licensed content** — only with an actual agreement from the publisher.
      Every pack carries a manifest: sources, licences, build date, and the embedding
      model used. **Get this reviewed before selling packs.**
- [ ] **DECIDED (2026-07-24): packs ship as self-assembling recipes.** A pack contains
      personas, team composition, and a built-in **first-round research plan**; on
      download the user's own machine runs that research and builds the vaults
      locally. Nothing copyrighted is redistributed, and each install produces a
      vault whose provenance is the user's own fetch. Ship progress UI for the
      assembly run (it is a Deep Research run, so it already reports honestly).
      **Phase 2 — licensed preloaded content:** once counsel has verified what may be
      bundled per domain, packs may ship prebuilt vault content. Treated as a
      separate, legally-gated expansion, not a v1 requirement.
- [ ] **Curation quality bar** — a bad prebuilt medical team is a liability, not just
      a poor product. Packs need provenance, a visible build date, trust tiers, and a
      clear "not professional advice" framing (invariant #9).

**STAGE 7 EXIT:** a new user downloads a team pack and gets genuinely useful, cited
answers within minutes of install — with every pack's sources and licences legible.

---

### STAGE 8 — Workflow Experts (orchestrated multi-agent work)  (LATER — largest bet)
*Goal: a "manager" Expert that coordinates a team across many turns to produce a real
deliverable — a novel, a business plan, a literature review, a legal memo — with the
grounding and citation discipline the rest of the app enforces.*

This is the natural extension of the Roundtable (Stage 2.5): the same turn-taking
machinery, but goal-directed, long-running, and artifact-producing.

- [ ] **Workflow definition** — a manager persona plus an ordered set of stages, each
      naming which Experts act and what the stage must produce (e.g. Novelist:
      ideation → outline → character development → draft-by-section → continuity pass).
- [ ] **Durable run state** — a workflow may span hours and hundreds of generations.
      Runs must be persisted, resumable, inspectable, and cancellable; a crash or
      restart must not lose the work.
- [ ] **Artifact store** — the deliverable is a first-class object, versioned per
      stage, diffable, and exportable (it is not a chat transcript).
- [ ] **Human checkpoints** — approve/redirect between stages. Fully autonomous
      long-run generation compounds small errors into confident, well-formatted
      nonsense; a review gate at each stage is what makes the output trustworthy.

#### Collaborative workspace (decided 2026-07-24) — ambient human-in-the-loop
Rather than blocking the team at every gate, the user works *alongside* it:

- [ ] **Workflow folder on disk** — each run creates a folder containing `plan.md`
      (the manager's plan, written first from the activating prompt) and the
      deliverable documents. Human-readable, portable, and survives a crash: if the
      run aborts, the plan and artifacts remain, can be edited, and can be referenced
      from ordinary chats with other Experts while the user decides what to do next.
- [ ] **Live document view** — the user opens the working document at any time,
      reads, edits prose, and leaves notes for the team **without pausing the run**.
- [ ] **Edits are read as instructions** — before each stage/turn the manager diffs
      the document against the last agent-written version, reads what the user
      changed or added, and routes it to the relevant team members ("the reader wants
      more tension in ch. 3"). The team keeps working; the user is never blocking.
- [ ] **Team thread beside the document** — Experts talk to each other and report
      progress in a conversation thread, so the user can watch the reasoning, not
      just the output.
- [ ] **Abort** (stop now, keep everything produced) and **"Wrap it up"** (manager
      finishes the current unit, writes a clean closing state, and stops) — the same
      controls as the Roundtable, scaled to a long run.

#### Resolved design (2026-07-24) — how each problem is handled

**Workspace.** The user picks an existing **empty folder** via a native dialog; the
app does not invent locations. That folder is the sandbox root. *Still required:*
sanitize model-supplied file names **inside** it — a generated name of `../../x`
must be impossible even though the root was user-chosen.

**Resume — two files, two jobs.**
- `progress.md` — a running narrative the manager maintains: what is done, what is
  in flight, decisions taken. Human-readable, and used to **re-ground** the manager
  and to build each Expert's re-entry prompt.
- `run-state.json` — the machine truth: stage index, whose turn, pending items,
  per-section status, content hashes. **Prose alone is not a resume mechanism** — a
  model re-reading a narrative can misinterpret it; structured state cannot. Keep
  both; the JSON decides control flow, the prose supplies context.
- ⚠️ **Terminology/feasibility:** the manager is **not re-trained** on the plan or
  document (no fine-tuning — that is expensive, slow, and not what Ollama does here).
  It is **re-grounded**: plan, outline, `progress.md`, and the relevant document
  sections are retrieved into its context each turn — exactly the RAG the app
  already does. Same practical effect, no training cost.

**Document safety — rolling draft + published version.** The team works on a rolling
draft; the user sees the published document. Before publishing, the manager diffs the
published doc against what it last wrote, incorporates any user changes, then writes.
*Still required:* a **content-hash guard** at write time — if the published doc
changed between read and write, re-diff instead of overwriting. Without it there is
still a lost-update window (manager reads T1, user edits T2, manager writes T3).
Writes go staged-file → atomic rename.

**Note vs. content — resolved by asking.** Unambiguous cases need no ceremony:
prose edits are treated as canon and preserved; clear instructions are acted on. When
an edit is genuinely ambiguous, **the manager asks in the team chat to confirm intent
before revising**. *Still required:* a non-blocking fallback — if the user is away,
the manager parks that section, continues elsewhere, and records the open question in
`progress.md`, rather than stalling the run.

**Milestones instead of fixed gates.** The plan proposes milestones where the team
pauses for review; the user accepts, moves, or removes them — giving the team as much
slack as their track record has earned. **Plan and outline approval remain mandatory**
(structural error is what ambient editing cannot catch).

**Citations — always tracked, optionally displayed.** Provenance is retained for every
generated claim regardless of workflow type; *presentation* is configurable: inline
for business plans and research, or collected into a final sources section that can be
omitted from a creative-writing export. Never discard the data, only its display.

**Editor — deferred.** No rich text editor in v1. The app shows the document
read-only and **watches the file**, so the user edits in whatever they already use
(VS Code, Obsidian, Word) and the manager still sees the changes. An in-app editor is
a later refinement.
- [ ] **Grounding carried through** — every factual claim in the artifact keeps its
      citation, so a literature review or legal memo is verifiable, not plausible.
      This is the one thing that makes a local, private version of this genuinely
      better than the cloud multi-agent tools.
- [ ] **Cost realism** — a novel is *hundreds* of generations. Needs background
      execution, progress reporting, model routing (small model for mechanical
      stages), and honest time estimates before a run starts.

**Why it is staged last:** it multiplies every open risk (latency, context budget,
error compounding) and demands new infrastructure (durable runs, artifacts,
checkpoints). Build it once the Roundtable has proven that multi-agent turn-taking
produces genuinely distinct, useful contributions on local models.

**STAGE 8 EXIT:** a Business Developer workflow turns a one-paragraph idea into a
sectioned, cited business plan the user would actually show someone — with visible
stage checkpoints and a resumable run.

---

### STAGE 6 — Enterprise edition  (DEFERRED — parallel track, gated on business model, open Q#4)
*A separate, larger product built ON TOP of the Individual base. Do not start until
Individual has shipped and validated demand.*

- [ ] **Multi-user identity & accounts** — the data-model shift from single-user to
      multi-tenant; per-user encryption boundaries.
- [ ] **RBAC** — roles/permissions over Experts, corpora, and actions.
- [ ] **Server / sync layer** — almost certainly required for shared team Experts,
      central audit, and cross-device access (a major architectural addition to a
      currently pure-local app).
- [ ] **Deployment** — Docker image / single-command startup for self-hosting, or
      central IT-managed desktop rollout (MSI + policy); managed updates.
- [ ] **Org compliance** — org-wide audit/reporting, SSO/SAML, SOC 2, DPAs, and
      HIPAA scope if handling others' PHI (triggers a real regulatory program).
- [ ] **Shared/curated team Experts** and admin governance.

**STAGE 6 EXIT:** a team can be provisioned with roles, shared Experts, and central
audit, deployed via one supported path, meeting the compliance bar their industry
requires.

---

## 5a. Differentiator shortlist (high value per unit of work)

Candidates evaluated against the crowded local-LLM field (LM Studio, Jan, GPT4All,
AnythingLLM, Msty, Open WebUI) and NotebookLM. Ranked by value ÷ effort. The wedge
is **compounding Experts + verifiable citations + deliberation**, not "chat with a
local model," which is commoditized.

- [x] **Drop a document straight into the chat (ad-hoc Expert).** ✅ SHIPPED — Drag a PDF into a
      conversation and immediately ask about it, without first creating an Expert;
      offer "keep this as an Expert" afterwards. **Easy** — reuses the whole ingest
      path. Directly fixes cold-start, which is the biggest adoption risk: it is
      NotebookLM's best moment and today Sidekick makes you build an Expert first.
- [x] **Expert Packs — single-Expert export/import.** ✅ SHIPPED — Export one Expert (persona +
      vault + notes + provenance) as a portable file. **Easy** — the full-corpus
      export already exists; this scopes it to one hub. Unlocks sharing with
      colleagues, backup, the starter-Expert library, and the natural licensing unit.
- [ ] **Open the cited page in-app with the passage highlighted.** Clicking a source
      card opens the PDF at that page and highlights the exact quote, instead of
      handing off to an external viewer. **Medium** — `pdf.js` already ships
      transitively via `pdf-parse`. This is what makes precise citations *feel*
      real, and it is precisely what a lawyer or clinician wants.
- [ ] **Mark unsupported sentences in an answer.** After generation, flag claims that
      no retrieved chunk supports, so "grounded" is visible per-claim rather than
      per-answer. **Medium** (start lexical/entailment-lite, be honest about
      precision). The strongest possible expression of invariant #1a.
- [ ] **Keep an Expert current (scheduled research).** Re-run an Expert's research on
      a cadence and surface what changed. **Medium** — pairs with the Stage 3
      Research Inbox so new material is staged, not silently trusted.

## 5b. Go-to-market prerequisites (non-code; needed before monetizing Individual)

Engineering isn't the only gate to revenue. These are commonly missed:

- **Pricing model.** A local, server-less app fits a **one-time license** or
  **paid major-version upgrades** better than a subscription (users will ask "what
  am I paying monthly for if it runs on my machine?"). Decide before building
  activation.
- **Payments + tax.** Use a **merchant-of-record** (Paddle, Lemon Squeezy, Gumroad)
  so global VAT/sales-tax and refunds are handled for you — significant for a solo
  seller. Stripe alone leaves tax compliance to you.
- **Trial / freemium mechanism.** Time-limited trial or a capped free tier to lower
  the adoption barrier (cold-start makes "try before buy" important).
- **Landing page + demo** (video or interactive) and a clear **positioning wedge.**
- **Competitive differentiation — be honest about the crowded field.** Local
  LLM + document-RAG desktop apps already exist (LM Studio, Jan, GPT4All,
  AnythingLLM, Msty). Sidekick's defensible wedge is the **compounding Experts
  (notebooks that grow), precise verifiable citations, and the "private advocate"
  framing for high-stakes domains (legal/medical)** — sharpen and lead with this,
  don't compete on "chat with a local model," which is commoditized.
- **Support + feedback channel** (email/Discord), a **changelog**, and a **refund
  policy.**
- **Model guidance in onboarding** — you don't ship models (Ollama does); the first
  run must gracefully handle "no models installed" and recommend sizes for the
  user's hardware.

---

## 6. Open questions (resolve before the stage they gate)

1. **Daily driver vs. portfolio piece?** Affects urgency of Phase −1 and doc
   accuracy. **RESOLVED:** both — personal daily driver now, distribution +
   University/government presentation later. Phase −1 is urgent.
2. **Is unrestricted/unfiltered presentation a design requirement?** **RESOLVED —
   yes, with a precise meaning.** The *application* presents raw, grounded facts and
   lets the user decide; it is not a moral/ethical guardian (Stance, §1). This is
   *not* "strip all safety" — it is **"no distortion, no narrative-spin, no
   imposed bias"**, enforced by citation + fact/inference separation (#1, #1a, #9),
   which is a *trust/fidelity* mechanism, not a censorship one. The reasoning model
   stays the user's free choice (#5). Turn this into tests: (a) grounded claims
   carry citations; (b) unsourced claims are marked; (c) a "contradicts a
   consulted professional" case is presented with facts + reasoning, not softened.
3. **Search privacy:** web search currently forwards the **raw verbatim prompt** to
   the provider ([`ipc.cjs:238`](electron/ipc.cjs)). For a "privacy-first" app,
   consider deriving a search query instead, and disclosing at the toggle. (Still
   open — gates Stage 3/4.)
4. **Single-user vs. multi-user product?** (Gates Stage 4 RBAC and much of Stage 5.)
   The current thesis is pure-local, single-user, "you own it." Monetizing to
   *individuals* keeps that shape (app-lock + audit log + encryption suffice).
   Monetizing to *organizations* (firms/clinics) requires multi-user + RBAC, which
   implies a server/sync layer, per-user encryption boundaries, and regulatory scope
   (HIPAA/PHI) — effectively a separate **Teams/Enterprise** product. **Decide the
   business model before building auth**, because it determines whether "auth" means
   a local app-lock or a full identity/permission system. (Author raised RBAC +
   audit + encryption on 2026-07-24; encryption + audit + app-lock are scheduled in
   Stage 4, RBAC deferred pending this decision.)

---

## 7. Guardrails for future sessions

- **Protect the corpus above all.** Never run a migration or bulk re-embed without
  Phase −1 in place.
- **Never reintroduce silent success.** If ingestion can't produce a retrievable
  chunk, it must say so — loudly, at every layer.
- **Never embed with a chat model.** Always the pinned `embeddingModel`.
- **Verify claims at runtime.** The §2 bugs were *reproduced*, not guessed. Hold new
  claims to the same bar before acting on them.
- **Update this file when direction changes.** A stale roadmap is worse than none.
- **A green build is not a working UI.** Wiring bugs (a handler prop that is never
  declared, a dead click target) fail neither the build nor the tests nor a boot
  check. When a feature is user-triggered, CLICK IT — drive the app or the dev
  server — before reporting it done. This has now cost two user-visible defects
  (the blank production window, the dead Expert Library button).
- **Never patch source with a regex you have not verified matched.** Both defects
  above came from a scripted replace that silently did nothing. Assert on the
  result or use an explicit edit.
