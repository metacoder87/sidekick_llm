# Sidekick LLM — Performance Metrics & Benchmarking Plan

> **Purpose:** identify the aspects users and industry professionals will dissect,
> define the calculated metrics that quantify them, and plan a benchmark harness
> that runs from the UI, logs results, and displays them — so Sidekick's
> performance is measurable, comparable, and defensible.
>
> Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md) (what we're measuring),
> [ROADMAP.md](ROADMAP.md) (where the project is going).

---

## 1. What makes Sidekick interesting — and what critics will pick apart

These are the properties a user, reviewer, or engineer will form an opinion about.
Each maps to a metric family in §3 and a harness module in §5.

| # | Aspect (what Sidekick does) | Why it's interesting | What critics will poke at |
|---|---|---|---|
| A | **True offline inference in-process** (`node-llama-cpp`, GGUF, no server, no port — [ARCHITECTURE §1](ARCHITECTURE.md)) | No Ollama/LM Studio to install; no network surface; works on a plane | Is it actually as fast as a tuned llama.cpp? Does the in-process engine leak memory or hold VRAM? |
| B | **Three-way model role routing** (chat / embedding / background — [§3](ARCHITECTURE.md)) | Rare in consumer apps; each job gets the right model | Does switching models cost a reload every time? Do background jobs starve chat? |
| C | **AI Expert panels & round table** (personas + private vector vaults, moderator, [§4](ARCHITECTURE.md)) | Multi-persona grounded discussion is novel UX | Concurrent experts on one context — throughput, isolation, cost; quality vs. a single model |
| D | **Load-bearing embedding contract** (dimension/model-matched vectors, write-boundary validation, honest re-index — [§4](ARCHITECTURE.md)) | "Invisible, not degraded" is a strong engineering stance | Does retrieval actually rank well? What's real recall@k vs. marketing? |
| E | **Memory that compounds** (fact extraction, de-dup, reinforcement/supersession, rolling summary — [§5](ARCHITECTURE.md)) | The app improves with use instead of degrading | Extraction precision; does it remember *the right* fact next week; duplicate drift |
| F | **Grounded citations & honest failure** (citations, `[n]` provenance, "never a bare success:true") | Trust is the product | Groundedness rate — how often is an answer actually supported by a cited chunk? |
| G | **Data ownership & integrity** (encrypted SQLite, backup-before-migrate, integrity check, hash-chained audit log, export/import) | Users own everything; tamper-evident history | Startup/open-DB latency on large corpora; integrity overhead; does export/import round-trip losslessly under real sizes? |
| H | **Resilience under bad hardware** (Vulkan/CUDA fallbacks, CPU fallback, in-flight load dedupe — `electron/llama/`) | Works on a 5080 laptop *and* an iMac with no GPU | Silent perf cliffs: does CPU fallback take 20× slower? Does the app tell you *why*? |
| I | **Security posture** (context isolation, channel registry, CSP, no nodeIntegration) | Table stakes for an Electron app shipping to consumers | IPC surface size; renderer→main blast radius |

**The one-sentence pitch that must survive scrutiny:** *"Sidekick is a local-first
knowledge system whose quality, speed, and privacy are all verifiable on your machine
— open the Benchmarks panel and run it."*

That last clause is what this plan builds.

---

## 2. What users and industry professionals actually look at

Synthesizing how LLM apps and local-inference tools get reviewed (Ollama, LM Studio,
GPT4All, GPTEngineer-class local stacks, RAG evaluation literature):

1. **Speed you can feel** — time to first token, tokens/second, time-per-answer for a
   typical question. This is what Reddit/YouTube reviewers quote.
2. **Quality of grounded answers** — does it cite the right source, does it refuse to
   invent, how well does it integrate multiple experts without hallucinating.
3. **Memory & personalization over time** — "does it still know what I told it in
   January" is the killer feature *and* the most-asked question.
4. **Resource honesty** — VRAM/RAM used, battery impact, thermal behavior, and whether
   the app *reports* which tier it ran on (full GPU / partial offload / CPU).
5. **Stability** — long sessions, model switching, concurrent background jobs; no
   crashes, no silent fallbacks.
6. **Privacy verifiability** — "prove nothing left my machine" (network audit,
   offline-mode behavior).
7. **Reproducibility** — can I re-run the numbers myself on *my* hardware? (This is
   why the harness must run from the UI and export raw data.)

Everything below is designed so that a skeptic can reproduce §1–§7 on their own machine
and see Sidekick's actual numbers next to the same workload's reference values.

---

## 3. The metric system — calculated, normalized, comparable

### 3.1 Inference performance (engine layer) — *the numbers reviewers quote*

| Metric | Definition (calculation) | Industry reference |
|---|---|---|
| **TTFT** (time to first token) | `t(first chunk on stream) − t(request start)` ms, per run; report P50/P95 over N runs | Ollama/LM Studio published tok/s; LLM-perf suites report TTFT |
| **Prompt eval rate** | `prompt_tokens / (t_first_token − t_start)` tokens/s — measures how fast the context is processed | llama.cpp `llama-bench` prompt eval |
| **Generation rate** | `generated_tokens / (t_last − t_first)` tokens/s | llama.cpp `llama-bench` token generation — *the* standard local-LLM number |
| **E2E answer latency** | full answer time ms (P50/P95) | — |
| **Throughput (sustained)** | total tokens / wall time over a multi-turn load (e.g., 10 consecutive turns) | LLM serving benchmarks (ShareGPT-perf style) |
| **Concurrent-session throughput** | total tok/s with k=2…4 parallel expert sessions (round table) vs. k=1 | shows isolation overhead |
| **Cold start** | `t(first token of first-ever message) − t(app launch)`; split: process start → model load → context create → first token | app-launch benchmarks |
| **Warm reload** | model-switch cost when a second model is loaded (cache hit vs. miss) | — |
| **VRAM footprint** | `getVramState()` total/used at load and per +1k context tokens (KV slope, GB/k-token) | — |
| **RAM footprint** | `process.memoryUsage().rss` at load and per +1k tokens | — |
| **Offload tier achieved** | which `chooseGpuOffload` tier ran, `gpuLayers` used | self-report (honesty metric) |
| **KV-cache efficiency** | tokens/second *and* memory slope per context size (2k/4k/8k) | llama.cpp context benchmarks |

> **Why split prompt-eval from generation?** They scale differently (prompt eval is
> compute-bound and benefits from GPU; generation is bandwidth-bound). Reviewers who
> see one blended "tok/s" can't tell whether Sidekick's engine config is good.
> llama.cpp's `llama-bench` reports them separately — we should too.

### 3.2 Retrieval quality (RAG layer) — *where "AI Expert" either works or is theater*

Golden set: a versioned fixture of N documents (PDF/md/text, mixed topics) ingested
into a test Expert vault, plus a labeled query set (each query has ground-truth
relevant chunk IDs). All computed deterministically from `searchSpecialistVectorMemory`:

| Metric | Definition | Industry reference |
|---|---|---|
| **Recall@k** (k=3,5,10) | `relevant_hits@k / total_relevant`, mean over queries | standard IR |
| **Precision@k** | `relevant_hits@k / k` | standard IR |
| **MRR** | mean over queries of `1 / rank(first relevant)` | standard IR |
| **nDCG@k** | normalized discounted cumulative gain over the labeled relevance | standard IR |
| **Hybrid lift** | (Recall@k of vector+BM25+RRF) − (Recall@k of vector alone) | proves the hybrid pipeline earns its keep |
| **Dimension-safety** | count of legacy/mismatched vectors excluded vs. scored 0 (should be 100% excluded) | our own invariant — *measurable proof* of the embedding contract |
| **Latency (retrieval)** | query-embed + search ms (P50/P95) at 100/1k/10k chunks | RAG latency baselines |

### 3.3 Answer grounding & honesty — *the trust metric*

| Metric | Definition | Industry reference |
|---|---|---|
| **Groundedness rate** | fraction of answer sentences with supporting span in a cited chunk (judge model scores per claim: 0/1/partial → weighted rate) | RAGAS faithfulness |
| **Citation precision** | cited chunks actually used by the answer / all cited | RAGAS context precision |
| **Citation recall** | relevant chunks that *were* cited / all relevant | RAGAS context recall |
| **Refusal honesty** | on a "unanswerable from corpus" set: % correctly refused vs. hallucinated (binary, deterministic grading) | hallucination rate benchmarks |
| **Judge consistency** | variance of judge scores across N runs at temperature 0 / fixed seed (measures our own harness stability) | — |

> Judge model = the user's **background model** (role routing, [§3 of ARCHITECTURE](ARCHITECTURE.md))
> with rubric prompts; deterministic checks (refusals, citation presence) are
> always computed *without* the judge, so a weak judge model can't mask failures.

### 3.4 Memory quality — *the "does it actually learn me" metric*

Golden memory fixture: seeded persona + scripted interactions with known facts,
distractor facts, and one outdated fact later contradicted.

| Metric | Definition |
|---|---|
| **Fact-extraction precision** | extracted facts correct / extracted (judge or canonical-form match) |
| **Fact-extraction recall** | correct facts extracted / ground-truth facts stated |
| **Dedup effectiveness** | near-duplicate memories after N repetitions of the same fact (target: 1 canonical row) — already asserted in `test/repository.test.cjs`; benchmark measures drift over *many* turns |
| **Supersession correctness** | outdated fact marked superseded after contradiction; no longer retrieved |
| **Relevant-fact recall@turn** | on a later probe question ("what do you know about my X?"), does the right fact enter the prompt (inspect built system prompt) |
| **Cost per background pass** | tokens generated + wall time per summary/fact-extraction pass (users feel this as lag) |

### 3.5 Stability & resource behavior — *the long-session metric*

| Metric | Definition |
|---|---|
| **Soak** | 50-turn continuous conversation: TTFT and tok/s at turn 1 vs. turn 25 vs. turn 50 (detects leaks/KV bloat); RSS at each checkpoint |
| **Crash/error rate** | errors + unhandled rejections per 100 turns under a scripted mixed workload (chat + retrieval + memory + model switch + abort mid-stream) |
| **Abort cost** | time from abort signal to stream stop, and whether GPU memory is released (VRAM Δ after abort) |
| **Recovery** | after forced OOM/fallback, does next turn succeed and is the tier reported honestly |
| **DB scale** | open/integrity-check/export time at 1k / 10k / 100k messages (synthetic corpus) |
| **Privacy audit** | network calls made during a fully offline session (must be zero) + in online mode (only user-initiated search + downloads) — log every socket via `net` tracking |

### 3.6 Normalization & comparison strategy

- **Always record context** with the number: app version, OS, CPU, GPU, VRAM/RAM,
  engine (builtin/Ollama), model file + quant, tier achieved, context size,
  node-llama-cpp version, backend (Vulkan/CUDA/CPU). A number without this block is
  meaningless — and our own Vulkan free-VRAM incident (§5.6) is exactly why the
  *achieved tier* must be part of every result.
- **Self-normalized comparisons first:** Sidekick-builtin vs. Ollama (same model,
  same machine) and vs. a bare llama.cpp `llama-bench` reference for the same GGUF —
  this isolates *our* overhead, which is what critics can hold us to.
- **Published references second:** show vendor/published tok/s for the same quant on
  similar hardware as a *target band* (clearly labeled external, not a claim).
- **Per-GB and per-quant normalization** in reports (e.g., tok/s per GB VRAM) so
  different machines can be compared qualitatively.

---

## 4. Showing it in the UI

### 4.1 New "Benchmarks" panel

Location: **Settings → Benchmarks** (new tab) plus a compact **StatusPill** extension
in the chat view showing the live achieved tier (GPU/CPU) — today users can't see
which tier actually ran; that's the first trust gap to close (see [StatusPill.jsx](src/components/StatusPill.jsx)).

Panel sections:

1. **Run controls** — presets:
   - *Quick* (~30 s): engine metrics on the active model, 3 prompts.
   - *Standard* (~3–5 min): engine + retrieval + grounding on a fixture Expert.
   - *Full* (~10–20 min): + memory, soak, DB scale, privacy audit.
   - **Run / Abort** (abort must actually stop inference — `signal` plumbing exists).
   - Progress bar with current phase; runs are serialized (never concurrent with a
     live chat — engine lock) and run at background priority.
2. **Result view** — one run = one card:
   - Headline numbers: TTFT P50, generation tok/s, prompt tok/s, groundedness %,
     recall@5, achieved tier, VRAM used.
   - Per-metric table with P50/P95, N, and pass/target annotation.
   - **Sparkline history** per metric across runs (local, in `benchmarks` table).
   - Context block (hardware/model/versions) always visible, one-click copy.
3. **Compare view** — select 2+ runs: side-by-side diff table, deltas highlighted
   (e.g., "tok/s +18% after switching 3B→7B", "TTFT +40% — different tier?").
4. **Export** — JSON (raw, machine-readable), CSV (per-metric), Markdown
   (shareable report, includes context block + references) — via the existing
   file-save pattern. Raw JSON is the artifact a reviewer reproduces from.
5. **Targets & references** — each metric shows its target band and the source of
   the reference value (internal baseline vs. published), so the UI never implies a
   comparison it can't defend.

### 4.2 "Prove it" surfaces elsewhere

- **Citations panel** already shows grounding per answer — add a per-conversation
  groundedness roll-up (cheap: reuse §3.3 judge scoring as a background job,
  sampled, e.g., 1 in 5 turns) so trust is visible in-chat, not just in benchmarks.
- **Expert vault modal** shows `chunkCount` vs. `retrievableChunkCount` (existing) —
  add retrieval latency + last re-index info.
- **Audit log panel** already exists ([AuditLogPanel.jsx](src/components/AuditLogPanel.jsx))
  — benchmark runs are themselves auditable entries (who ran what, when, results hash).

---

## 5. Harness plan (what we build)

### 5.1 New modules

```
electron/bench/
  benchRunner.cjs      # orchestration: presets, phase sequencing, abort, IPC progress
  benchEngine.cjs      # §3.1: prompt-eval/generation rates, TTFT, soak, footprint,
                       #   concurrent sessions, cold/warm start, privacy socket audit
  benchRetrieval.cjs   # §3.2: golden vault ingest → golden queries → IR metrics
  benchGrounding.cjs   # §3.3: judge rubrics + deterministic refusal/citation checks
  benchMemory.cjs      # §3.4: scripted persona interactions → extraction/recall metrics
  benchStability.cjs   # §3.5: mixed workload, aborts, DB scale, recovery
  benchReport.cjs      # aggregation: P50/P95, targets, context block; JSON/CSV/MD
  fixtures/            # versioned golden data (documents, queries, labels, prompts)
                       #   — committed, small, deterministic
```

Supporting changes:

- **`electron/repository.cjs`** — schema v3: `benchmarks` table
  (`id, ts, preset, phase, app_version, hw_profile, model, engine, tier,
   settings_json, metrics_json, duration_ms, error`) + `listBenchmarks()` /
  `exportBenchmarks()` / retention pruning. Follows existing migration +
  backup-before-migrate rules exactly.
- **`shared/channels.json`** — new channels: `bench:run`, `bench:abort`,
  `bench:list`, `bench:compare`, `bench:export`, `events:benchProgress`.
- **`electron/ipc.cjs`** — thin handlers delegating to `benchRunner`; no logic in
  handlers (keeps the tested-surface rule).
- **`src/components/BenchmarkPanel.jsx`** — the §4.1 UI; `StatusPill` gains live
  tier from a new `getStatus()` field (provider already computes `plan.tier`).
- **`electron/llama/llamaCppProvider.cjs`** — add an **instrumented generate path**:
  expose per-call timings (first-chunk offset, token counts, tier) via a callback/
  event. This is also a product feature — the UI can then show "12.4 tok/s · GPU"
  under each answer. `node-llama-cpp` already reports prompt-eval and generation
  timings in `session.prompt()`'s result; we currently discard them — that's the
  single highest-value, lowest-effort change in this whole plan.
- **Tests** — `test/bench.test.cjs`: metric math (P50/P95, recall@k, MRR, nDCG,
  groundedness aggregation) with fixed inputs; fixture validity (labels reference
  real chunk IDs); report serialization round-trip. Deterministic, offline, no
  model needed — the *math* is tested; the *runs* are UI-launched.

### 5.2 Determinism rules (so numbers are defensible)

- Fixed prompts, fixed seeds (node-llama-cpp `seed` option), temperature 0 for
  judge + graded generations where supported, warm-up run excluded from stats,
  N≥5 samples per metric (P50/P95, not averages), clock via `performance.now()`.
- Hardware noise is real on laptops: record thermal/frequency context when cheap to
  get (Windows: `nvidia-smi --query-gpu` if present) and always show the tier.
- Fixtures are versioned in-repo; the fixture version is part of the context block.
  Bumping a fixture bumps the "score comparability" line — old runs stay, but are
  tagged non-comparable.

### 5.3 Guardrails (benchmarks must never hurt the product)

- Serialized with chat (single engine lock); UI states "benchmarks running".
- Hard caps: max tokens per generation, wall-clock budget per phase, VRAM headroom
  check before starting (reuse `_vramGB()` + honest tier planning).
- Abort at every phase boundary and mid-stream (existing `signal` plumbing).
- Privacy audit phase is passive socket observation only — no network initiation.
- All results stored locally; exports are user-initiated.

### 5.4 Phasing & effort order

| Phase | Scope | Delivers |
|---|---|---|
| **1** | `benchEngine.cjs` + instrumented provider generate + `benchmarks` table + run/list IPC + minimal panel with Quick preset | *The headline numbers reviewers quote, visible and exported.* Smallest end-to-end slice. |
| **2** | `benchRetrieval.cjs` + fixtures + Compare/Export + Standard preset | RAG quality proven with recall@k/MRR/nDCG + hybrid lift. |
| **3** | `benchGrounding.cjs` + `benchMemory.cjs` + in-chat groundedness roll-up | Trust metrics (refusal honesty, fact recall) — Sidekick's differentiators, quantified. |
| **4** | `benchStability.cjs` + Full preset + audit-log integration + target bands | Soak, abort cost, DB scale, privacy audit; complete "Full" report. |
| **5** | CI smoke (engine + retrieval math only, tiny model, headless) + threshold alerts | Regression guard: a future engine change that costs 20% tok/s fails CI. |

### 5.5 What success looks like

- A skeptical reviewer can, in under 10 minutes on their machine, produce a
  self-describing Markdown report: tok/s, TTFT, recall@5, groundedness %, refusal
  honesty, tier achieved, with the exact hardware/model/versions used — and re-run
  it to confirm.
- Every "interesting" claim in §1 has a number attached, a target band, and a
  source for its reference value.
- A regression in any headline metric is visible in the UI history *and* in CI
  before release.
