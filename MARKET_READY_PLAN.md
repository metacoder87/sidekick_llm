# 🚀 Sidekick LLM: Market-Readiness Master Plan (Road to First 100 Users)

## 🎯 Vision & Target Markets
Sidekick is not a chatbot; it is a **Sovereign Knowledge Brain**. The goal is to provide an air-gapped, verifiable intelligence system where the user owns the corpus.
*   **Academic/Student Market:** Deep research tools, source-rooted synthesis, and citation rigor for theses and papers.
*   **Legal Market:** High-security access to case law, internal documents, and journals with 100% grounding (no hallucinations) and strict access controls.

---

## 🚨 Phase 0: Critical Retrieval & Grounding (Must Fix Before Launch)
*The app's core value prop — cited, grounded answers from local Expert vaults — is currently broken. These are P0 blockers. No market launch until every item is green.*

### 0.1 Fix Silent Retrieval Failure (Root Cause of "0 Saved Chunks" & No Citations)
- [x] **Embedding preflight on chat path:** Call `ollama.checkEmbedding(embeddingModel)` before `buildChatContext` in `chat:sendMessageStream` (`electron/ipc.cjs`). Surface an actionable "grounding disabled" banner when it fails (mirror the preflight already used by ingest/research/notes).
- [x] **Ungate keyword search:** Move `repository.searchSpecialistKeyword()` outside the `for (… of embeddings)` loop in `electron/contextBuilder.cjs` so BM25 still returns results when the embedding model is unavailable.
- [x] **Structured embedding errors:** Added `generateEmbeddingDetailed()` returning `{ vector, error }` across all layers (`llamaCppProvider.cjs`, `nativeWorkerProvider.cjs`, `llmProvider.cjs`, `ollama.cjs`). Existing `generateEmbedding()` kept backward-compatible.
- [x] **Quiet the Llama 3.1 Jinja error:** N/A — current chat path uses `LlamaChatSession` directly, not `JinjaTemplateChatWrapper`. No Jinja wrapper exists in the codebase.

### 0.2 Make Vault Chunk Counts Honest
- [x] **Show retrievable vs. total count:** Specialist Gallery (`SpecialistGallery.jsx`) renders both `chunkCount` and `retrievableChunkCount` with a stale-chunk hint + re-index CTA. `SpecialistPickerModal` and `SpecialistModal` already showed this.
- [x] **Auto re-index on embedding-model change:** SettingsModal prompts for re-index when the embedding model changes (`previousEmbeddingModel` tracking). Backend `specialist.reindexAll` endpoint added (`electron/ipc.cjs`, `electron/preload.cjs`, `shared/channels.json`) for bulk re-indexing all Expert vaults.
- [x] **Settings embedding-model guard:** SettingsModal shows a prominent warning when the configured embedding model isn't installed, with one-click download CTA and re-index-all button on change (`SettingsModal.jsx`).

### 0.3 Hardening & Error Visibility
- [x] **Replace silent `catch` blocks:** Specialist Gallery load failure now logs a warning (`SpecialistGallery.jsx`); background memory task failures are logged instead of swallowed (`electron/ipc.cjs`).
- [x] **Test the chat path:** Added 2 new tests to `context_builder.test.cjs` covering the grounding-disabled preflight path and keyword-only degradation when the embedding model fails at runtime.

**🧪 Testing Phase 0:**
- [x] Existing test suite: 117/117 pass (54 Node + 63 Electron), no regressions.
- [x] Regression test: Ask a question with a populated Expert vault → verify grounded answer + source cards render (covered by existing `context_builder` tests).
- [x] Regression test: Remove/disable the embedding model → verify graceful keyword-only degradation + actionable banner (`context_builder.test.cjs`).
- [x] Re-index test: Change `embeddingModel`, verify chunks go from `retrievableChunkCount = 0` back to full after re-index (covered by existing `repository.test.cjs` `reindexHub` test).

---

## 🛠 Phase 1: Security & Data Sovereignty (Highest Value)
*Law firms and academics will not use the product if data is unencrypted or leaks via the browser.*

### 1.1 The "Air-Gap" Lockdown
- [ ] **Link Isolation:** Implement `setWindowOpenHandler` in `main.cjs`. All external links must open in the system default browser; no remote page should have access to the Electron preload bridge.
- [ ] **Preload Bridge Audit:** Remove any functions from `preload.cjs` that allow bulk data export or sensitive setting changes without explicit user confirmation/authentication.

### 1.2 Encryption & Secret Management
- [ ] **Encryption at Rest:** Implement AES-256 encryption for the SQLite database (using `sqlcipher` or application-level column encryption). Focus on `user_memories` and `specialist_chunks`.
- [ ] **OS Keychain Integration:** Migrate all API keys and DB passwords from the `settings` table to Electron's `safeStorage` (OS Native Keychain).

### 1.3 Privacy Guardrails
- [ ] **Local-Only Enforcement:** Implement a strict CSP (Content Security Policy) that blocks all non-localhost network requests except for explicit, user-triggered web searches.

**🧪 Testing Phase 1:**
- Penetration test: Attempt to call `settings.get()` from an opened external link.
- Data Leak test: Verify `.db` files are unreadable by standard SQLite viewers without the key.

---

## 🧠 Phase 2: Standalone Intelligence (`node-llama-cpp`)
*Removing Ollama as a dependency is critical for "one-click" install CX.*

### 2.1 The Engine Swap
- [ ] **Provider Abstraction:** Create an `LLMProvider` interface to swap between `OllamaProvider` and `LlamaCppProvider`.
- [ ] **Native Integration:** Implement `node-llama-cpp` bindings for local inference.

### 2.2 Model Curation & CX (HuggingFace)
- [ ] **Recommended GGUF Suite:** Build a curated "Model Gallery" within the app recommending:
    *   **Reasoning (General):** Llama-3.1-8B or Mistral-7B v0.3 (Q4_K_M quantization).
    *   **Academic/Coding:** Qwen2.5-7B or DeepSeek-Coder-V2.
    *   **Embeddings:** `nomic-embed-text` (pinned for dimensional consistency).
- [ ] **Smart Downloader:** Implement a built-in downloader to fetch these models directly from HuggingFace.

### 2.3 Hardware Optimization & VRAM Offloading
- [ ] **Dynamic VRAM Allocation:** Implement logic to detect available GPU VRAM and automatically set `n_gpu_layers`.
    *   *High VRAM (12GB+):* Full offload for 7B/8B models.
    *   *Medium VRAM (6-8GB):* Partial offload + system RAM fallback.
    *   *Low VRAM (<4GB):* CPU-only mode with optimized threading (`n_threads`).

**🧪 Testing Phase 2:**
- Performance benchmarks on Low/Mid/High spec machines.
- Model swap test: Ensure changing a model doesn't corrupt the embedding index.

---

## 🗣 Phase 3: The "Agentic Debate" (The Differentiator)
*Moving from "repetitive agreement" to a structured, synthetic debate.*

### 3.1 Architectural Shift: Roundtable $\to$ Debate
- [ ] **Conversation Pipeline Redesign:** Replace the parallel prompt with a sequential chain:
    1.  **The Thesis (Expert A):** Formulates an initial answer based on their vault.
    2.  **The Critique (Expert B):** Analyzes Expert A's response, adding counterpoints or nuances from their own vault.
    3.  **The Synthesis (Expert C/Additional):** Weighs the conflict between A and B and attempts to reconcile the facts.
    4.  **The Moderator (Final Pass):** Summarizes the debate, identifies points of consensus vs. disagreement, and provides a final rooted verdict.

### 3.2 Prompt Engineering for Friction
- [ ] **Conflict Injection:** Update Expert personas to be "critically analytical" rather than "agreeable." Instruct them specifically to look for omissions or contradictions in previous turns.
- [ ] **Moderator Persona:** Build a high-authority Moderator persona focused on logic, citation weight (Gold vs. Bronze), and synthesis.

**🧪 Testing Phase 3:**
- Contrast Test: Compare "Roundtable" outputs with "Debate" outputs to ensure significantly higher analytical depth.

---

## 🛠 Phase 4: Industrialization & Quality Assurance
*Ensuring the app is bug-free, linted, and stable for professional use.*

### 4.1 Zero-Regression Testing Suite
- [ ] **Unit Tests:** Expand `test/` suite to cover every edge case in `repository.cjs` and `memoryManager.cjs`.
- [ ] **Integration Tests:** Build E2E tests for the "Ingest $\to$ Embed $\to$ Retrieve" pipeline using Vitest or Playwright.
- [ ] **Regression Guard:** Implement a pre-commit hook that prevents merging if any existing test fails.

### 4.2 Code Health & Security Scan
- [ ] **Linting/Formatting:** Enforce strict ESLint and Prettier rules across the entire project.
- [ ] **Deprecation Audit:** Search for and replace all deprecated Node.js or Electron APIs.
- [ ] **Security Audit:** Run `npm audit` and use static analysis tools to find potential memory leaks in native bindings.

**🧪 Testing Phase 4:**
- Full suite run: 100% pass rate on all unit/integration tests.
- Memory leak test: Long-running chat sessions with large vaults to ensure no RAM bloat.
- [ ] **Grounding evaluation harness:** Golden-question set per Expert persona; measure grounding rate, citation precision, and persona adherence in CI.
- [ ] **Citation verification test:** Confirm every rendered citation/source card maps back to an actual retrieved chunk (never parsed from model prose).


---

## 🏢 Phase 5: Enterprise Readiness & Market Entry
*Final steps for professional deployment and scaling to the first 100 users.*

### 5.1 Role-Based Access Control (RBAC)
- [ ] **User Identity Layer:** Implement a local user profile system with roles: `Admin`, `Editor`, `Viewer`.
- [ ] **Vault Permissions:**
    *   `Admin`: Full access to all Experts and Vaults.
    *   `Editor`: Can add documents to specific Vaults but cannot delete them.
    *   `Viewer`: Read-only access to chat with existing Experts (cannot see raw source files).

### 5.2 Trust & Verification Differentiators (Industry Leadership)
*These move Sidekick from "another local chatbot" to a trusted, cited knowledge system.*

- [ ] **Inline citations:** Highlight which sentences are grounded in which retrieved chunk, with hover previews and source attribution.
- [ ] **Grounding verification:** Post-generation check that claims map back to retrieved chunks; flag answers asserting something absent from sources. Offer an "Answer from sources only / refuse when ungrounded" mode.
- [ ] **Conversation-level source bibliography:** Consolidated reference list per thread.
- [ ] **Expert vault health dashboard:** Per-Expert view — chunk count, retrievable count, sources, last indexed, stale-vector warning, one-click re-index, "train from this conversation."
- [ ] **Auto-download required embedding model:** First-run / missing-model flow with progress bar and a clear "retrieval is offline until this completes" state.
- [ ] **Global cross-vault reranker:** Re-rank top-k across all consulted vaults (not per-vault) so a small specialist's strong match isn't drowned by a large panel's weak ones.
- [ ] **Expert pack marketplace:** Import/export of portable Expert packs (persona + vault + notes), opt-in community directory.

### 5.3 The Path to First 100 Users
- [ ] **Professional Packaging:** Signed installers (.exe/.dmg) and an auto-update mechanism via `electron-updater`.
- [ ] **Onboarding Flow:** A "First Run" wizard for academics/lawyers (Model setup $\to$ Vault creation $\to$ First expert).
- [ ] **Beta Program:** Recruit 10 students and 5 law associates for a closed beta to refine the UX.

**🧪 Testing Phase 5:**
- RBAC test: Ensure `Viewer` cannot access Admin settings or edit vaults.
- Installation test: Fresh install on clean OS environments.

---

## ❓ Open Questions for User
*Please provide answers to these to further refine the implementation details:*

1. **RBAC Scope:** For law firms, do you imagine a central "Firm Server" that syncs vaults, or is this entirely separate installs where an Admin manually sets up the machine?
2. **Target Hardware:** Should we prioritize optimization for laptops (lower RAM) or high-end workstations common in legal offices?
3. **Payment Model:** For the first 100 users, are you looking at a one-time license per seat or a subscription model? This affects how I implement the License Activation logic.
4. **Model Preference:** Are there specific "Legal" or "Academic" models you've heard of that you want integrated into the lauch gallery?

---

## ✅ Progress Tracker
*(Check off as we complete items)*
- [x] Phase 0: Critical Retrieval & Grounding (P0 blockers — all complete)
- [ ] Phase 1: Security & Data Sovereignty
- [ ] Phase 2: Standalone Intelligence (`node-llama-cpp`)
- [ ] Phase 3: The "Agentic Debate"
- [ ] Phase 4: Industrialization & QA
- [ ] Phase 5: Enterprise Readiness (RBAC + Trust & Verification Differentiators)
