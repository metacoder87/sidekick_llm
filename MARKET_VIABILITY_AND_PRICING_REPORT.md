# Sidekick LLM — Market Viability, Readiness & Pricing Report

**Prepared:** November 2026
**App version:** 0.1.0
**Status:** Pre-commercial (Stage 5 in progress — builds work, not yet signed, license + legal are draft)

---

## 1. Executive Summary

**Sidekick LLM** is a privacy-first, offline-capable desktop knowledge system for local LLMs. Its durable artifact is the **user-owned corpus** — persistent conversations, compounding personal memory, and domain-specific "AI Experts" (NotebookLM-style vaults trained on the user's own PDFs and web research). The LLM is a swappable lens onto knowledge the user owns; the corpus is the product.

### Bottom line up front

| Dimension | Assessment | Readiness for revenue |
|---|---|---|
| Product differentiation | **Strong** — compounding Experts + verifiable citations + roundtable deliberation is a defensible wedge in a crowded local-LLM field | ✅ Differentiation exists |
| Technical maturity | **High** — Stages 1, 2, 2.5, 4 complete; core features verified live | ⚠️ Stage 3 (growth safety) not started |
| Commercial infrastructure | **Partial** — licensing service built, Lemon Squeezy integration referenced at $39/yr, but unsigned installer, draft EULA, no publish target | ❌ Not shippable to public |
| Legal / compliance | **Draft** — EULA, privacy policy, disclaimer all marked "requires lawyer review" | ❌ Blocks public release |
| Market timing | **Favorable** — privacy/local-AI demand rising; NotebookLM proved the RAG-notebook model | ✅ Window is open |

**Recommendation:** Do not monetize yet. Complete Stage 5 (signing, legal review, publish target, payment/tax infrastructure) before selling. Target **M3 — Commercial v1** as defined in ROADMAP §4c. A one-time license or paid major-version upgrade fits this server-less product far better than a subscription; the current UI's $39/yr Lemon Squeezy subscription will face user skepticism ("what am I paying monthly for if it runs on my machine?").

---

## 2. Product Overview

### What Sidekick actually is (vs. what it is not)

| Is | Is not |
|---|---|
| A personal knowledge system with a conversational interface | A local ChatGPT clone |
| A corpus that grows more valuable over time (month 12 >> month 1) | A stateless chat wrapper |
| AI Experts — private vector vaults scoped to a topic, grounded in user documents + curated web research | A general-purpose chatbot |
| Verifiable: every grounded claim cites an exact source chunk; unsourced model statements are marked | A black-box answer engine |
| Offline-first, zero network surface except user-initiated search/model download | A SaaS with cloud inference |
| Model-agnostic: user chooses reasoning model; embedding model pinned for dimensional consistency | Locked to one model/provider |

### Core capabilities (as built)

- **Built-in local inference** via `node-llama-cpp` (GGUF, in-process, no listening port, no Ollama required; Ollama optional)
- **AI Experts / Specialist Hubs** — persona + private vector vault, built via PDF/text ingestion or Web Deep Research
- **Federated multi-Expert panel** — query across selected vaults, personas combined, grounding tracked per Expert
- **Roundtable deliberation** (Stage 2.5) — N rounds of Expert-by-Expert turn-taking with moderator synthesis
- **Compounding memory** — fact extraction, canonical-form dedup, relevance-ranked recall, supersession on contradiction, rolling summary
- **Web search grounding** — DuckDuckGo/SearXNG/Tavily/Brave with fallback chain, inline citation cards
- **Encryption at rest** (opt-in, AES-256 via `better-sqlite3-multiple-ciphers`), app lock, auto-lock on idle, hash-chained audit log
- **Corpus export/import** — full portable corpus including embeddings
- **Expert Library** — 22 curated recipe templates across Coding, Business, Law, Medicine, Finance, Research, Writing, Lifestyle

### Technical stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 41 (context isolation on, sandboxed preload IPC) |
| Frontend | React 18 + Vite 8 |
| Persistence | SQLite via `better-sqlite3` (WAL, FTS5, cosine vector search) |
| Inference | `node-llama-cpp` / embedded `llama.cpp` in private utility process |
| Documents | `pdf-parse` v2; native-fetch scraper |
| Packaging | electron-builder (NSIS / dmg / AppImage), ~114 MB Windows installer |
| License | `licenseService.cjs` — signed offline license files, machine-bound, 30-day offline grace, Lemon Squeezy activation |

### System requirements (published up front — a smart trust-building move)

| | Minimum | Comfortable | Larger models |
|---|---|---|---|
| RAM | 8 GB | 16 GB | 32–48 GB |
| Disk | ~3 GB | ~8 GB | 25 GB+ |
| OS | Windows 10+, macOS 12+, Linux |

---

## 3. Market Viability Analysis

### 3.1 Target markets (from MARKET_READY_PLAN.md & ROADMAP)

**Primary — Individual knowledge workers (prosumers):**
- Researchers & academics (literature reviews, thesis material, citation discipline)
- Legal professionals (contract analysis, case law, jurisdiction-specific research) — **high-value but high-liability**
- Medical / healthcare (literature analysis, understanding records, prep for doctor visits) — **high-value, high-liability**
- Developers & technical writers (language-specific Experts, docs QA)
- Business analysts & strategists (market research, financial modeling, grant writing)

**Secondary — Small teams / "Expert packs" buyers (Stage 7):**
- Law firms wanting shared contract-analysis Experts
- Clinics wanting shared medical-literature Experts
- Consultancies wanting packaged industry Expert teams

**Deliberately NOT targeted (for now):** Enterprise multi-tenant / server deployment (Stage 6 deferred — correct call; it's a different product).

### 3.2 TAM / SAM / SOM (estimates, directional)

| Segment | TAM (global) | SAM (reachable, privacy-sensitive) | SOM (year 1–2, realistic capture) |
|---|---|---|---|
| Individual knowledge workers using local/LLM desktop tools | ~$2–4 B (local AI desktop tools + personal knowledge mgmt) | ~$300–500 M (privacy-first, offline-capable subset) | ~$1–3 M ARR |
| Legal / medical prosumers (high-stakes, citation-driven) | Large but fragmented | ~$100–200 M | ~$300–800 K ARR |
| Expert pack / template marketplace (Stage 7) | Emerging | ~$50–100 M | ~$100–300 K ARR |

*Note: These are rough directional estimates for a solo/small team. The local-LLM desktop tools market (LM Studio, Jan, GPT4All, AnythingLLM, Msty, Open WebUI) is growing but commoditized at the "chat with a model" layer. Sidekick's defensible wedge is at the corpus+knowledge layer.*

### 3.3 Competitive landscape

| Competitor | Model | Strengths | Weaknesses vs. Sidekick |
|---|---|---|---|
| **LM Studio** | Free, local model runner | Great model discovery/management, polished UI | No persistent corpus, no RAG vaults, no compounding memory, no Expert panels |
| **Jan** | Free/open, local + cloud | Cross-platform, model hub, agent features | Cloud-leaning, no compounding personal corpus, no verifiable citations |
| **GPT4All** | Free, local | Simple, broad model support | Basic chat, no Expert/vault system, no compounding memory |
| **AnythingLLM** | Freemium, local + cloud | Workspaces, document citations, multi-user | Cloud tilt, less privacy-pure, pricing unclear |
| **Msty** | Freemium, local + cloud | Polished, model comparison | Not corpus-first, no compounding memory |
| **Open WebUI** | Free, self-hosted | Feature-rich, community | Server model, not desktop-first, no offline corpus ownership |
| **NotebookLM** | Free (Google), cloud | Source-grounded notebooks, excellent UX | **Data leaves device**, Google account required, no local model choice, no offline |

**Sidekick's defensible wedge:** *Compounding Experts + verifiable citations + deliberation + total data sovereignty.* NotebookLM proved users want grounded notebooks — but it's cloud-based and you don't own the corpus. Sidekick owns the "local, private, yours forever" position credibly.

### 3.4 Key risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Hardware barrier** — local LLMs need 16GB+ RAM, multi-GB downloads | High | Publish requirements up front (already done in README); fit-to-machine recommendations; small background model + larger chat model routing |
| **Legal/medical liability** — marketing high-stakes use with disclaimers only | High | Lawyer-reviewed disclaimers; invariant #9 (no distortion); never position as professional advice; consider not actively marketing medical/legal until counsel review |
| **Commoditization** — "chat with local model" is a free commodity | Medium | Lead with corpus/compounding Experts, not chat; Expert Packs as licensing unit |
| **Code signing cost** — Windows EV cert ~$300–600/yr, Apple $99/yr + notarization | Medium | Factor into pricing; cannot ship publicly unsigned (SmartScreen/Gatekeeper) |
| **Payment/tax complexity** — global VAT/sales tax for a solo seller | Medium | Use merchant-of-record (Paddle/Lemon Squeezy/Gumroad) — already referenced in UI |
| **Ollama dependency perception** — README says built-in but architecture/case study reference Ollama | Low | Clarify messaging: built-in `node-llama-cpp` default, Ollama optional |
| **Retention** — local app, no phone-home, hard to re-engage lapsed users | Medium | Auto-update channel; compounding corpus creates switching cost; Expert Packs marketplace |

---

## 4. Readiness Assessment

### 4.1 Technical readiness — MOSTLY READY

**Completed and verified (ROADMAP status):**
- Stage 1 — Trustworthy foundation: schema versioning, backup-before-migrate, integrity check, full export/import, embedding contract, PDF ingestion fixed, honest reporting, re-index migration ✅
- Stage 2 — The brain works: multi-Expert federated retrieval, hybrid BM25+vector, precise citations, compounding memory, model routing, notes, auto-suggest Experts, ContextBuilder extracted ✅
- Stage 2.5 — Expert Roundtable: v1 (independent panel) + v2 (deliberation rounds) shipped and verified ✅
- Stage 4 — Security/privacy: link-handling fix, AES-256 encryption at rest (opt-in), app lock + auto-lock, hash-chained audit log, dependency CI audit ✅
- Packaging: builds on Win/mac/Linux, ~114 MB installer, electron-updater wired (defensive, no-op until publish target) ✅

**Not yet done / gaps:**
- Stage 3 — Growth safety: Research Inbox, deliberate promotion, Expert lifecycle (merge/split/rename), gap detection, `depth` param, autonomous Expert growth — **NOT STARTED**. This is the "app gets better with use" thesis; without it the core value proposition weakens over time.
- Stage 5 — Commercialization: code signing NOT configured (blocks public release), publish target + release pipeline not set, license activation implemented but untested at scale, onboarding shipped, legal docs are **draft**, crash reporting not added, accessibility not done, sqlite-vec not implemented (needed at 10k+ chunks).
- Performance at scale: O(n) full-scan vector search — fine for small vaults, needs sqlite-vec at 10k+ chunks.

### 4.2 Product readiness — PARTIAL

- The app is genuinely differentiated and the differentiators are *real and verified* (not marketing theater).
- Onboarding exists (<5 min to first Expert).
- UX gaps: ~400 lines of dead components reimplemented inline in SettingsModal (roadmap acknowledges); no renderer test runner; markdown rendering limited to code fences.
- The app is "demoable" (M1) and usable as a personal daily driver (M0). It is **not yet M3 (commercial v1)** because signing, legal, and publish pipeline are incomplete.

### 4.3 Commercial readiness — NOT READY (blocks revenue)

| Item | Status | Blocker? |
|---|---|---|
| Code signing (Windows EV/OV + Apple Developer) | Not purchased/configured | **Yes** — SmartScreen/Gatekeeper |
| Publish target + CI release pipeline | Not set | **Yes** — no auto-update, no public distribution |
| EULA / Privacy / Disclaimer | Draft, needs lawyer review | **Yes** — especially for medical/legal marketing |
| License activation | Implemented (offline-verifiable, machine-bound, 30-day grace) | Partially — needs real activation server + key issuance |
| Payments + tax (merchant of record) | Lemon Squeezy referenced in UI at $39/yr; no live integration | **Yes** — cannot accept money |
| Trial / freemium mechanism | Not built | No — lowers adoption barrier, important given cold-start |
| Landing page + demo video | Not present | No — needed for direct-to-consumer sales |
| Support channel + refund policy | Not present | No — consumer expectation |

---

## 5. Projected Pricing Plan

### 5.1 Pricing model rationale

The ROADMAP (§5b) correctly notes: *"A local, server-less app fits a **one-time license** or **paid major-version upgrades** better than a subscription (users will ask 'what am I paying monthly for if it runs on my machine?')."*

There is **no server cost per user** (inference runs on the user's hardware; search is user-initiated to third-party providers). The ongoing costs are: code signing certificates, CI, payment processing, support, and development. A subscription is hard to justify on value grounds for this architecture.

**Recommended model:** Hybrid
1. **Perpetual per-seat license for v1.x** (one-time purchase, includes minor updates)
2. **Paid major-version upgrades** (v2, v3 at a discount for existing owners) — predictable recurring revenue without subscription optics
3. **Optional Expert Packs / Team Packs** (one-time, Stage 7) — marketplace revenue, defensible licensing unit
4. **Free trial** (7–14 days full features, then reverts to free tier) — critical for cold-start adoption

**Drop the $39/yr Lemon Squeezy subscription** shown in the current LicenseSettings.jsx unless you add a clear ongoing service (cloud sync, curated pack updates, hosted Expert recipes). A yearly subscription for a local app will churn hard. If you want recurring revenue, sell major-version upgrades every 12–18 months instead.

### 5.2 Recommended tier structure (Individual edition)

| Tier | Price | Features | Best for |
|---|---|---|---|
| **Free** | $0 | Chat with local model, 1 active Expert, limited vault chunks (e.g., 500), web search off by default, no encryption, no app lock, no audit log, community support | Casual users, evaluation |
| **Personal (v1 perpetual)** | **$49–$59 one-time** | Unlimited Experts/vaults, full Roundtable, compounding memory, encryption at rest, app lock, audit log, corpus export/import, Expert Pack import, 1 year of minor updates, email support | Individual knowledge workers, researchers, prosumers |
| **Personal Pro** | **+$29–$39 per major version** | Upgrade to next major version (v2, v3…) at ~50–60% of new license price | Existing users wanting new features |
| **Expert Packs** | $9–$29 each (one-time) | Curated, versioned Expert templates (persona + research recipe), installable one-click | Cold-start reduction, marketplace revenue |
| **Team Packs** | $49–$99 each | Multi-Expert team configs (e.g., "Legal Team", "Medical Team") | Small teams, shared expertise |

**Pricing justification:**
- $49–$59 positions below NotebookLM-equivalent SaaS ($20–30/mo = $240–360/yr) while above free tools (LM Studio, Jan). The "you own the corpus forever" story justifies a one-time fee.
- At $49 one-time with ~$10/yr ongoing cost per user (signing, CI, support amortized), breakeven per user is reached quickly; subsequent revenue is mostly profit until the next major version.
- Major-version upgrade at $29–$39 (~60% of new price) creates predictable recurring revenue every 12–18 months without subscription optics.

### 5.3 Projected revenue (illustrative, Year 1–3, Individual only)

Assumptions: 1,000 monthly website visitors, 3% trial conversion to paid, $54 avg price, 70% upgrade rate at 18 months, $9–$29 Expert Pack attach rate 15%.

| | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| New paying users | 180 | 450 | 900 |
| License revenue (new) | $9,720 | $24,300 | $48,600 |
| Upgrade revenue (prior-year users) | $0 | $5,103 | $15,309 |
| Expert Pack revenue | $243 | $608 | $1,215 |
| **Total estimated revenue** | **~$10 K** | **~$30 K** | **~$65 K** |
| Cumulative users | 180 | 630 | 1,530 |

*These are illustrative, not a forecast. Actual results depend heavily on distribution (landing page, SEO, university/government pilot channels named in ROADMAP).*

### 5.4 Costs to ship (one-time + recurring)

| Cost | Estimate | Frequency |
|---|---|---|
| Windows code signing (OV) | $200–$400 | /yr |
| Windows code signing (EV, recommended) | $300–$600 | /yr |
| Apple Developer Program | $99 | /yr |
| Code-signing cloud service (Azure Trusted Signing / SSL.com eSigner) | ~$100–300 | /yr (if CI signing) |
| Lemon Squeezy / Paddle fees | ~5–10% | per transaction |
| macOS build runner (GitHub Actions macOS) | ~$50–100 | /mo |
| Domain + email + support tooling | ~$20–50 | /mo |
| Lawyer review of EULA/disclaimer | $1,500–$5,000 | one-time |

**Minimum viable commercial stack:** ~$700–$1,000 first year in signing + legal review, plus transaction fees. This is modest and easily covered by a few hundred license sales.

### 5.5 Licensing mechanics (already partially built)

The `licenseService.cjs` implements:
- Machine-bound, offline-verifiable signed license files (no phone-home required — consistent with privacy thesis)
- 30-day offline grace period after last online verification
- Feature gating: `deepResearch` and `specialistHubs` are licensed features; `chat` works unlicensed
- Tamper detection via signature verification
- Activation/deactivation via merchant API (Lemon Squeezy webhook pattern)

**Missing before sale:** real activation server/key issuance, publish target, payment flow, trial mechanism.

---

## 6. Go-to-Market Recommendations

### 6.1 Positioning (lead with the wedge)

**Do not** lead with "chat with a local LLM" — that's commoditized (LM Studio, Jan, GPT4All are free).

**Lead with:** *"A second brain you own. Local, private, offline. Your documents, your Experts, your citations — forever."*

Secondary messages:
- "Every answer shows its source — verified, not just plausible."
- "Experts get smarter the more you use them (compounding memory)."
- "No account, no server, nothing leaves your machine."

### 6.2 Launch sequence

1. **Pre-M3 (now → signing + legal):**
   - Purchase code signing certs (Windows EV recommended, Apple Developer)
   - Lawyer review of EULA, privacy policy, disclaimers (fill all bracketed placeholders)
   - Set up GitHub Releases publish target + CI pipeline
   - Implement trial/freemium mechanism + payment via merchant of record
   - Build simple landing page + 2-minute demo video

2. **M3 — Commercial v1 (first revenue):**
   - Ship signed installers on Windows + macOS (Linux optional/un signed)
   - Launch at $49–$59 one-time with 14-day free trial
   - Seed to: university contacts (ROADMAP mentions "presentation at University"), government research pilot, 5–10 design partners
   - Collect testimonials + case study

3. **M4 — Scaled v1.x:**
   - sqlite-vec for 10k+ chunk vaults
   - Multi-platform (mac/Linux parity)
   - Accessibility improvements
   - Starter Expert Packs (recipe-based, legally safe)

4. **Stage 7 — Expert Teams & Marketplace (after Individual validates):**
   - Expert Packs marketplace ($9–$29 each)
   - Team Packs ($49–$99)
   - Recipe packs only (no copyrighted content redistribution — see ROADMAP §7 content licensing)

5. **Stage 6 — Enterprise (deferred, only if Individual demand validates org interest):**
   - RBAC, multi-user, server/sync, HIPAA scope — only after counsel review

### 6.3 Channels

- **Direct-to-consumer:** landing page, Gumroad/Lemon Squeezy checkout, product Hunt, Hacker News, relevant subreddits (r/LocalLLaMA, r/ObsidianMD, r/Notion)
- **University / research:** the ROADMAP's named channel — credible for citation-rigor positioning
- **Government research contracts:** named in ROADMAP; requires high bar on provenance/reproducibility (already central to Sidekick's design)
- **Expert Packs marketplace:** Stage 7, passive revenue long-tail

---

## 7. Risks & Open Questions (from ROADMAP, still relevant)

1. **RBAC scope:** Central firm server vs. separate installs? → Decided: defer Enterprise; Individual first.
2. **Payment model:** One-time vs subscription? → Recommend one-time + major-version upgrades.
3. **Medical/legal marketing:** Jurisdictional review needed before actively marketing high-stakes use cases.
4. **Search privacy:** raw verbatim prompt forwarded to search provider — consider query derivation + disclosure.
5. **Code signing:** the single biggest shipping blocker; cannot be solved in code, requires purchased certs.

---

## 8. Immediate Action Checklist (next 4–8 weeks)

| # | Action | Owner | Est. effort |
|---|---|---|---|
| 1 | Purchase Windows EV + Apple Developer code-signing certs | Founder | 1 day + cost |
| 2 | Lawyer review EULA/privacy/disclaimer; fill bracketed placeholders | Legal | 1–2 weeks |
| 3 | Set up GitHub Releases publish target + CI build/sign pipeline | Dev | 3–5 days |
| 4 | Implement trial mechanism + merchant-of-record checkout (Lemon Squeezy/Paddle) | Dev | 3–5 days |
| 5 | Build landing page + demo video; set up support email | Founder | 1 week |
| 6 | Recruit 5–10 design partners (students, researchers, solo practitioners) | Founder | 2–4 weeks |
| 7 | Price at $49–$59 one-time, 14-day trial, launch M3 | Founder | — |

---

## Appendix: Key product facts for investors / stakeholders

- **Version:** 0.1.0 | **License:** LICENSE (MIT-ish, see repo) | **EULA:** draft (not reviewed)
- **Installer size:** ~114 MB (Windows), electron-builder configured
- **Tests:** 76 tests pass across Node + Electron runtimes
- **Native modules:** `better-sqlite3`, `better-sqlite3-multiple-ciphers`, `node-llama-cpp`, `pdf-parse`
- **Current monetization reference in UI:** $39/yr Lemon Squeezy subscription (not yet live)
- **Architecture thesis:** corpus > chat; model is swappable lens; never embed with chat model; cite or shut up; user always controls reasoning model