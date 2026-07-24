# Sidekick LLM — Engineering Roadmap

> **Read this first.** This document is the single source of truth for where the
> project is going and *why*. It is written to be picked up cold — by a future
> session, a collaborator, or the author six months from now — without the
> conversation that produced it. If you change direction, change this file.

Last updated: 2026-07-23

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

## 5. The stages

Effort estimates are rough and assume the author + this assistant. Each stage ends
with an explicit **exit criterion** — do not advance until it's met.

> **Sequencing rule:** Stage 1 (esp. Phase −1) protects the corpus and MUST land
> before any migration or bulk re-embed. The retrieval *interface* is designed for
> multi-Expert in Stage 1 even though the multi-Expert *UI* ships in Stage 2 —
> retrofitting single→federated means touching the same code twice.

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

### STAGE 2 — The brain works  (~6 weeks)
*Goal: genuinely better than searching the web — the author's stated bar. Retrieval
quality is the ceiling on everything; this stage raises it.*

- [ ] **Multi-Expert selection + federated retrieval.** UI multi-select of Experts;
      `RetrievalService` queries each selected vault, merges, dedups, reranks.
      (Interface designed in Stage 1; UI + merge logic here.)
- [ ] **Hybrid retrieval.** Combine FTS5 BM25 (already exists, not wired to vaults)
      with vector similarity. Naive cosine-top-4 fails on the real questions.
- [ ] **Reranking pass** over the merged candidate set (cross-encoder or LLM-scored).
- [ ] **Query decomposition** for multi-hop ("does this lab relate to that med?").
- [ ] **Aggregation queries** ("what does this Expert say about X overall?") — top-k
      chunks can't summarize a corpus; need map-reduce over the vault.
- [ ] **Contradiction/absence handling** — hardest retrieval problem, central to the
      second-opinion use case. A contradiction is *semantically similar* to what it
      contradicts; similarity alone won't find it. Needs explicit design.
- [ ] **Memory that compounds** (fixes the degradation bug):
      - dedup on insert; supersede-on-contradiction;
      - relevance-ranked retrieval, not `slice(0,10)` by recency;
      - editable auto-extracted facts;
      - decay/staleness.
- [ ] **Model routing** implemented (invariant #5).
- [ ] **Notes as first-class objects.** User- or model-authored, attached to an
      Expert, themselves embedded + retrievable. NotebookLM's most-loved feature;
      how *insight* compounds vs. documents merely piling up. The author explicitly
      named "create notes from data found in searches."
- [ ] **Auto-suggest relevant Experts** per question (surfaces the "association" feel).
- [ ] **Extract `ContextBuilder`** from `sendMessageStream` — testable, the best
      idea in the codebase, currently a 230-line handler.

**STAGE 2 EXIT:** on a real topic the author uses, consulting Experts beats a web
search for accuracy + trust; memory measurably improves over a month instead of
degrading.

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

**STAGE 3 EXIT:** a month of heavy use yields a clean, trusted, non-redundant set of
Experts; no unvetted content ever silently entered a vault.

---

### STAGE 4 — Product  (~6 weeks; gate behind months of personal use)
*Goal: safely shippable to strangers on their own machines.*

- [ ] **Security hardening:** `setWindowOpenHandler` + `will-navigate` guard;
      external links via `shell.openExternal`; revisit `sandbox`; tighten CSP.
- [ ] **Encryption at rest** (Electron `safeStorage` or SQLCipher). **Blocks
      distribution — personal medical records unencrypted is a liability the moment
      you ship.** Must precede v1.0, not follow it.
- [ ] **Packaging:** electron-builder/forge, icons, code signing, auto-update.
      (`npm run build` currently compiles only the renderer.)
- [ ] **Onboarding / cold-start.** New user = 0 Experts + a local 7B *worse than free
      ChatGPT*. Need one genuinely useful Expert built in <5 min, NotebookLM-style.
- [ ] **Starter Experts.** Curated, versioned, importable vaults for common domains.
      Solves cold start, is a natural **licensing unit**, defensible where the app
      shell isn't. (Enabled by Stage 1 portable export.)
- [ ] **Licensing + liability framing**, especially medical/legal disclaimers tied to
      invariant #9.
- [ ] Reconcile all docs (README, case_study, sidekick_plan) with shipped reality —
      no past-tense descriptions of unbuilt behavior.

**STAGE 4 EXIT:** a stranger installs, is useful in 5 minutes, data is encrypted,
app is signed + auto-updating, medical/legal framing is explicit and safe.

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
```
