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

## Prerequisites

- [Ollama](https://ollama.com) running locally (default `http://localhost:11434`)
- At least one chat model, e.g. `ollama pull llama3:8b`
- A dedicated embedding model (required for Experts & memory search):

  ```bash
  ollama pull nomic-embed-text
  ```

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
