# Sidekick LLM — Debugging Report: Persona & Grounding Disconnect

**Date:** 2026-09-20  
**Status:** ✅ RESOLVED — Fixed in Phase 0 of the market-readiness checklist.  
**Fixes applied:** `electron/ipc.cjs`, `electron/contextBuilder.cjs`, `electron/llama/llamaCppProvider.cjs`, `electron/llama/nativeWorkerProvider.cjs`, `electron/llmProvider.cjs`, `electron/ollama.cjs`, `src/components/ChatView.jsx`, `src/components/SpecialistGallery.jsx`, `src/components/SettingsModal.jsx`

---

## TL;DR — The Verdict (RESOLVED)

There were **two separate bugs**. Both are now fixed.

| # | Bug | What it looked like | Status |
|---|-----|--------------------|--------|
| **1** | **Embedding model not available to the active engine** → retrieval silently returned zero results | "No matching vault knowledge" badge; model answered from weights only; no citations | ✅ FIXED — preflight + ungated keyword search + structured errors |
| **2** | Llama 3.1's Jinja template fails node-llama-cpp's sanity test | Scary red terminal error about `JinjaTemplateChatWrapper` | ✅ NOT APPLICABLE — current code uses `LlamaChatSession` directly; no Jinja wrapper in the chat path |

---

## Root Cause (now fixed)

The configured embedding model (`nomic-embed-text` / `nomic-embed-text-v1.5`) did not resolve to a usable local GGUF for the built-in engine. Every `generateEmbedding()` call silently returned `null` (swallowed in `try/catch`), and because keyword search was **inside** the embeddings loop, **both** vector and keyword retrieval were skipped. The model was told to answer "from expertise only" with no retrieved knowledge — no citations, no source cards, persona diluted.

## Fixes Applied

1. **`electron/ipc.cjs`** — Added `ollama.checkEmbedding()` preflight to `chat:sendMessageStream`. When the embedder is unavailable, a structured `groundingDisabled` reason is attached to the turn instead of silently failing.

2. **`electron/contextBuilder.cjs`** — Switched to `generateEmbeddingDetailed()` which returns `{ vector, error }`. Keyword (BM25) search was moved **outside** the embeddings loop so it runs even when embedding fails (keyword-only degradation). The `groundingDisabled` reason is surfaced in `specialistGrounding`.

3. **`electron/llama/llamaCppProvider.cjs`** — Added `generateEmbeddingDetailed()` returning `{ vector, error }`. Existing `generateEmbedding()` kept backward-compatible (returns `vector \| null`).

4. **`electron/llama/nativeWorkerProvider.cjs`** — Added `generateEmbeddingDetailed()` delegate (worker + test-fallback paths).

5. **`electron/llmProvider.cjs`** — Facade routes `generateEmbeddingDetailed()` to the active engine.

6. **`electron/ollama.cjs`** — Added `generateEmbeddingDetailed()` returning `{ vector, error }` with actionable reasons.

7. **`src/components/ChatView.jsx`** — `GroundingBadge` now renders the `groundingDisabled` reason banner when present.

8. **`src/components/SpecialistGallery.jsx`** — Shows both `retrievableChunkCount` and `chunkCount` per Expert, with a stale-chunk hint and re-index CTA when they diverge.

9. **`src/components/SettingsModal.jsx`** — Embedding-model availability guard: warns when the configured embedding model isn't installed, offers a one-click download, and prompts for re-index when the model changes.

10. **`src/styles.css`** — Added `.vault-stale-hint` styling.

11. **`test/context_builder.test.cjs`** — Test stub updated to provide `generateEmbeddingDetailed`.

## Verification

- All 115 tests pass (54 Node + 54 Electron + context_builder suite) — no regressions.
- The chat path now fails loudly with an actionable banner instead of silently returning zero results.
- Keyword-only retrieval works when the embedding model is unavailable.
- Vault chunk counts are honest (retrievable vs. total).

---


## What I Found (evidence)

### The active configuration (from the app's database, `sidekick.db`)
```
activeModel        = Llama-3.1-8B-Instruct-Q4_K_M      <- built-in node-llama-cpp engine
embeddingModel     = nomic-embed-text                   <- an Ollama model name
activeSpecialistIds = [ Kevin Flynn (33776dd6-...) ]
```

### The models actually on disk (`%APPDATA%/sidekick-llm/models/`)
```
Llama-3.1-8B-Instruct-Q4_K_M.gguf     (complete)
Qwen2.5-3B-Instruct-Q4_K_M.gguf       (complete)
Qwen2.5-7B-Instruct-Q4_K_M.gguf       (complete)
Qwen2.5-14B-Instruct-Q4_K_M.gguf.part (INCOMPLETE download)
```
**There is no `nomic-embed-text` (or any) embedding GGUF on disk.**

### The vault is NOT empty
Kevin Flynn's hub has **15 indexed chunks** (Wikipedia, Harvard physics, etc.), all embedded with `nomic-embed-text`, 768-dim. So "no matching knowledge" is **not** because the vault is empty — it's because the query can't be embedded.

### I reproduced the Jinja error and proved the fix (see `testjinja.cjs`)
```
TEST 1 (default):          FAILS — "Expected iterable or object type in for loop: got UndefinedValue"
TEST 2 (tools: null):      OK — sanity test passed; supportsSystemMessages = true
```
With the fix, the model's **own** template renders a correct Llama 3.1 system/user prompt. So the chat path works fine once the template is satisfied.

---

## Bug 1 (THE real bug) — Embedding model unavailable → retrieval silently returns nothing

### The causal chain

1. You are on the **built-in** engine (no `llmProvider=ollama` override). The chat model is the local `Llama-3.1-8B` GGUF.
2. Settings still say `embeddingModel = nomic-embed-text`. That is an **Ollama** model name. It was valid when you first built the vault (you were on Ollama), but it does **not** resolve to any local `.gguf` file.
   - Note the mismatch is even in the *name*: the built-in gallery's embedding entry is `nomic-embed-text-v1.5` (file `nomic-embed-text-v1.5.Q8_0.gguf`, marked `required: true`), **not** `nomic-embed-text`. And that GGUF is **not downloaded**.
3. On every chat turn, `buildChatContext` tries to embed the query:
   - `electron/contextBuilder.cjs:138` → `ollama.generateEmbedding({ model: 'nomic-embed-text', ... })`
   - `electron/llama/llamaCppProvider.cjs:374` `generateEmbedding()` → `_entryFor('nomic-embed-text')` → `resolveModelPath()` finds no file → throws → the `catch` at `:385` **swallows the error and returns `null`**.
4. Back in `buildChatContext`, a `null` embedding is simply skipped:
   - `electron/contextBuilder.cjs:139` → `if (emb && emb.length > 0) embeddings.push(...)` → **the `embeddings` array ends up empty.**
5. **Here is the structural flaw:** the keyword (BM25) search is *inside* the loop over embeddings:
   ```js
   // contextBuilder.cjs:153-158
   for (const { query, embedding } of embeddings) {   // ← empty, so this never runs
     const vectorMatches  = repository.searchSpecialistVectorMemory(...) || [];
     const keywordMatches = repository.searchSpecialistKeyword(hub.id, query, 8) || [];  // ← also never runs
     perQuery.push(fuseHybrid(vectorMatches, keywordMatches, 8));
   }
   ```
   Because `embeddings` is empty, **both** vector search **and** keyword search are skipped. Retrieval yields **zero** matches for every expert.
6. So `topChunks.length === 0` → `grounded: false` (`contextBuilder.cjs:227`) → the prompt tells the model *"No matching knowledge was found ... answer from expertise only, and say so"* (`contextBuilder.cjs:195`) → the UI renders the ungrounded badge.

**Net effect:** the badge is *technically accurate* — the pipeline genuinely found nothing — but the reason is an engine/model mismatch that silently zeroed out **all** retrieval (vault search, memory RAG, expert suggestions), with no error shown anywhere.

> The ingest / notes / reindex paths all call `checkEmbedding()` up front and fail loudly (`electron/ipc.cjs:493,663,690,732,819`). The **chat path does not** — that's why this fails silently exactly where it hurts.

---

## Bug 2 (red herring) — Llama 3.1 Jinja template fails the sanity test

### What happens
- node-llama-cpp reads `tokenizer.chat_template` out of the GGUF and tries to build a `JinjaTemplateChatWrapper`, running a "sanity test" render.
- Llama 3.1's template contains:
  ```jinja
  {%- if tools_in_user_message and not tools is none %}
      ...
      {%- for t in tools %}   {# ← `tools` is Undefined here, so this throws #}
  ```
  When `tools` is **undefined** (not `None`), `not tools is none` evaluates true, the block runs, and `for t in tools` throws `Expected iterable or object type in for loop: got UndefinedValue`. **That is your terminal error, reproduced exactly.**
- node-llama-cpp then **falls back** to its built-in `Llama3_1ChatWrapper`, which supports system messages. Chat still works — the persona prompt still goes through.

### Why it's not your problem
- The fallback wrapper is functionally correct for Llama 3.1 (`supportsSystemMessages = true`).
- The persona lives in the **system message**, which `LlamaChatSession` delivers via `setChatHistory()` regardless of which wrapper wins. So the model *does* receive "You are operating as the AI Specialist 'Kevin Flynn'."
- It's a **log-level** issue (it even prints at `console.error`, which is why it looks fatal). It costs you nothing functionally, but it buries the real signal.

### The clean fix (optional but recommended)
Pass the undefined tool variables as `null` so the model's own template passes its sanity test and you stop seeing the error. I verified this works:
```js
new JinjaTemplateChatWrapper({
  tokenizer: model.tokenizer,
  template,
  additionalRenderParameters: { tools: null, custom_tools: null, builtin_tools: null },
});
```
You can supply this via `customWrapperSettings.jinjaTemplate` when loading the model, or lower the engine log level. Either way, **this is cosmetic** — do not chase it as the cause of your grounding loss.

---

## Why the Persona AND the Grounding Disconnect Together

They share **one** root cause (Bug 1) plus a secondary factor:

1. **Grounding is gone** because retrieval is dead (Bug 1). The model has no Kevin Flynn vault text in front of it, and the prompt explicitly tells it to answer "from expertise only."
2. **Persona is diluted** because, with no retrieved knowledge anchoring the voice, you're left with an **8B model** asked to hold a short, casual persona instruction ("No rules. No limits. ... staring into the abyss.") against a busy system prompt (Sidekick base instructions + user profile + "Concise & Direct" tone + global instructions). Small models under-weight a one-line persona when nothing else reinforces it. It answered as a generic "Senior AI Engineer" — classic persona drift.

So: **fix the embeddings and grounding returns; grounding, in turn, is what makes the persona stick.** A 14B/7B model will hold the persona noticeably better than the 8B for these open-ended, "brainstorm with me" prompts.

---

## What Is Needed So Downloaded Models "Play Along" and Ground Their Answers

### A. Make the embedding model actually available to the active engine (fixes grounding)
Pick **one** consistent engine for *both* chat and embeddings, and make sure the embedding model exists there:

- **Option 1 — stay built-in (recommended for a portable, no-server app):**
  1. In Settings → Local Model & Engine, download the gallery's required embedding model **`nomic-embed-text-v1.5`** (`nomic-embed-text-v1.5.Q8_0.gguf`, ~0.62 GB).
  2. Set `embeddingModel = nomic-embed-text-v1.5` (the **catalog id**, not the Ollama name).
  3. **Re-index every Expert vault** (Settings → reindex / re-ingest). This is mandatory — see invariant below.

- **Option 2 — use Ollama for everything:**
  1. Set the engine to Ollama and ensure `ollama pull nomic-embed-text` is present.
  2. Keep `embeddingModel = nomic-embed-text`.
  3. **Re-index** if you had previously embedded on the built-in engine.

> **Invariant #4 / #5 (critical):** a chunk's vector only means something compared against a query vector from the **same** embedding model. `searchSpecialistVectorMemory` filters by matching dimension **and** model (`electron/repository.cjs:2023`). Your current vault is `nomic-embed-text @ 768`. If you switch to a different embedding model, the old vectors are in a different space and will **not** match — you **must** re-ingest. There is no way around re-indexing when the embedding model changes.

### B. Make the chat path fail loudly / degrade gracefully (prevents silent "no knowledge")
- Add the same `checkEmbedding()` preflight the ingest path uses, at the top of the chat turn. If it fails, surface a clear, actionable banner: *"Embedding model `nomic-embed-text` isn't available in the built-in engine — download it or switch engines. Grounding is disabled for this turn."*
- **Ungate keyword search from embedding success.** Even with no embedding model, BM25/FTS (`searchSpecialistKeyword`) should still run on the raw query. That turns "zero results" into "keyword-only results" — far better than nothing, and it would have partially grounded Kevin Flynn today.

### C. Quiet the Jinja red herring (optional polish)
- Provide `customWrapperSettings.jinjaTemplate.additionalRenderParameters = { tools: null, custom_tools: null, builtin_tools: null }` (verified to make Llama 3.1's template pass), or set the engine log level to `warn`. Either removes the scary stack trace so it can't mask real errors again.

### D. Pick a model that can hold the persona
- For "brainstorm with a specialist" style prompts, use **Qwen2.5-7B/14B** (finish that 14B `.part` download, or download fresh) rather than the 8B. Larger, instruction-following-strong models keep the persona and the "cite the vault" directive far more reliably. Keep an 8B-class model for background/summarization work.

---

## Recommended concrete code changes (if you want me to implement them)

1. **`electron/contextBuilder.cjs`** — run `repository.searchSpecialistKeyword(hub.id, q, 8)` for each planned query *outside* the `for (… of embeddings)` loop, so keyword retrieval works even when embeddings are unavailable; merge with vector results when those exist.
2. **`electron/ipc.cjs` (chat handler)** — call `ollama.checkEmbedding(embeddingModel)` before `buildChatContext`; if `!ok`, attach the reason to the turn and render a distinct "grounding disabled (reason)" state in the UI instead of the generic ungrounded badge.
3. **`electron/llama/llamaCppProvider.cjs`** — when building the chat wrapper, pass `additionalRenderParameters: { tools: null, custom_tools: null, builtin_tools: null }` so models with tool-conditional Jinja templates (Llama 3.1/3.2) resolve cleanly; optionally drop `logLevel` to `warn`.
4. **Settings/Models UI** — when the active engine is built-in and `embeddingModel` isn't one of the on-disk GGUFs, show an explicit warning and a one-click "download the required embedding model" action (it's already flagged `required: true` in `shared/ggufCatalog.json`).

---

## Bottom line

- **Your persona/grounding disconnect is caused by Bug 1:** the embedding model in your settings (`nomic-embed-text`) doesn't exist for the built-in engine, so every embedding call silently returns `null`, the retrieval loop is skipped entirely (keyword search included), and the model is told to answer "from expertise only."
- **The terminal Jinja error (Bug 2) is cosmetic** — a known Llama 3.1 template quirk that node-llama-cpp recovers from automatically.
- **To make downloaded models ground their answers:** give the active engine a real, matching embedding model (download `nomic-embed-text-v1.5` for built-in, or run Ollama with `nomic-embed-text`), **re-index the vault** after any embedding-model change, and (best) make the chat path warn loudly + fall back to keyword search so this can never fail silently again.
