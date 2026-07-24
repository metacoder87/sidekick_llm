# Case Study: Sidekick LLM

## Overview
Sidekick LLM is a privacy-first desktop **knowledge system** for local Large
Language Models via Ollama. It goes beyond a chat interface: the durable artifact
is a **corpus** the user owns — persistent conversations, a compounding memory of
personal facts, and domain-specific **AI Experts** trained on the user's own PDFs
and curated web research. It combines the responsiveness of a modern web UI with
the native capabilities and privacy of a fully local desktop environment: offline
operation, zero cost, and data that never leaves the machine.

## Architectural design
Built on **Electron**, moving from a client–server web model to a unified desktop
architecture. (Full detail in [ARCHITECTURE.md](ARCHITECTURE.md).)

### 1. Frontend (renderer)
- **React 18 + Vite 8.** Hooks manage streaming updates, model status, and the
  multi-Expert consulting panel.
- **Secure IPC bridge.** The renderer has no Node/filesystem access; it uses a
  narrow, context-isolated API exposed through a preload script.

### 2. Backend (main process)
- **Node in Electron**, interfacing directly with the local Ollama HTTP API for
  inference and embeddings — no cloud dependency.
- A structured IPC layer handles chat, models, memory, Experts, research, corpus
  export/import, and settings.

### 3. Data persistence & search
- **SQLite via `better-sqlite3`** — synchronous, high-performance local storage in
  WAL mode.
- **Versioned schema** (`PRAGMA user_version`) with a transactional migration
  runner, **automatic backup-before-migrate**, and an integrity check on open.
- Tables span conversations, messages, user profile, de-duplicated memories,
  message & specialist **vector embeddings**, Expert hubs and their knowledge
  chunks, and settings.
- **FTS5** virtual tables provide fast, offline full-text search with BM25 ranking;
  cosine similarity powers vector retrieval.

## Engineering highlights

### The embedding contract
A chunk without a valid, dimension-matched vector is invisible to retrieval, not
merely degraded. Sidekick treats embeddings as a load-bearing invariant: a
dedicated embedding model decoupled from the chat model, provenance (`embedding_model`,
`embedding_dim`) on every vector, a write boundary that rejects empty vectors, and
retrieval that *excludes and reports* mismatched vectors rather than silently
scoring them zero. Existing vaults are repairable via in-place re-indexing.

### Federated Expert consultation
Users consult one Expert or a panel. The query is embedded once, each selected
vault is searched, personas are combined, and the prompt asks the model to surface
disagreements rather than flatten them — with a per-answer grounding badge that
distinguishes cited, vault-backed answers from model-only ones.

### Compounding memory
Facts are extracted in the background, de-duplicated on a canonical form, and
recalled by relevance to the current question rather than pure recency — so the
assistant improves with use instead of accumulating noise.

### Honest reporting
Every long-running operation (ingest, research, re-index) reports real counts and
actionable failure reasons instead of a blanket success. Embedding models are
pre-flighted before minutes of work, and web research decomposes long briefs into
real search queries with a provider fallback chain.

### Resilient offline architecture
Model (Ollama) and database (SQLite) are both local, so the app runs fully offline.
It polls Ollama availability and surfaces connection and database-integrity issues
to the user rather than failing silently.

## Conclusion
Sidekick LLM bridges complex local AI models and a user-friendly desktop workspace.
By treating the accumulated corpus — not the chat window — as the product, and by
enforcing correctness invariants around embeddings, retrieval, and reporting, it
delivers a secure, offline-first assistant that gets more valuable the longer it is
used, while keeping the user in control of their models and their data.
