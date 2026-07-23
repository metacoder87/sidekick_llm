# Sidekick LLM

Privacy-first desktop interface & intelligence workspace for local LLMs powered by Ollama, SQLite vector embeddings, real-time web search grounding, personalized User Profiling, and niche Specialist Knowledge Hubs ("AI Experts on Hand").

## Key Features

- **Local Inference & Zero-Cost Privacy**: Runs 100% locally with Ollama; chat logs, vector embeddings, and personal facts never leave your machine.
- **Real-Time Web Search Grounding**: Toggleable web search (DuckDuckGo, SearXNG, Tavily, Brave) that scrapes live web pages and displays inline citation cards `[1]`, `[2]`.
- **User Profile & Personalization**: Customize your user name, role/occupation, technical stack, preferred tone, and global system instructions.
- **Multi-Tiered Contextual Memory**:
  - **Rolling Summarizer**: Automatically compresses older conversation turns in background SQLite jobs.
  - **Cross-Conversation Vector Memory**: Cosine similarity vector search over historical message embeddings.
  - **Memory Vault**: Structured user facts and preferences automatically extracted or manually managed.
- **Niche Specialist Knowledge Hubs ("AI Experts on Hand")**:
  - Create domain-specific experts (e.g. "React 19 Specialist", "Tax Law Expert").
  - Ingest & parse PDFs, markdown, text files, or run multi-depth Web Deep Research to build dedicated vector knowledge vaults.
- **Rich UI & Interactive Code Blocks**:
  - Markdown formatting with 1-click **Copy Code** buttons and language tags.

## Stack

- **Desktop Framework**: Electron 41
- **Frontend**: React 18, Vite 8
- **Database & Persistence**: SQLite via `better-sqlite3` (WAL mode, FTS5 virtual tables, vector cosine search)
- **Document & Web Services**: `pdf-parse` for PDF text extraction, native fetch scraper for web context
- **LLM Integration**: Ollama HTTP API (`/api/chat`, `/api/embeddings`)

## Getting Started

```bash
npm install
npm run dev
```

### Scripts

- `npm run dev`: Launch Vite dev server and Electron desktop shell.
- `npm test`: Run full test suite across Node.js and Electron native runtime.
- `npm run build`: Compile production distribution bundle.
- `npm run rebuild:native`: Rebuild native modules (`better-sqlite3`) for Electron ABI.

## Notes

- Ollama is expected at `http://localhost:11434` by default.
- SQLite database is persisted in Electron user data directory as `sidekick.db`.
- Web Search defaults to free DuckDuckGo HTML search without requiring API keys.
