# Contributing / Engineering Guide

Practical guide for working in the Sidekick codebase. For the system design see
[ARCHITECTURE.md](ARCHITECTURE.md); for direction and design invariants see
[ROADMAP.md](ROADMAP.md).

## Prerequisites

- Node.js (with npm) and [Ollama](https://ollama.com) running locally.
- Pull at least one chat model and the embedding model:
  ```bash
  ollama pull llama3:8b
  ollama pull nomic-embed-text
  ```
- `better-sqlite3` is a native module built against the Electron ABI. `npm install`
  runs `postinstall → rebuild:native` automatically; if you hit a
  `NODE_MODULE_VERSION` mismatch, run `npm run rebuild:native`.

## Run, build, test

```bash
npm run dev     # Vite dev server + Electron shell (hot reload)
npm run build   # production renderer → dist/
npm test        # full suite (Node + Electron runtimes)
```

- `npm run dev` opens DevTools detached and forwards renderer console logs to the
  terminal.
- Because `better-sqlite3` targets the Electron ABI, repository/worker code is run
  under Electron even for "node" tests (`cross-env ELECTRON_RUN_AS_NODE=1 electron
  --test …`). Ad-hoc scripts that `require` the repository must run the same way,
  and should require `better-sqlite3` from the project's `node_modules`.

## Project layout

```
electron/                     main process (CommonJS, .cjs)
  main.cjs                    app/window lifecycle
  preload.cjs                 contextBridge API (the only renderer surface)
  ipc.cjs                     IPC handlers + the message pipeline
  repository.cjs              SQLite: schema, migrations, backup, FTS, vectors, export/import
  ollama.cjs                  Ollama HTTP client (chat stream, embeddings, preflight)
  memory/memoryManager.cjs    fact extraction/dedup, relevance recall, summaries
  research/deepResearch.cjs   PDF/text ingest, web research, query derivation, re-index
  search/searchService.cjs    multi-provider web search + fallback chain
  search/scraper.cjs          HTML → main text
shared/channels.json          IPC channel-name registry (single source of truth)
src/                          renderer (React, ESM, .jsx)
  App.jsx                     top-level state + wiring
  components/                 UI components
test/                         node:test suites
```

## Conventions

- **Main process is CommonJS `.cjs`; renderer is ESM `.jsx`.** Keep the boundary at
  `preload.cjs`.
- **Add IPC in three places, in lockstep:** a name in `shared/channels.json`, a
  handler in `ipc.cjs`, and an exposed method in `preload.cjs`.
- **Never widen the preload surface** beyond what the renderer needs; the renderer
  must stay free of Node/filesystem access.
- Match the surrounding style (2-space indent, no TypeScript, minimal deps).

## The embedding contract (don't break it)

Retrieval correctness depends on a few invariants — see ARCHITECTURE §4:

- Embeddings always use `settings.embeddingModel`, never the chat model.
- Never persist an empty/non-finite vector; `assertValidEmbedding` enforces this.
- Every vector stores `embedding_model` + `embedding_dim`; retrieval filters on
  both. Legacy/mismatched rows are excluded and counted, never silently scored `0`.
- Ingest/research/re-index must report real counts and honest failure reasons —
  never a bare `{ success: true }`.

## Adding a schema migration

1. Bump `SCHEMA_VERSION` in `repository.cjs`.
2. Append `{ version: N, up: () => { … } }` to the `MIGRATIONS` list. Use
   `addColumnIfMissing(table, column, type)` for additive columns so the migration
   is safe on both fresh and existing databases (migrations run *before*
   `initialize()`).
3. If fresh databases should have the column immediately, also add it to the
   relevant `CREATE TABLE` in `initialize()`.
4. Extend `exportAll()` / `importAll()` if the new data is part of the corpus.
5. Add a test asserting the migration preserves data (see the legacy-backup test).

The runner auto-backs-up any populated database before applying pending migrations,
and asserts the migration list reaches `SCHEMA_VERSION`.

## Testing approach

- Prefer **deterministic, offline** tests. Stub the network and Ollama; inject
  seams where needed (e.g. `DeepResearchWorker` accepts an injectable `search`, and
  pure helpers like `rankMemoriesByRelevance` / `deriveSearchQueries` are exported).
- Assert on **retrievability and honest outcomes**, never on `success: true`. The
  bug class this codebase guards against is "silent success."
- Live checks against real Ollama/network are fine for manual verification but must
  not be added to the suite (they'd make it flaky).

## Commit hygiene

- Small, coherent commits; imperative subject; explain the *why*. Reference the
  ROADMAP phase where relevant.
- Update `ROADMAP.md` checkboxes when you complete a planned item, and this file /
  `ARCHITECTURE.md` when you change how things work.
