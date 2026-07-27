const fs = require('node:fs');
const path = require('node:path');
// Encryption-capable drop-in for better-sqlite3 (same API, same version line) that
// bundles AES-256 / SQLCipher. With NO key set it reads and writes plain SQLite
// identically, so adopting the driver changes nothing until a passphrase is
// configured — encryption stays opt-in (ROADMAP Stage 4).
const Database = require('better-sqlite3-multiple-ciphers');
const { randomUUID, createHash } = require('node:crypto');

// The current target schema version. Bump this and append a migration to
// MIGRATIONS whenever the schema changes. The corpus is the project's asset
// (see ROADMAP.md §3) — every migration runs behind a backup and an integrity
// check so a bad upgrade can never destroy user data.
const SCHEMA_VERSION = 8;
const MAX_BACKUPS = 5;

const DEFAULT_TITLE = 'New conversation';
const DEFAULT_SETTINGS = {
  ollamaBaseUrl: 'http://localhost:11434',
  webSearchEnabled: 'false',
  searchProvider: 'duckduckgo',
  searxngUrl: '',
  tavilyApiKey: '',
  braveApiKey: '',
  autoMemoryEnabled: 'true',
  // Embeddings use a dedicated model, decoupled from the chat model, so switching
  // the chat model never changes vector dimensions and orphans the vault
  // (ROADMAP §3 invariant #5). nomic-embed-text is 768-d and purpose-built.
  embeddingModel: 'nomic-embed-text',
  // Optional fast model for background/utility work (summaries, fact extraction,
  // research query generation). Empty = use the active chat model. Lets a user chat
  // with a large model while cheap background tasks run on a small one (invariant #5).
  backgroundModel: '',
  // Multi-Expert conversation style: 'synthesized' (one blended answer) or
  // 'roundtable' (each Expert speaks in its own grounded voice, then a moderator
  // consolidates). See ROADMAP Stage 2.5.
  panelMode: 'synthesized',
  // Rounds of Expert turns before the moderator wraps up (roundtable mode).
  roundtableRounds: '1',
};

const DEFAULT_PROFILE = {
  name: 'User',
  role: 'Software Developer',
  tone: 'Balanced & Helpful',
  stack: 'JavaScript / Node.js',
  instructions: 'Provide clean code, clear explanations, and best practices.',
};

function now() {
  return new Date().toISOString();
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// The embedding contract's write-boundary check (ROADMAP §3 invariant #4). A
// chunk without a valid, finite, non-empty vector is invisible to retrieval, not
// merely degraded — so we refuse to persist one rather than store a dead row that
// inflates counts and silently returns nothing.
function assertValidEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Embedding is empty — refusing to store an unretrievable chunk.');
  }
  for (const value of embedding) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Embedding contains a non-finite value — refusing to store.');
    }
  }
}

// Canonical form of a fact for de-duplication: case-insensitive, whitespace-
// collapsed, trailing punctuation removed. Lets "I use Windows 11", "i use windows
// 11." and "I  use  Windows 11" collapse to a single stored memory instead of
// accumulating near-duplicates that later evict useful facts (ROADMAP §2 — memory
// must compound, not degrade).
function normalizeFact(fact) {
  return (fact || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?;,]+$/, '')
    .trim();
}

function createAutoTitle(content) {
  return content
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72) || DEFAULT_TITLE;
}

function toFtsQuery(input) {
  return input
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ''))
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(' OR ');
}

class ConversationRepository {
  constructor(filename) {
    this.filename = filename;
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // 1. Verify the existing database is not corrupt BEFORE we touch it.
    this.integrity = this.checkIntegrity();

    // 2. Back up (if there is existing data) and run any pending migrations.
    //    This must happen before initialize()/seeding so an upgrade of an old
    //    database is always protected by a fresh backup.
    this.runMigrations();

    // 3. Ensure schema objects exist and defaults are seeded (idempotent).
    this.initialize();
  }

  // Returns { ok: boolean, detail: string }. Never throws — a corrupt database
  // should be surfaced to the user, not crash startup silently (ROADMAP §5 Phase −1).
  checkIntegrity() {
    try {
      const rows = this.db.pragma('integrity_check');
      const detail = Array.isArray(rows) && rows[0] ? rows[0].integrity_check : 'unknown';
      return { ok: detail === 'ok', detail };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }

  getSchemaVersion() {
    const rows = this.db.pragma('user_version');
    return Array.isArray(rows) && rows[0] ? rows[0].user_version : 0;
  }

  setSchemaVersion(version) {
    this.db.pragma(`user_version = ${Number(version)}`);
  }

  hasExistingData() {
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .get();
      return row.count > 0;
    } catch (_error) {
      return false;
    }
  }

  // Consistent, WAL-safe copy of the database file. Checkpoints the WAL into the
  // main file first, then copies it. Returns the backup path, or null on failure
  // (backup failure must not block startup, but is logged).
  backupDatabase(tag) {
    try {
      // Skip for in-memory databases (used in tests).
      if (!this.filename || this.filename === ':memory:') {
        return null;
      }
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${this.filename}.bak-${tag}-${stamp}`;
      fs.copyFileSync(this.filename, backupPath);
      this.pruneBackups();
      return backupPath;
    } catch (error) {
      console.error('Database backup failed:', error.message);
      return null;
    }
  }

  // Keep only the most recent MAX_BACKUPS backup files for this database.
  pruneBackups() {
    try {
      const dir = path.dirname(this.filename);
      const base = path.basename(this.filename);
      const prefix = `${base}.bak-`;
      const backups = fs
        .readdirSync(dir)
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({
          name,
          time: fs.statSync(path.join(dir, name)).mtimeMs,
        }))
        .sort((a, b) => b.time - a.time);

      for (const stale of backups.slice(MAX_BACKUPS)) {
        fs.rmSync(path.join(dir, stale.name), { force: true });
      }
    } catch (error) {
      console.error('Backup pruning failed:', error.message);
    }
  }

  // Adds a column to an existing table only when both the table exists and the
  // column does not. On a fresh database the table has not been created yet at
  // migration time (migrations run before initialize()), so this is a safe no-op
  // and initialize() creates the table with the column already present.
  addColumnIfMissing(table, column, type) {
    const tableExists = this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (!tableExists) {
      return;
    }
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // Ordered, additive migrations. Migration 1 is the baseline: the schema is
  // created idempotently by initialize(), so on both fresh and legacy (pre-
  // versioning) databases this migration only stamps the version. Future schema
  // changes append { version: N, up(db) } entries with real ALTER statements.
  runMigrations() {
    const migrations = [
      { version: 1, up: () => {} },
      {
        // Embedding provenance: tag every stored vector with the model that
        // produced it and its dimension, so retrieval can exclude vectors that
        // no longer match the active embedding model instead of silently scoring
        // them 0 (ROADMAP §3 invariant #4, §5 Phase 1). Legacy rows keep NULLs and
        // are excluded until re-indexed (Phase 4).
        version: 2,
        up: () => {
          this.addColumnIfMissing('specialist_chunks', 'embedding_model', 'TEXT');
          this.addColumnIfMissing('specialist_chunks', 'embedding_dim', 'INTEGER');
          this.addColumnIfMissing('message_embeddings', 'embedding_model', 'TEXT');
          this.addColumnIfMissing('message_embeddings', 'embedding_dim', 'INTEGER');
        },
      },
      {
        // Citation provenance: where exactly a chunk came from, so a grounded claim
        // can be traced to a page / character range and deep-linked (ROADMAP Stage 2
        // — precise verifiable citations, invariants #1/#2). Legacy chunks keep NULLs
        // and simply render without a precise location.
        version: 3,
        up: () => {
          this.addColumnIfMissing('specialist_chunks', 'location', 'TEXT');
          this.addColumnIfMissing('specialist_chunks', 'page', 'INTEGER');
          this.addColumnIfMissing('specialist_chunks', 'char_start', 'INTEGER');
          this.addColumnIfMissing('specialist_chunks', 'char_end', 'INTEGER');
          this.addColumnIfMissing('specialist_chunks', 'source_type', 'TEXT');
        },
      },
      {
        // Hybrid retrieval: an FTS5 index over vault chunks so keyword/BM25 search
        // can be fused with vector similarity. Pure cosine misses exact terms
        // (clause numbers, drug names, API symbols) that a lexical index nails.
        // The table + triggers are created idempotently in initialize(); this
        // migration backfills any chunks that predate the index.
        version: 4,
        up: () => {
          const hasChunks = this.db
            .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='specialist_chunks'`)
            .get();
          if (!hasChunks) return;
          this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS specialist_chunk_search USING fts5(
              chunk_id UNINDEXED,
              hub_id UNINDEXED,
              chunk_text
            );
            DELETE FROM specialist_chunk_search;
            INSERT INTO specialist_chunk_search(rowid, chunk_id, hub_id, chunk_text)
            SELECT rowid, id, hub_id, chunk_text FROM specialist_chunks;
          `);
        },
      },
      {
        // Notes: first-class, editable knowledge authored by the user or the model
        // and attached to an Expert. Unlike ingested documents (which are immutable
        // sources), a note is the place where the user's own *insight* accumulates —
        // it is itself embedded into the vault so it becomes retrievable knowledge.
        version: 5,
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS notes (
              id TEXT PRIMARY KEY,
              hub_id TEXT NOT NULL,
              title TEXT NOT NULL,
              body TEXT NOT NULL,
              author TEXT NOT NULL DEFAULT 'user',
              source_conversation_id TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (hub_id) REFERENCES specialist_hubs(id) ON DELETE CASCADE
            );
          `);
        },
      },
      {
        // Memory supersession: when a newer fact replaces an older one ("I use
        // Windows" → "I switched to Linux"), the old fact is retired rather than
        // deleted, so the corpus keeps its history while retrieval only sees what is
        // currently true. `reinforced_count` records how often a fact recurs, which
        // ranking uses to keep well-established facts ahead of one-off mentions.
        version: 6,
        up: () => {
          this.addColumnIfMissing('user_memories', 'superseded_by', 'TEXT');
          this.addColumnIfMissing('user_memories', 'superseded_at', 'TEXT');
          this.addColumnIfMissing('user_memories', 'reinforced_count', 'INTEGER');
          // Migrations run BEFORE initialize(), so on a fresh database the table
          // does not exist yet — backfill only when there is something to backfill.
          const hasTable = this.db
            .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_memories'`)
            .get();
          if (hasTable) {
            this.db.exec(`UPDATE user_memories SET reinforced_count = 1 WHERE reinforced_count IS NULL`);
          }
        },
      },
      {
        // Roundtable turn attribution: in a deliberation each Expert's contribution
        // is its own assistant message, so history reloads coherently and every turn
        // keeps its own citations (ROADMAP Stage 2.5).
        version: 7,
        up: () => {
          this.addColumnIfMissing('messages', 'expert_id', 'TEXT');
          this.addColumnIfMissing('messages', 'expert_name', 'TEXT');
          this.addColumnIfMissing('messages', 'round', 'INTEGER');
          this.addColumnIfMissing('messages', 'turn_kind', 'TEXT');
        },
      },
      {
        // Append-only audit log of sensitive actions, hash-chained so tampering is
        // detectable: each entry's hash covers the previous hash, so removing or
        // editing any entry breaks the chain from that point on. This is the
        // accountability half of Stage 4 (the other half is encryption at rest).
        version: 8,
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS audit_log (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              at TEXT NOT NULL,
              action TEXT NOT NULL,
              detail TEXT,
              prev_hash TEXT,
              hash TEXT NOT NULL
            );
          `);
        },
      },
    ];

    // Guard against drift: the migration list must reach the declared version.
    const latest = migrations[migrations.length - 1].version;
    if (latest !== SCHEMA_VERSION) {
      throw new Error(
        `Migration list ends at v${latest} but SCHEMA_VERSION is ${SCHEMA_VERSION}.`,
      );
    }

    const current = this.getSchemaVersion();
    const pending = migrations.filter((m) => m.version > current);
    if (pending.length === 0) {
      return;
    }

    // Only back up when upgrading a database that already holds data. A brand-new
    // database (no tables yet) has nothing worth backing up.
    if (this.hasExistingData()) {
      this.backupDatabase(`v${current}`);
    }

    for (const migration of pending) {
      const applyMigration = this.db.transaction(() => {
        migration.up(this.db);
        this.setSchemaVersion(migration.version);
      });
      applyMigration();
    }
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'complete',
        expert_id TEXT,
        expert_name TEXT,
        round INTEGER,
        turn_kind TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        fact TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        source_conversation_id TEXT,
        superseded_by TEXT,
        superseded_at TEXT,
        reinforced_count INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_embeddings (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        embedding_model TEXT,
        embedding_dim INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_profile (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS specialist_hubs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        system_prompt TEXT,
        icon TEXT DEFAULT 'brain',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS specialist_chunks (
        id TEXT PRIMARY KEY,
        hub_id TEXT NOT NULL,
        source_title TEXT NOT NULL,
        source_url TEXT,
        chunk_text TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        embedding_model TEXT,
        embedding_dim INTEGER,
        location TEXT,
        page INTEGER,
        char_start INTEGER,
        char_end INTEGER,
        source_type TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (hub_id) REFERENCES specialist_hubs(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
        message_id UNINDEXED,
        conversation_id UNINDEXED,
        content
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_search USING fts5(
        conversation_id UNINDEXED,
        title
      );

      -- Append-only, hash-chained audit log of sensitive actions (Stage 4).
      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        prev_hash TEXT,
        hash TEXT NOT NULL
      );

      -- Notes: editable, first-class knowledge attached to an Expert (user- or
      -- model-authored). Embedded into the vault so insight becomes retrievable.
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        hub_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT 'user',
        source_conversation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (hub_id) REFERENCES specialist_hubs(id) ON DELETE CASCADE
      );

      -- Lexical index over Expert vault chunks, for hybrid (BM25 + vector) retrieval.
      CREATE VIRTUAL TABLE IF NOT EXISTS specialist_chunk_search USING fts5(
        chunk_id UNINDEXED,
        hub_id UNINDEXED,
        chunk_text
      );

      DROP TRIGGER IF EXISTS specialist_chunks_ai;
      DROP TRIGGER IF EXISTS specialist_chunks_au;
      DROP TRIGGER IF EXISTS specialist_chunks_ad;

      CREATE TRIGGER specialist_chunks_ai AFTER INSERT ON specialist_chunks BEGIN
        INSERT INTO specialist_chunk_search(rowid, chunk_id, hub_id, chunk_text)
        VALUES (new.rowid, new.id, new.hub_id, new.chunk_text);
      END;

      CREATE TRIGGER specialist_chunks_au AFTER UPDATE ON specialist_chunks BEGIN
        DELETE FROM specialist_chunk_search WHERE rowid = old.rowid;
        INSERT INTO specialist_chunk_search(rowid, chunk_id, hub_id, chunk_text)
        VALUES (new.rowid, new.id, new.hub_id, new.chunk_text);
      END;

      CREATE TRIGGER specialist_chunks_ad AFTER DELETE ON specialist_chunks BEGIN
        DELETE FROM specialist_chunk_search WHERE rowid = old.rowid;
      END;

      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS conversations_ai;
      DROP TRIGGER IF EXISTS conversations_au;
      DROP TRIGGER IF EXISTS conversations_ad;

      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO message_search(rowid, message_id, conversation_id, content)
        VALUES (new.rowid, new.id, new.conversation_id, new.content);
      END;

      CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        DELETE FROM message_search WHERE rowid = old.rowid;
        INSERT INTO message_search(rowid, message_id, conversation_id, content)
        VALUES (new.rowid, new.id, new.conversation_id, new.content);
      END;

      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        DELETE FROM message_search WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER conversations_ai AFTER INSERT ON conversations BEGIN
        INSERT INTO conversation_search(rowid, conversation_id, title)
        VALUES (new.rowid, new.id, new.title);
      END;

      CREATE TRIGGER conversations_au AFTER UPDATE ON conversations BEGIN
        DELETE FROM conversation_search WHERE rowid = old.rowid;
        INSERT INTO conversation_search(rowid, conversation_id, title)
        VALUES (new.rowid, new.id, new.title);
      END;

      CREATE TRIGGER conversations_ad AFTER DELETE ON conversations BEGIN
        DELETE FROM conversation_search WHERE rowid = old.rowid;
      END;
    `);

    // Column migration safety check for existing databases without 'summary'
    try {
      const columns = this.db.prepare(`PRAGMA table_info(conversations)`).all();
      if (!columns.some((c) => c.name === 'summary')) {
        this.db.exec(`ALTER TABLE conversations ADD COLUMN summary TEXT`);
      }
    } catch (_e) {
      // Ignore
    }

    this.db.exec(`
      DELETE FROM message_search;
      INSERT INTO message_search(rowid, message_id, conversation_id, content)
      SELECT rowid, id, conversation_id, content
      FROM messages;

      DELETE FROM conversation_search;
      INSERT INTO conversation_search(rowid, conversation_id, title)
      SELECT rowid, id, title
      FROM conversations;
    `);

    const insertSetting = this.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO NOTHING
    `);

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insertSetting.run(key, value);
    }

    const insertProfile = this.db.prepare(`
      INSERT INTO user_profile (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO NOTHING
    `);

    for (const [key, value] of Object.entries(DEFAULT_PROFILE)) {
      insertProfile.run(key, value);
    }
  }

  close() {
    this.db.close();
  }

  createConversation(title = DEFAULT_TITLE) {
    const timestamp = now();
    const conversation = {
      id: randomUUID(),
      title: title.trim() || DEFAULT_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastMessageAt: null,
    };

    this.db
      .prepare(`
        INSERT INTO conversations (id, title, created_at, updated_at, last_message_at)
        VALUES (@id, @title, @createdAt, @updatedAt, @lastMessageAt)
      `)
      .run(conversation);

    return conversation;
  }

  listConversations() {
    return this.db
      .prepare(`
        SELECT
          id,
          title,
          summary,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_message_at AS lastMessageAt
        FROM conversations
        ORDER BY COALESCE(last_message_at, updated_at) DESC
      `)
      .all();
  }

  getConversationSummary(conversationId) {
    return this.db
      .prepare(`
        SELECT
          id,
          title,
          summary,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_message_at AS lastMessageAt
        FROM conversations
        WHERE id = ?
      `)
      .get(conversationId);
  }

  updateConversationSummary(conversationId, summary) {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE conversations
        SET summary = @summary, updated_at = @timestamp
        WHERE id = @conversationId
      `)
      .run({ conversationId, summary, timestamp });
  }

  addUserMemory({ fact, category = 'general', conversationId = null }) {
    const trimmedFact = fact.trim();
    if (!trimmedFact) {
      throw new Error('Memory fact cannot be empty.');
    }
    const timestamp = now();
    const norm = normalizeFact(trimmedFact);

    // De-duplicate: if a memory with the same canonical fact already exists, refresh
    // it (touch updated_at, adopt a more specific category) instead of inserting a
    // near-duplicate. The table is small, so an in-memory scan is fine.
    const existing = this.db
      .prepare(`SELECT id, fact, category, source_conversation_id AS sourceConversationId, created_at AS createdAt FROM user_memories`)
      .all()
      .find((row) => normalizeFact(row.fact) === norm);

    if (existing) {
      const nextCategory = category && category.trim() ? category.trim() : existing.category;
      // Repeating a fact reinforces it rather than duplicating it — recurrence is
      // evidence of importance, which ranking uses to favour established facts.
      this.db
        .prepare(`
          UPDATE user_memories
          SET updated_at = ?, category = ?, reinforced_count = COALESCE(reinforced_count, 1) + 1
          WHERE id = ?
        `)
        .run(timestamp, nextCategory, existing.id);
      return {
        id: existing.id,
        fact: existing.fact,
        category: nextCategory,
        sourceConversationId: existing.sourceConversationId,
        createdAt: existing.createdAt,
        updatedAt: timestamp,
        deduped: true,
      };
    }

    const memory = {
      id: randomUUID(),
      fact: trimmedFact,
      category: category.trim() || 'general',
      sourceConversationId: conversationId || null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.db
      .prepare(`
        INSERT INTO user_memories (id, fact, category, source_conversation_id, created_at, updated_at)
        VALUES (@id, @fact, @category, @sourceConversationId, @createdAt, @updatedAt)
      `)
      .run(memory);

    return memory;
  }

  // Active memories only — superseded facts are retained for history but must never
  // reach the model, or the assistant would act on knowledge the user has replaced.
  listUserMemories({ includeSuperseded = false } = {}) {
    const where = includeSuperseded ? '' : 'WHERE superseded_by IS NULL';
    return this.db
      .prepare(`
        SELECT
          id,
          fact,
          category,
          source_conversation_id AS sourceConversationId,
          superseded_by AS supersededBy,
          superseded_at AS supersededAt,
          COALESCE(reinforced_count, 1) AS reinforcedCount,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM user_memories
        ${where}
        ORDER BY updated_at DESC
      `)
      .all();
  }

  updateUserMemory({ id, fact, category }) {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE user_memories
        SET fact = COALESCE(@fact, fact),
            category = COALESCE(@category, category),
            updated_at = @timestamp
        WHERE id = @id
      `)
      .run({ id, fact: fact ?? null, category: category ?? null, timestamp });
    return this.db
      .prepare(`
        SELECT id, fact, category, source_conversation_id AS sourceConversationId,
               superseded_by AS supersededBy, COALESCE(reinforced_count, 1) AS reinforcedCount,
               created_at AS createdAt, updated_at AS updatedAt
        FROM user_memories WHERE id = ?
      `)
      .get(id);
  }

  // Retire `oldId` in favour of `newId`. The old fact stays on record (auditable)
  // but is excluded from retrieval.
  supersedeUserMemory(oldId, newId) {
    const result = this.db
      .prepare(`UPDATE user_memories SET superseded_by = ?, superseded_at = ? WHERE id = ? AND superseded_by IS NULL`)
      .run(newId, now(), oldId);
    return result.changes > 0;
  }

  deleteUserMemory(id) {
    const result = this.db.prepare(`DELETE FROM user_memories WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  saveMessageEmbedding({ messageId, conversationId, chunkText, embedding, embeddingModel = null }) {
    assertValidEmbedding(embedding);
    const timestamp = now();
    const id = randomUUID();
    const embeddingJson = JSON.stringify(embedding);

    this.db
      .prepare(`
        INSERT INTO message_embeddings
          (id, message_id, conversation_id, chunk_text, embedding_json, embedding_model, embedding_dim, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, messageId, conversationId, chunkText, embeddingJson, embeddingModel, embedding.length, timestamp);
  }

  searchVectorMemory(queryEmbedding, limit = 5, currentConversationId = null) {
    if (!queryEmbedding || !queryEmbedding.length) {
      return [];
    }

    // Only compare against vectors of the same dimension. Rows from a different
    // embedding model (or legacy rows with NULL dim) can never match meaningfully
    // and are excluded here rather than silently scored 0 (invariant #4).
    const dim = queryEmbedding.length;

    let rows;
    if (currentConversationId) {
      rows = this.db
        .prepare(`
          SELECT conversation_id, chunk_text, embedding_json
          FROM message_embeddings
          WHERE conversation_id != ? AND embedding_dim = ?
        `)
        .all(currentConversationId, dim);
    } else {
      rows = this.db
        .prepare(`
          SELECT conversation_id, chunk_text, embedding_json
          FROM message_embeddings
          WHERE embedding_dim = ?
        `)
        .all(dim);
    }

    const scored = rows
      .map((row) => {
        try {
          const vec = JSON.parse(row.embedding_json);
          const score = cosineSimilarity(queryEmbedding, vec);
          return {
            conversationId: row.conversation_id,
            chunkText: row.chunk_text,
            score,
          };
        } catch (_e) {
          return null;
        }
      })
      .filter(Boolean)
      .filter((item) => item.score > 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  listMessages(conversationId) {
    return this.db
      .prepare(`
        SELECT
          id,
          conversation_id AS conversationId,
          role,
          content,
          status,
          expert_id AS expertId,
          expert_name AS expertName,
          round,
          turn_kind AS turnKind,
          created_at AS createdAt
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(conversationId);
  }

  getConversation(conversationId) {
    const conversation = this.getConversationSummary(conversationId);
    if (!conversation) {
      return null;
    }

    return {
      ...conversation,
      messages: this.listMessages(conversationId),
    };
  }

  addMessage({
    conversationId,
    role,
    content,
    status = 'complete',
    // Roundtable attribution: which Expert spoke, in which round, and whether this
    // was an Expert turn or the moderator's synthesis (null for ordinary chat).
    expertId = null,
    expertName = null,
    round = null,
    turnKind = null,
  }) {
    const timestamp = now();
    const message = {
      id: randomUUID(),
      conversationId,
      role,
      content: content.trim(),
      status,
      expertId,
      expertName,
      round,
      turnKind,
      createdAt: timestamp,
    };

    this.db
      .prepare(`
        INSERT INTO messages
          (id, conversation_id, role, content, status, expert_id, expert_name, round, turn_kind, created_at)
        VALUES (@id, @conversationId, @role, @content, @status, @expertId, @expertName, @round, @turnKind, @createdAt)
      `)
      .run(message);

    this.db
      .prepare(`
        UPDATE conversations
        SET
          updated_at = @timestamp,
          last_message_at = @timestamp
        WHERE id = @conversationId
      `)
      .run({ conversationId, timestamp });

    return message;
  }

  maybeAutoTitleConversation(conversationId, content) {
    const conversation = this.getConversationSummary(conversationId);
    if (!conversation || conversation.title !== DEFAULT_TITLE) {
      return conversation;
    }

    const title = createAutoTitle(content);
    this.renameConversation(conversationId, title);
    return this.getConversationSummary(conversationId);
  }

  renameConversation(conversationId, title) {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      throw new Error('Conversation title cannot be empty.');
    }

    const timestamp = now();
    this.db
      .prepare(`
        UPDATE conversations
        SET
          title = @title,
          updated_at = @timestamp
        WHERE id = @conversationId
      `)
      .run({ conversationId, title: trimmedTitle, timestamp });

    return this.getConversationSummary(conversationId);
  }

  deleteConversation(conversationId) {
    const result = this.db
      .prepare(`DELETE FROM conversations WHERE id = ?`)
      .run(conversationId);

    return result.changes > 0;
  }

  searchConversations(query) {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return this.listConversations();
    }

    const ftsQuery = toFtsQuery(trimmedQuery);
    try {
      return this.db
        .prepare(`
          WITH ranked_results AS (
            SELECT
              c.id,
              c.title,
              c.created_at AS createdAt,
              c.updated_at AS updatedAt,
              c.last_message_at AS lastMessageAt,
              snippet(message_search, 2, '[', ']', '...', 10) AS snippet,
              bm25(message_search) AS rank
            FROM message_search
            JOIN conversations c ON c.id = message_search.conversation_id
            WHERE message_search MATCH @ftsQuery

            UNION ALL

            SELECT
              c.id,
              c.title,
              c.created_at AS createdAt,
              c.updated_at AS updatedAt,
              c.last_message_at AS lastMessageAt,
              snippet(conversation_search, 1, '[', ']', '...', 10) AS snippet,
              bm25(conversation_search) - 1 AS rank
            FROM conversation_search
            JOIN conversations c ON c.id = conversation_search.conversation_id
            WHERE conversation_search MATCH @ftsQuery
          )
          SELECT
            id,
            title,
            createdAt,
            updatedAt,
            lastMessageAt,
            snippet
          FROM ranked_results
          GROUP BY id
          ORDER BY MIN(rank), COALESCE(lastMessageAt, updatedAt) DESC
        `)
        .all({ ftsQuery });
    } catch (error) {
      return this.db
        .prepare(`
          SELECT
            c.id,
            c.title,
            c.created_at AS createdAt,
            c.updated_at AS updatedAt,
            c.last_message_at AS lastMessageAt,
            m.content AS snippet
          FROM conversations c
          LEFT JOIN messages m ON m.conversation_id = c.id
          WHERE c.title LIKE @likeQuery OR m.content LIKE @likeQuery
          GROUP BY c.id
          ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC
        `)
        .all({ likeQuery: `%${trimmedQuery}%` });
    }
  }

  exportConversation(conversationId) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) {
      return null;
    }

    return {
      exportedAt: now(),
      conversation,
    };
  }

  // Full-corpus export. Unlike a chat-history dump, this includes everything that
  // makes the app valuable and is otherwise unrecoverable: memories, profile,
  // Specialist hubs AND their vector chunks (ROADMAP §3 invariant #3). Settings are
  // intentionally excluded — they are re-enterable config and contain secrets
  // (API keys). The envelope is versioned so a future import can adapt.
  exportAll() {
    const hubs = this.listSpecialistHubs().map((hub) => ({
      ...hub,
      chunks: this.listSpecialistChunksForExport(hub.id),
    }));

    return {
      app: 'sidekick-llm',
      kind: 'corpus-export',
      schemaVersion: this.getSchemaVersion(),
      exportedAt: now(),
      conversations: this.listConversations().map((conversation) => ({
        ...conversation,
        messages: this.listMessages(conversation.id),
      })),
      userMemories: this.listUserMemories(),
      userProfile: this.getUserProfile(),
      specialistHubs: hubs,
    };
  }

  // Raw chunk rows for a hub, including the stored embedding JSON, for export.
  // ---- Expert Packs --------------------------------------------------------------
  // A portable, versioned export of ONE Expert: persona, vault chunks (with their
  // citation provenance), and notes. Shareable, backup-able, and the unit a
  // marketplace would distribute (ROADMAP §5a / Stage 7).
  //
  // The manifest records which embedding model built the vectors, because importing
  // a pack onto a machine using a different embedding model yields chunks that are
  // present but unretrievable — the exact silent failure the embedding contract
  // exists to prevent. Import surfaces the mismatch and offers a re-index.
  exportExpertPack(hubId) {
    const hub = this.getSpecialistHub(hubId);
    if (!hub) {
      return null;
    }

    const chunks = this.listSpecialistChunksForExport(hubId);
    const embeddingModels = [...new Set(chunks.map((c) => c.embeddingModel).filter(Boolean))];

    return {
      app: 'sidekick-llm',
      kind: 'expert-pack',
      packVersion: 1,
      schemaVersion: this.getSchemaVersion(),
      exportedAt: now(),
      manifest: {
        name: hub.name,
        chunkCount: chunks.length,
        noteCount: this.countNotes(hubId),
        embeddingModels,
        // Distinct source documents/URLs, so a recipient can see what it was built
        // from before importing it.
        sources: [...new Set(chunks.map((c) => c.sourceTitle).filter(Boolean))].slice(0, 200),
      },
      expert: {
        name: hub.name,
        description: hub.description,
        systemPrompt: hub.systemPrompt,
        icon: hub.icon,
      },
      chunks,
      notes: this.listNotes(hubId),
    };
  }

  // Installs a pack as a NEW Expert. Ids are regenerated so a pack can be installed
  // more than once and can never collide with an existing Expert.
  importExpertPack(pack, { nameSuffix = '' } = {}) {
    if (!pack || pack.app !== 'sidekick-llm' || pack.kind !== 'expert-pack') {
      throw new Error('That file is not a Sidekick Expert Pack.');
    }
    if (!pack.expert || !pack.expert.name) {
      throw new Error('Expert Pack is missing its expert definition.');
    }

    const currentEmbeddingModel = this.getSetting('embeddingModel');
    const packModels = (pack.manifest && pack.manifest.embeddingModels) || [];
    const retrievable = packModels.length === 0 || packModels.includes(currentEmbeddingModel);

    const hub = this.createSpecialistHub({
      name: `${pack.expert.name}${nameSuffix}`,
      description: pack.expert.description || '',
      systemPrompt: pack.expert.systemPrompt || '',
      icon: pack.expert.icon || 'brain',
    });

    const insertChunk = this.db.prepare(`
      INSERT INTO specialist_chunks
        (id, hub_id, source_title, source_url, chunk_text, embedding_json, embedding_model, embedding_dim,
         location, page, char_start, char_end, source_type, created_at)
      VALUES (@id, @hubId, @sourceTitle, @sourceUrl, @chunkText, @embeddingJson, @embeddingModel, @embeddingDim,
         @location, @page, @charStart, @charEnd, @sourceType, @createdAt)
    `);
    const insertNote = this.db.prepare(`
      INSERT INTO notes (id, hub_id, title, body, author, source_conversation_id, created_at, updated_at)
      VALUES (@id, @hubId, @title, @body, @author, NULL, @createdAt, @updatedAt)
    `);

    let chunksImported = 0;
    let notesImported = 0;
    const timestamp = now();

    const run = this.db.transaction(() => {
      for (const chunk of pack.chunks || []) {
        if (!chunk.chunkText || !chunk.embeddingJson) continue;
        insertChunk.run({
          id: randomUUID(),
          hubId: hub.id,
          sourceTitle: chunk.sourceTitle || 'Imported source',
          sourceUrl: chunk.sourceUrl || '',
          chunkText: chunk.chunkText,
          embeddingJson: chunk.embeddingJson,
          embeddingModel: chunk.embeddingModel ?? null,
          embeddingDim: chunk.embeddingDim ?? null,
          location: chunk.location ?? null,
          page: chunk.page ?? null,
          charStart: chunk.charStart ?? null,
          charEnd: chunk.charEnd ?? null,
          sourceType: chunk.sourceType ?? null,
          createdAt: chunk.createdAt || timestamp,
        });
        chunksImported += 1;
      }

      for (const note of pack.notes || []) {
        if (!note.body) continue;
        insertNote.run({
          id: randomUUID(),
          hubId: hub.id,
          title: note.title || note.body.slice(0, 60),
          body: note.body,
          author: note.author || 'user',
          createdAt: note.createdAt || timestamp,
          updatedAt: note.updatedAt || timestamp,
        });
        notesImported += 1;
      }
    });

    run();

    return {
      hub: this.getSpecialistHub(hub.id),
      chunksImported,
      notesImported,
      // Honest reporting: say plainly when the imported vault will not retrieve
      // until it is re-indexed with the local embedding model.
      retrievable,
      packEmbeddingModels: packModels,
      currentEmbeddingModel,
    };
  }

  listSpecialistChunksForExport(hubId) {
    return this.db
      .prepare(`
        SELECT
          id,
          hub_id AS hubId,
          source_title AS sourceTitle,
          source_url AS sourceUrl,
          chunk_text AS chunkText,
          embedding_json AS embeddingJson,
          embedding_model AS embeddingModel,
          embedding_dim AS embeddingDim,
          location,
          page,
          char_start AS charStart,
          char_end AS charEnd,
          source_type AS sourceType,
          created_at AS createdAt
        FROM specialist_chunks
        WHERE hub_id = ?
        ORDER BY created_at ASC
      `)
      .all(hubId);
  }

  // Restore a corpus export into this database. Idempotent: existing rows (matched
  // by primary key) are left untouched via INSERT OR IGNORE, so importing the same
  // file twice, or merging into a populated database, never duplicates or clobbers.
  // Runs in a single transaction — a malformed payload rolls back cleanly.
  // Returns per-entity counts of rows actually inserted.
  importAll(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Import payload is not a valid object.');
    }

    const counts = { conversations: 0, messages: 0, userMemories: 0, specialistHubs: 0, specialistChunks: 0 };

    const insertConversation = this.db.prepare(`
      INSERT OR IGNORE INTO conversations (id, title, summary, created_at, updated_at, last_message_at)
      VALUES (@id, @title, @summary, @createdAt, @updatedAt, @lastMessageAt)
    `);
    const insertMessage = this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, conversation_id, role, content, status, created_at)
      VALUES (@id, @conversationId, @role, @content, @status, @createdAt)
    `);
    const insertMemory = this.db.prepare(`
      INSERT OR IGNORE INTO user_memories (id, fact, category, source_conversation_id, created_at, updated_at)
      VALUES (@id, @fact, @category, @sourceConversationId, @createdAt, @updatedAt)
    `);
    const insertHub = this.db.prepare(`
      INSERT OR IGNORE INTO specialist_hubs (id, name, description, system_prompt, icon, created_at, updated_at)
      VALUES (@id, @name, @description, @systemPrompt, @icon, @createdAt, @updatedAt)
    `);
    const insertChunk = this.db.prepare(`
      INSERT OR IGNORE INTO specialist_chunks
        (id, hub_id, source_title, source_url, chunk_text, embedding_json, embedding_model, embedding_dim,
         location, page, char_start, char_end, source_type, created_at)
      VALUES (@id, @hubId, @sourceTitle, @sourceUrl, @chunkText, @embeddingJson, @embeddingModel, @embeddingDim,
         @location, @page, @charStart, @charEnd, @sourceType, @createdAt)
    `);
    const insertProfile = this.db.prepare(`
      INSERT INTO user_profile (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    const run = this.db.transaction(() => {
      for (const conversation of payload.conversations || []) {
        const res = insertConversation.run({
          id: conversation.id,
          title: conversation.title,
          summary: conversation.summary ?? null,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          lastMessageAt: conversation.lastMessageAt ?? null,
        });
        counts.conversations += res.changes;

        for (const message of conversation.messages || []) {
          const mres = insertMessage.run({
            id: message.id,
            conversationId: conversation.id,
            role: message.role,
            content: message.content,
            status: message.status || 'complete',
            createdAt: message.createdAt,
          });
          counts.messages += mres.changes;
        }
      }

      for (const memory of payload.userMemories || []) {
        const res = insertMemory.run({
          id: memory.id,
          fact: memory.fact,
          category: memory.category || 'general',
          sourceConversationId: memory.sourceConversationId ?? null,
          createdAt: memory.createdAt,
          updatedAt: memory.updatedAt,
        });
        counts.userMemories += res.changes;
      }

      for (const hub of payload.specialistHubs || []) {
        const res = insertHub.run({
          id: hub.id,
          name: hub.name,
          description: hub.description ?? '',
          systemPrompt: hub.systemPrompt ?? '',
          icon: hub.icon || 'brain',
          createdAt: hub.createdAt,
          updatedAt: hub.updatedAt,
        });
        counts.specialistHubs += res.changes;

        for (const chunk of hub.chunks || []) {
          const cres = insertChunk.run({
            id: chunk.id,
            hubId: hub.id,
            sourceTitle: chunk.sourceTitle,
            sourceUrl: chunk.sourceUrl ?? '',
            chunkText: chunk.chunkText,
            embeddingJson: chunk.embeddingJson,
            embeddingModel: chunk.embeddingModel ?? null,
            embeddingDim: chunk.embeddingDim ?? null,
            location: chunk.location ?? null,
            page: chunk.page ?? null,
            charStart: chunk.charStart ?? null,
            charEnd: chunk.charEnd ?? null,
            sourceType: chunk.sourceType ?? null,
            createdAt: chunk.createdAt,
          });
          counts.specialistChunks += cres.changes;
        }
      }

      if (payload.userProfile && typeof payload.userProfile === 'object') {
        for (const [key, value] of Object.entries(payload.userProfile)) {
          insertProfile.run(key, String(value ?? ''));
        }
      }
    });

    run();
    return counts;
  }

  getSetting(key) {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
    return row ? row.value : null;
  }

  getAllSettings() {
    const rows = this.db.prepare(`SELECT key, value FROM settings`).all();
    const settings = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  setSetting(key, value) {
    this.db
      .prepare(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, String(value));
  }

  // Profile Methods
  getUserProfile() {
    const rows = this.db.prepare(`SELECT key, value FROM user_profile`).all();
    const profile = { ...DEFAULT_PROFILE };
    for (const row of rows) {
      profile[row.key] = row.value;
    }
    return profile;
  }

  setUserProfile(profileObj) {
    const stmt = this.db.prepare(`
      INSERT INTO user_profile (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    for (const [key, value] of Object.entries(profileObj)) {
      stmt.run(key, String(value ?? ''));
    }
    return this.getUserProfile();
  }

  // Specialist Hub Methods.
  //
  // Every hub reports two counts:
  //   chunkCount            — total stored chunks
  //   retrievableChunkCount — chunks embedded with the CURRENTLY configured
  //                           embedding model, i.e. the ones retrieval can actually
  //                           match. When these diverge, some chunks were embedded
  //                           with a different (or no) model and are dead until
  //                           re-indexed (Phase 4). The UI uses the gap to warn and
  //                           to offer re-indexing (ROADMAP §5 Phase 3/4).
  listSpecialistHubs() {
    const embeddingModel = this.getSetting('embeddingModel');
    return this.db
      .prepare(`
        SELECT
          h.id,
          h.name,
          h.description,
          h.system_prompt AS systemPrompt,
          h.icon,
          h.created_at AS createdAt,
          h.updated_at AS updatedAt,
          (SELECT COUNT(*) FROM specialist_chunks sc WHERE sc.hub_id = h.id) AS chunkCount,
          (SELECT COUNT(*) FROM specialist_chunks sc
             WHERE sc.hub_id = h.id AND sc.embedding_model = @embeddingModel) AS retrievableChunkCount
        FROM specialist_hubs h
        ORDER BY h.updated_at DESC
      `)
      .all({ embeddingModel });
  }

  getSpecialistHub(id) {
    const hub = this.db
      .prepare(`
        SELECT
          id,
          name,
          description,
          system_prompt AS systemPrompt,
          icon,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM specialist_hubs
        WHERE id = ?
      `)
      .get(id);
    if (!hub) return null;
    const embeddingModel = this.getSetting('embeddingModel');
    const chunkCount = this.db
      .prepare(`SELECT COUNT(*) as count FROM specialist_chunks WHERE hub_id = ?`)
      .get(id).count;
    const retrievableChunkCount = this.db
      .prepare(`SELECT COUNT(*) as count FROM specialist_chunks WHERE hub_id = ? AND embedding_model = ?`)
      .get(id, embeddingModel).count;
    return { ...hub, chunkCount, retrievableChunkCount };
  }

  createSpecialistHub({ name, description = '', systemPrompt = '', icon = 'brain' }) {
    const timestamp = now();
    const hub = {
      id: randomUUID(),
      name: name.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      icon: icon || 'brain',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.db
      .prepare(`
        INSERT INTO specialist_hubs (id, name, description, system_prompt, icon, created_at, updated_at)
        VALUES (@id, @name, @description, @systemPrompt, @icon, @createdAt, @updatedAt)
      `)
      .run(hub);

    return { ...hub, chunkCount: 0 };
  }

  updateSpecialistHub({ id, name, description, systemPrompt, icon }) {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE specialist_hubs
        SET
          name = COALESCE(@name, name),
          description = COALESCE(@description, description),
          system_prompt = COALESCE(@systemPrompt, system_prompt),
          icon = COALESCE(@icon, icon),
          updated_at = @timestamp
        WHERE id = @id
      `)
      .run({ id, name, description, systemPrompt, icon, timestamp });

    return this.getSpecialistHub(id);
  }

  deleteSpecialistHub(id) {
    const result = this.db.prepare(`DELETE FROM specialist_hubs WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  saveSpecialistChunk({
    hubId,
    sourceTitle,
    sourceUrl = '',
    chunkText,
    embedding,
    embeddingModel = null,
    // Citation provenance (optional; legacy/unknown sources pass none).
    location = null,
    page = null,
    charStart = null,
    charEnd = null,
    sourceType = null,
  }) {
    assertValidEmbedding(embedding);
    const timestamp = now();
    const id = randomUUID();
    const embeddingJson = JSON.stringify(embedding);

    this.db
      .prepare(`
        INSERT INTO specialist_chunks
          (id, hub_id, source_title, source_url, chunk_text, embedding_json, embedding_model, embedding_dim,
           location, page, char_start, char_end, source_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, hubId, sourceTitle, sourceUrl, chunkText, embeddingJson, embeddingModel, embedding.length,
        location, page, charStart, charEnd, sourceType, timestamp,
      );

    // Update hub timestamp
    this.db
      .prepare(`UPDATE specialist_hubs SET updated_at = ? WHERE id = ?`)
      .run(timestamp, hubId);
  }

  // Chunks that need re-embedding for the given (current) model: everything not
  // already embedded with it — legacy NULL-model rows and rows from a previously
  // configured model. Returns id + chunk_text so the worker can re-embed in place.
  listChunksForReindex(hubId, embeddingModel) {
    return this.db
      .prepare(`
        SELECT id, chunk_text AS chunkText
        FROM specialist_chunks
        WHERE hub_id = ?
          AND (embedding_model IS NULL OR embedding_model != ?)
        ORDER BY created_at ASC
      `)
      .all(hubId, embeddingModel);
  }

  // Overwrite a single chunk's vector in place (used by re-indexing). Enforces the
  // same write-boundary contract as inserts (invariant #4).
  updateChunkEmbedding(chunkId, embedding, embeddingModel) {
    assertValidEmbedding(embedding);
    this.db
      .prepare(`
        UPDATE specialist_chunks
        SET embedding_json = ?, embedding_model = ?, embedding_dim = ?
        WHERE id = ?
      `)
      .run(JSON.stringify(embedding), embeddingModel, embedding.length, chunkId);
  }

  // ---- Audit log ----------------------------------------------------------------
  // Append-only record of sensitive actions. Each row's hash covers the previous
  // row's hash, so deleting or editing any entry breaks verification from that point
  // forward — the log is tamper-EVIDENT (you can tell), not tamper-proof (you cannot
  // be prevented). That is the honest guarantee, and it is what a compliance story
  // actually needs.
  appendAudit({ action, detail = null }) {
    if (!action) return null;
    try {
      const at = now();
      const prev = this.db
        .prepare(`SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1`)
        .get();
      const prevHash = prev ? prev.hash : '';
      const payload = `${prevHash}|${at}|${action}|${detail == null ? '' : String(detail)}`;
      const hash = createHash('sha256').update(payload).digest('hex');

      this.db
        .prepare(`
          INSERT INTO audit_log (at, action, detail, prev_hash, hash)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(at, action, detail == null ? null : String(detail), prevHash || null, hash);

      return { at, action, detail, hash };
    } catch (error) {
      // Auditing must never break the action it is recording.
      console.error('Audit append failed:', error.message);
      return null;
    }
  }

  listAudit({ limit = 200, offset = 0 } = {}) {
    return this.db
      .prepare(`
        SELECT seq, at, action, detail, prev_hash AS prevHash, hash
        FROM audit_log
        ORDER BY seq DESC
        LIMIT @limit OFFSET @offset
      `)
      .all({ limit, offset });
  }

  countAudit() {
    return this.db.prepare(`SELECT COUNT(*) AS count FROM audit_log`).get().count;
  }

  // Recomputes the chain from the beginning. Returns the first sequence number where
  // the log stops verifying, or null when the whole chain is intact.
  verifyAuditChain() {
    const rows = this.db
      .prepare(`SELECT seq, at, action, detail, prev_hash AS prevHash, hash FROM audit_log ORDER BY seq ASC`)
      .all();

    let expectedPrev = '';
    for (const row of rows) {
      const payload = `${expectedPrev}|${row.at}|${row.action}|${row.detail == null ? '' : row.detail}`;
      const hash = createHash('sha256').update(payload).digest('hex');
      if (hash !== row.hash || (row.prevHash || '') !== expectedPrev) {
        return { ok: false, entries: rows.length, brokenAt: row.seq };
      }
      expectedPrev = row.hash;
    }

    return { ok: true, entries: rows.length, brokenAt: null };
  }

  // ---- Notes -------------------------------------------------------------------
  // A note is an editable source document owned by the user. Its retrievable
  // projection lives in specialist_chunks (source_type='note', source_url
  // 'note://<id>'), which the worker rebuilds whenever the note text changes.

  createNote({ hubId, title, body, author = 'user', conversationId = null }) {
    const trimmedBody = (body || '').trim();
    if (!trimmedBody) {
      throw new Error('Note body cannot be empty.');
    }
    const timestamp = now();
    const note = {
      id: randomUUID(),
      hubId,
      title: (title || '').trim() || trimmedBody.slice(0, 60),
      body: trimmedBody,
      author,
      sourceConversationId: conversationId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.db
      .prepare(`
        INSERT INTO notes (id, hub_id, title, body, author, source_conversation_id, created_at, updated_at)
        VALUES (@id, @hubId, @title, @body, @author, @sourceConversationId, @createdAt, @updatedAt)
      `)
      .run(note);

    this.db.prepare(`UPDATE specialist_hubs SET updated_at = ? WHERE id = ?`).run(timestamp, hubId);
    return note;
  }

  listNotes(hubId) {
    return this.db
      .prepare(`
        SELECT
          id, hub_id AS hubId, title, body, author,
          source_conversation_id AS sourceConversationId,
          created_at AS createdAt, updated_at AS updatedAt
        FROM notes
        WHERE hub_id = ?
        ORDER BY updated_at DESC
      `)
      .all(hubId);
  }

  getNote(id) {
    return this.db
      .prepare(`
        SELECT
          id, hub_id AS hubId, title, body, author,
          source_conversation_id AS sourceConversationId,
          created_at AS createdAt, updated_at AS updatedAt
        FROM notes WHERE id = ?
      `)
      .get(id);
  }

  updateNote({ id, title, body }) {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE notes
        SET title = COALESCE(@title, title),
            body = COALESCE(@body, body),
            updated_at = @timestamp
        WHERE id = @id
      `)
      .run({ id, title: title ?? null, body: body ?? null, timestamp });
    return this.getNote(id);
  }

  // Removing a note also removes its retrievable chunks, so deleted insight stops
  // influencing answers immediately.
  deleteNote(id) {
    const note = this.getNote(id);
    if (!note) return false;
    this.deleteNoteChunks(id);
    const result = this.db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  deleteNoteChunks(noteId) {
    this.db.prepare(`DELETE FROM specialist_chunks WHERE source_url = ?`).run(`note://${noteId}`);
  }

  countNotes(hubId) {
    return this.db.prepare(`SELECT COUNT(*) AS count FROM notes WHERE hub_id = ?`).get(hubId).count;
  }

  // Broad sample of a hub's chunks for aggregation ("what does this Expert say about
  // X overall?"). Top-k similarity cannot survey a corpus — it returns the k most
  // similar passages, not a representative spread — so aggregation walks the whole
  // vault. Evenly strided so the sample spans the corpus rather than one document.
  sampleHubChunks(hubId, maxChunks = 60) {
    const total = this.db
      .prepare(`SELECT COUNT(*) AS count FROM specialist_chunks WHERE hub_id = ?`)
      .get(hubId).count;
    if (total === 0) return { total: 0, chunks: [] };

    const stride = Math.max(1, Math.ceil(total / maxChunks));
    const chunks = this.db
      .prepare(`
        SELECT chunk_text AS chunkText, source_title AS sourceTitle, source_url AS sourceUrl,
               location, page, source_type AS sourceType
        FROM (
          SELECT *, ROW_NUMBER() OVER (ORDER BY source_title, page, char_start, rowid) AS rn
          FROM specialist_chunks WHERE hub_id = ?
        )
        WHERE (rn - 1) % @stride = 0
        LIMIT @maxChunks
      `)
      .all(hubId, { stride, maxChunks });

    return { total, chunks };
  }

  // Lexical (BM25) search over a hub's chunks. Complements vector search: exact
  // terms — clause numbers, drug names, API symbols, error codes — are precisely
  // what embeddings blur and what BM25 nails. Returns the same shape as the vector
  // search so the two can be fused (see electron/retrieval.cjs fuseHybrid).
  searchSpecialistKeyword(hubId, query, limit = 8) {
    if (!hubId || !query || !query.trim()) {
      return [];
    }

    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];

    try {
      return this.db
        .prepare(`
          SELECT
            c.id AS chunkId,
            c.hub_id AS hubId,
            c.source_title AS sourceTitle,
            c.source_url AS sourceUrl,
            c.chunk_text AS chunkText,
            c.location,
            c.page,
            c.char_start AS charStart,
            c.char_end AS charEnd,
            c.source_type AS sourceType,
            bm25(specialist_chunk_search) AS rank
          FROM specialist_chunk_search
          JOIN specialist_chunks c ON c.id = specialist_chunk_search.chunk_id
          WHERE specialist_chunk_search MATCH @ftsQuery
            AND specialist_chunk_search.hub_id = @hubId
          ORDER BY rank
          LIMIT @limit
        `)
        .all({ ftsQuery, hubId, limit });
    } catch (_error) {
      // A malformed FTS expression must never break retrieval; vector search alone
      // still answers.
      return [];
    }
  }

  searchSpecialistVectorMemory(hubId, queryEmbedding, limit = 5, embeddingModel = null) {
    if (!hubId || !queryEmbedding || !queryEmbedding.length) {
      return [];
    }

    // Restrict to vectors of the same dimension as the query. When the embedding
    // model is known, also require it to match: a chunk from a different model
    // lives in a different vector space and its similarity would be meaningless
    // even at the same dimension (invariant #4).
    const dim = queryEmbedding.length;
    const columns = `id, hub_id, source_title, source_url, chunk_text, embedding_json,
                     location, page, char_start, char_end, source_type`;
    const rows = embeddingModel
      ? this.db
          .prepare(`
            SELECT ${columns}
            FROM specialist_chunks
            WHERE hub_id = ? AND embedding_dim = ? AND embedding_model = ?
          `)
          .all(hubId, dim, embeddingModel)
      : this.db
          .prepare(`
            SELECT ${columns}
            FROM specialist_chunks
            WHERE hub_id = ? AND embedding_dim = ?
          `)
          .all(hubId, dim);

    const scored = rows
      .map((row) => {
        try {
          const vec = JSON.parse(row.embedding_json);
          const score = cosineSimilarity(queryEmbedding, vec);
          return {
            chunkId: row.id,
            hubId: row.hub_id,
            sourceTitle: row.source_title,
            sourceUrl: row.source_url,
            chunkText: row.chunk_text,
            // Citation provenance — carried through so source cards can be rendered
            // from the retrieved chunk itself rather than parsed out of model text.
            location: row.location,
            page: row.page,
            charStart: row.char_start,
            charEnd: row.char_end,
            sourceType: row.source_type,
            score,
          };
        } catch (_e) {
          return null;
        }
      })
      .filter(Boolean)
      .filter((item) => item.score > 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  updateMessageContent(messageId, newContent) {
    const timestamp = now();
    this.db
      .prepare(`UPDATE messages SET content = ? WHERE id = ?`)
      .run(newContent.trim(), messageId);
  }

  deleteMessagesAfter(conversationId, messageId) {
    const target = this.db
      .prepare(`SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?`)
      .get(messageId, conversationId);

    if (target) {
      this.db
        .prepare(`DELETE FROM messages WHERE conversation_id = ? AND rowid >= ?`)
        .run(conversationId, target.rowid);
    }
  }
}

module.exports = {
  ConversationRepository,
  DEFAULT_TITLE,
  DEFAULT_SETTINGS,
  DEFAULT_PROFILE,
  SCHEMA_VERSION,
  createAutoTitle,
};


