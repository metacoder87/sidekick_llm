const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { randomUUID } = require('node:crypto');

// The current target schema version. Bump this and append a migration to
// MIGRATIONS whenever the schema changes. The corpus is the project's asset
// (see ROADMAP.md §3) — every migration runs behind a backup and an integrity
// check so a bad upgrade can never destroy user data.
const SCHEMA_VERSION = 3;
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
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        fact TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        source_conversation_id TEXT,
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
      this.db
        .prepare(`UPDATE user_memories SET updated_at = ?, category = ? WHERE id = ?`)
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

  listUserMemories() {
    return this.db
      .prepare(`
        SELECT
          id,
          fact,
          category,
          source_conversation_id AS sourceConversationId,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM user_memories
        ORDER BY updated_at DESC
      `)
      .all();
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

  addMessage({ conversationId, role, content, status = 'complete' }) {
    const timestamp = now();
    const message = {
      id: randomUUID(),
      conversationId,
      role,
      content: content.trim(),
      status,
      createdAt: timestamp,
    };

    this.db
      .prepare(`
        INSERT INTO messages (id, conversation_id, role, content, status, created_at)
        VALUES (@id, @conversationId, @role, @content, @status, @createdAt)
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


