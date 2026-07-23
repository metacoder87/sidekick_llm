# Sidekick LLM Architectural Plan & Engineering Specifications

## System Architecture

Sidekick LLM is an offline-first desktop platform combining local model inference, real-time web search grounding, personalized memory, and domain-specific Specialist Knowledge Hubs.

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                                   RENDERER PROCESS                                    │
│                                  (React 18 + Vite)                                    │
│  ┌────────────────────┬────────────────────┬────────────────────┬──────────────────┐  │
│  │   Chat View &      │   Sidebar & Model  │   Specialist Hub   │   User Profile   │  │
│  │   Code Copy UI     │   Selection        │   Gallery          │   & Memory Vault │  │
│  └────────────────────┴────────────────────┴────────────────────┴──────────────────┘  │
└──────────────────────────────────────────┬────────────────────────────────────────────┘
                                           │ IPC (preload.cjs)
                                           ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                                    MAIN PROCESS                                       │
│                                (Electron 41 / Node)                                   │
│  ┌───────────────────────────┬───────────────────────────┬─────────────────────────┐  │
│  │   IPC Handler Registry    │   Web Search Engine       │   Deep Research Worker  │  │
│  │   (electron/ipc.cjs)      │   (DuckDuckGo/Scraper)    │   & PDF Parser          │  │
│  ├───────────────────────────┼───────────────────────────┼─────────────────────────┤  │
│  │   Memory Manager          │   Ollama HTTP Client      │   SQLite Repository     │  │
│  │   (Rolling/Vector/Facts)  │   (Chat & Embeddings)     │   (better-sqlite3)      │  │
│  └───────────────────────────┴───────────────────────────┴─────────────────────────┘  │
└──────────────────────────────────────────┬────────────────────────────────────────────┘
                                           │
                        ┌──────────────────┴──────────────────┐
                        ▼                                     ▼
             ┌─────────────────────┐               ┌─────────────────────┐
             │   Local Ollama      │               │   SQLite Database   │
             │   (http://localhost)│               │   (sidekick.db)     │
             └─────────────────────┘               └─────────────────────┘
```

---

## Technical Stack & Libraries

- **Frontend UI**: React 18, Vite 8, CSS Design System (Glassmorphism, Dark Mode)
- **Desktop Framework**: Electron 41 (Context Isolation enabled, IPC Bridge)
- **Database Engine**: SQLite 3 via `better-sqlite3` (WAL Mode, FTS5 virtual tables, cosine similarity search)
- **Document & Web Parsing**: `pdf-parse` for PDF text extraction, native HTML scraper with DOM element filtering
- **LLM Engine**: Ollama HTTP API (`/api/chat` streaming NDJSON & `/api/embeddings`)

---

## Core System Services

### 1. Repository Layer (`electron/repository.cjs`)
Manages SQLite schemas, triggers, and query operations synchronously:
- **`conversations`**: Stores thread metadata, title, and rolling summaries.
- **`messages`**: Stores chat turns (`system`, `user`, `assistant`).
- **`user_profile`**: Stores persistent user identity, role, tech stack, response tone, and global guidelines.
- **`user_memories`**: Stores structured facts extracted automatically or added via the Memory Vault.
- **`message_embeddings`**: Stores message chunks and 768/1536d vector arrays for cross-conversation RAG.
- **`specialist_hubs`**: Stores niche AI expert configurations, descriptions, and persona system prompts.
- **`specialist_chunks`**: Stores indexed knowledge vault chunks, source titles/URLs, and vector embeddings for specialist RAG.
- **`settings`**: Key-value settings store for web search toggles, API keys, and model defaults.
- **FTS5 Virtual Tables**: `message_search` and `conversation_search` for full-text search with BM25 ranking.

### 2. Web Search & Scraping Service (`electron/search/`)
- **`searchService.cjs`**: Multi-provider search orchestrator supporting DuckDuckGo (HTML search, zero-config default), SearXNG, Tavily, and Brave Search.
- **`scraper.cjs`**: Main-text extractor that strips script, style, header, and navigation tags, converting HTML into clean Markdown snippets.

### 3. Memory Manager Service (`electron/memory/memoryManager.cjs`)
- **Rolling Summarizer**: Prompts Ollama in the background to update `conversations.summary` when thread length > 8.
- **Vector RAG Retriever**: Generates prompt embeddings and computes vector cosine distance across past chats.
- **Fact Extractor**: Scans incoming messages for personal triggers (`"I use"`, `"my role"`) and saves extracted facts into `user_memories`.

### 4. Deep Research & PDF Worker (`electron/research/deepResearch.cjs`)
- **PDF & Document Ingestion**: Reads binary PDF streams using `pdf-parse`, extracts text, chunks into 800-character blocks with overlap, generates embeddings, and indexes into `specialist_chunks`.
- **Web Deep Research**: Performs automated web searching and scraping for a topic or list of seed URLs, populating dedicated Specialist Hub vector vaults.

---

## System Prompt Context Pipeline

When a user sends a message, `electron/ipc.cjs` constructs the System Prompt by layering:

```
┌────────────────────────────────────────────────────────┐
│ 1. Base System Instruction ("You are Sidekick...")     │
├────────────────────────────────────────────────────────┤
│ 2. User Profile (Name, Role, Stack, Tone, Guidelines)  │
├────────────────────────────────────────────────────────┤
│ 3. Active Specialist Role & RAG Context (If Selected)  │
├────────────────────────────────────────────────────────┤
│ 4. Contextual Memory (Facts + Cross-Chat RAG + Summary)│
├────────────────────────────────────────────────────────┤
│ 5. Real-Time Web Search Context & Citations [1], [2]   │
└────────────────────────────────────────────────────────┘
```

---

## Development & Test Commands

```bash
# Install dependencies & build native modules
npm install

# Launch Vite dev server & Electron desktop window
npm run dev

# Execute unit test suites (Node.js & Electron native runtime)
npm test

# Build production client bundle
npm run build
```
