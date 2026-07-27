# Privacy Policy

**Last updated: 2026-07-27**

Sidekick LLM is a desktop application that runs on your own computer. The short
version: **we do not receive your data, because there is nowhere for it to go.**
There is no Sidekick account, no Sidekick server, and no telemetry.

## What we collect

**Nothing.** Sidekick has no analytics, no crash reporting, no usage tracking, and no
phone-home licence check. It does not require an internet connection to run.

If opt-in crash reporting is ever added, it will be **off by default**, will state
exactly what it sends before you enable it, and will remain optional.

## What Sidekick stores, and where

Everything is written to your machine's standard application-data directory:

| Data | Contents |
|---|---|
| `sidekick.db` | Conversations, messages, memories, profile, Experts, vault text and embeddings, notes, settings, audit log |
| `sidekick.db.bak-v<n>-<timestamp>` | Automatic backups taken before a schema migration |
| Corpus exports | Only where you choose to save them |

You can read, copy, back up, move, or delete these files yourself at any time. The
export feature produces a complete, portable copy of your corpus.

**Encryption at rest is available and off by default** (Settings → Security). When
enabled, the database is encrypted with AES-256 using a passphrase only you hold.
**If you lose that passphrase, the corpus cannot be recovered — by us or by anyone.**
That is the point of it. Your passphrase may optionally be remembered in your
operating system's keychain (Windows Credential Manager, macOS Keychain, or the
Linux secret service) so the app can unlock itself.

## When Sidekick uses the network

Sidekick makes network requests in exactly three situations, all driven by you:

1. **Your local model server (Ollama).** Requests go to `http://localhost:11434` on
   your own machine. Prompts, documents, and vault content are sent there for
   inference and embedding. This traffic does not leave your computer.
2. **Web search and Deep Research — off by default.** When you turn on web search or
   run a Deep Research job, Sidekick sends your *search queries* to the search
   provider you selected (DuckDuckGo, SearXNG, Tavily, or Brave) and fetches the
   pages returned. Those providers see the queries and your IP address, under their
   own privacy policies. Your conversations, documents and vault contents are not
   sent — only the queries.
3. **Model downloads.** Pulling a model asks your local Ollama to download it from
   the model registry.

If you use a self-hosted SearXNG instance, or point Ollama at a remote host, those
destinations are yours and are governed by whoever runs them.

## Third-party API keys

Tavily and Brave keys, if you choose to use them, are stored in your local settings
table on your machine and are sent only to that provider.

## Children

Sidekick is not directed at children under 13.

## Changes

Material changes to this policy will be noted in the release notes and the "last
updated" date above.

## Contact

Questions about this policy: see the repository's issue tracker.
