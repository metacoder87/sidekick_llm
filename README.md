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

- **Local inference via Ollama** — chat with any local model; switch freely at any
  time. Streaming responses over an NDJSON pipe.
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

- **Desktop**: Electron 41 (context isolation on, sandboxed preload IPC bridge)
- **Frontend**: React 18 + Vite 8
- **Persistence**: SQLite via `better-sqlite3` (WAL, FTS5, cosine vector search)
- **Documents / web**: `pdf-parse` (v2) for PDFs, a native-fetch scraper for pages
- **LLM**: Ollama HTTP API — `/api/chat` (streaming) and `/api/embeddings`

## System requirements

**Sidekick runs models on your machine, so your hardware sets the ceiling.** These
numbers are published up front on purpose — a local-LLM app that hides its hardware
cost earns refunds.

**[Ollama](https://ollama.com) is a required prerequisite.** Sidekick does not bundle
an inference engine; it talks to Ollama at `http://localhost:11434`.

| | Minimum | Comfortable | For the larger models |
|---|---|---|---|
| **RAM** | 8 GB | 16 GB | 32–48 GB |
| **Disk** | ~3 GB | ~8 GB | 25 GB+ |
| **OS** | Windows 10+, macOS 12+, or Linux | | |

Disk figures are models plus the app; your corpus grows on top of that. A GPU is not
required — Ollama will use one if present, and everything is far faster with it.

**Recommendations are based on total system RAM, not GPU VRAM**, because VRAM cannot
be read reliably across platforms (Windows WMI under-reports modern cards — an RTX
5080 reports 4 GB). An honest RAM figure beats a confident wrong VRAM one.

### Models

The app's first-run screen detects your RAM, shows what fits, and installs your
choices with one click. To do it by hand:

```bash
ollama pull nomic-embed-text   # 0.3 GB — REQUIRED for Experts and memory search
ollama pull llama3.1:8b        # 4.7 GB — recommended starting chat model
```

| Model | Download | RAM floor | Role |
|---|---|---|---|
| `nomic-embed-text` | 0.3 GB | 4 GB | **Required.** All retrieval depends on it |
| `llama3.2:3b` | 2.0 GB | 8 GB | Fast background work (summaries, extraction) |
| `llama3.1:8b` | 4.7 GB | 16 GB | Recommended general chat |
| `mistral:7b` | 4.4 GB | 16 GB | Alternative voice for Round Tables |
| `gemma2:9b` | 5.4 GB | 16 GB | Strong prose and editing |
| `qwen2.5:14b` | 9.0 GB | 32 GB | Better reasoning for analysis |
| `qwen2.5:32b` | 20 GB | 48 GB | Best local quality, real speed cost |

Any Ollama model works — this list is a starting point, not a restriction. **Your
choice of model is always yours** (ROADMAP invariant #5).

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
