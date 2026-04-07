# Sidekick LLM

Desktop chat client for local LLMs with Ollama, SQLite-backed conversation history, local full-text search, and JSON export.

## Stack

- Electron main process for local integrations
- React + Vite renderer
- SQLite via `better-sqlite3`
- Ollama HTTP API for local model inference

## Scripts

```bash
npm install
npm run dev
```

Additional commands:

```bash
npm run build
npm run preview
npm test
npm run rebuild:native
```

## Notes

- Ollama is expected at `http://localhost:11434` by default.
- Conversation history is stored in the Electron user data directory as `sidekick.db`.
- Search is local-only and uses SQLite FTS.
- Export writes JSON files through the native save dialog.
- Native Electron modules are rebuilt automatically on `npm install` and before `npm run dev`.
