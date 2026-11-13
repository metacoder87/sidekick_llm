# Sidekick LLM

A **privacy-first desktop knowledge system** for local LLMs. Sidekick is not a
local ChatGPT clone — it is a personal corpus that grows with you: persistent
conversations, a compounding memory of facts about you, and **"AI Experts"** —
NotebookLM-style notebooks you train on your own PDFs and curated web research,
then consult individually or as a panel.

Everything runs **locally, offline-capable, zero-cost, and private**. Your chats,
embeddings, notes, and documents never leave your machine.

> The durable value here is the **corpus**, not the chat window. The model is a
> swappable lens onto knowledge you own. See [ROADMAP.md](ROADMAP.md) for the
> project thesis and direction, and [ARCHITECTURE.md](ARCHITECTURE.md) for how it
> is built.

## Key features

- **Built-in local inference** — `node-llama-cpp` runs GGUF models in an isolated
  Sidekick worker, with no server, no listening network port, and no Ollama install.
  Ollama remains an optional Advanced compatibility provider.
- **AI Experts (Specialist Knowledge Hubs)** — create a domain expert, then train
  its private vector vault by:
  - **uploading PDFs / text / markdown**, or
  - running **Web Deep Research**: a topic or research brief is decomposed into
    real search queries, results are scraped, and the knowledge is embedded and
    indexed.
- **Consult a panel of Experts** — select one or several Experts for a
  conversation. Each selected vault is searched (federated retrieval), personas
  are combined, and the Experts being consulted are tagged at the top of the chat.
  Every answer carries a **grounding badge** showing whether it drew on vault
  knowledge or spoke from the model alone.
- **Compounding memory** — facts about you are extracted in the background,
  **de-duplicated**, and recalled by **relevance to the current question** (not
  just recency), so the assistant gets better with use instead of noisier.
- **Real-time web search grounding** — optional, provider-aware (DuckDuckGo,
  SearXNG, Tavily, Brave) with a fallback chain, inline citation cards.
- **Your corpus is portable and protected** — versioned SQLite schema with
  automatic backup-before-migrate, an integrity check on open, and full
  **export / import** of the entire corpus (conversations, memory, profile, and
  Expert vaults including embeddings).
- **Model routing** — an optional fast "background model" handles summaries, fact
  extraction, and research query generation, keeping chat responsive while you
  converse with a larger model.
- **Dual themes** (Cyberpunk / Professional), full-text conversation search
  (SQLite FTS5), and interactive code blocks with copy buttons.

## Stack

- **Desktop**: Electron 45 (context isolation on, preload IPC bridge)
- **Frontend**: React 18 + Vite 8
- **Persistence**: SQLite via `better-sqlite3` (WAL, FTS5, cosine vector search)
- **Documents / web**: `pdf-parse` (v2) for PDFs, a native-fetch scraper for pages
- **LLM**: `node-llama-cpp` / embedded `llama.cpp` in a private Electron utility process

## System requirements

**Sidekick runs models on your machine, so your hardware sets the ceiling.** These
numbers are published up front on purpose — a local-LLM app that hides its hardware
cost earns refunds.

**No external inference software is required.** Sidekick downloads a GGUF model only
after you explicitly choose it in onboarding. Native inference communicates over a
private operating-system process channel and opens no listening port.

| | Minimum | Comfortable | For the larger models |
|---|---|---|---|
| **RAM** | 8 GB | 16 GB | 32–48 GB |
| **Disk** | ~3 GB | ~8 GB | 25 GB+ |
| **OS** | Windows 10+, macOS 12+, or Linux | | |

Disk figures are models plus the app; your corpus grows on top of that. A GPU is not
required. After a user-approved model install, Sidekick runs a short local calibration
and retains the fastest stable native backend; CPU remains the fallback.

**Recommendations are based on total system RAM, not GPU VRAM**, because VRAM cannot
be read reliably across platforms (Windows WMI under-reports modern cards — an RTX
5080 reports 4 GB). An honest RAM figure beats a confident wrong VRAM one.

### Models

The first-run screen offers a verified chat-model choice and always pairs it with the
required embedding model. Downloads are explicit, resumable, and fingerprinted.

| Model | Download | RAM floor | Role |
|---|---|---|---|
| `nomic-embed-text-v1.5` Q8 | 0.15 GB | 4 GB | **Required.** All retrieval depends on it |
| `Qwen3-8B` Q4_K_M | 5.03 GB | 16 GB | Recommended general chat |
| `Qwen2.5-7B` Q4_K_M | 4.72 GB | 16 GB | Balanced alternative |

You can import other GGUF models or enable Ollama in Advanced settings. **Your choice
of model is always yours** (ROADMAP invariant #5).

## Getting started

```bash
npm install
npm run dev
```

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Launch the Vite dev server and the Electron shell |
| `npm test` | Run the full test suite (Node + Electron native runtime) |
| `npm run build` | Build the production renderer bundle to `dist/` |
| `npm run rebuild:native` | Rebuild native modules (`better-sqlite3`) for the Electron ABI |
| `npm run lint` | ESLint across main process, renderer, and tests |
| `npm run format` | Apply Prettier (code only — Markdown is left alone) |

## Notes

- The SQLite database lives in the Electron user-data directory as `sidekick.db`.
  Pre-migration backups are written next to it as `sidekick.db.bak-v<n>-<timestamp>`.
- Web search is **off by default** and requires no API key (DuckDuckGo). API keys
  for Tavily/Brave, if used, are stored locally in the settings table.
- Embeddings are always produced by the dedicated embedding model, independent of
  your chat model, so switching chat models never orphans a vault. If you built
  vaults before configuring an embedding model, use **Re-index Knowledge Vault**
  in an Expert's settings to repair them.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design, data model, pipelines
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, project layout, testing, migrations
- [ROADMAP.md](ROADMAP.md) — thesis, design invariants, staged plan, and status
- [RELEASING.md](RELEASING.md) — packaging, code signing, and the update channel

## Limits and legal

Sidekick is a **research tool, not a professional**. It presents material and its
sources so you can judge for yourself; it does not give medical, legal, or financial
advice, and its answers can be confidently wrong. A citation proves where a claim
came from — not that it is correct. Follow it back to the source for anything that
matters.

- [LEGAL/DISCLAIMER.md](LEGAL/DISCLAIMER.md) — what the tool can get wrong, in plain
  language (also shown in-app under **Settings → Legal & Limits**)
- [LEGAL/PRIVACY.md](LEGAL/PRIVACY.md) — no account, no telemetry, no server; exactly
  when the network is used
- [LEGAL/EULA.md](LEGAL/EULA.md) — **draft; requires review by a lawyer before
  distribution**
