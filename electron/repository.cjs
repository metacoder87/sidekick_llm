const Database = require('better-sqlite3');
const { randomUUID } = require('node:crypto');

const DEFAULT_TITLE = 'New conversation';
const DEFAULT_SETTINGS = {
  ollamaBaseUrl: 'http://localhost:11434',
  webSearchEnabled: 'false',
  searchProvider: 'duckduckgo',
  searxngUrl: '',
  tavilyApiKey: '',
  braveApiKey: '',
  autoMemoryEnabled: 'true',
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
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
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

  saveMessageEmbedding({ messageId, conversationId, chunkText, embedding }) {
    const timestamp = now();
    const id = randomUUID();
    const embeddingJson = JSON.stringify(embedding);

    this.db
      .prepare(`
        INSERT INTO message_embeddings (id, message_id, conversation_id, chunk_text, embedding_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(id, messageId, conversationId, chunkText, embeddingJson, timestamp);
  }

  searchVectorMemory(queryEmbedding, limit = 5, currentConversationId = null) {
    if (!queryEmbedding || !queryEmbedding.length) {
      return [];
    }

    let rows;
    if (currentConversationId) {
      rows = this.db
        .prepare(`
          SELECT conversation_id, chunk_text, embedding_json
          FROM message_embeddings
          WHERE conversation_id != ?
        `)
        .all(currentConversationId);
    } else {
      rows = this.db
        .prepare(`
          SELECT conversation_id, chunk_text, embedding_json
          FROM message_embeddings
        `)
        .all();
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

  exportAll() {
    return {
      exportedAt: now(),
      conversations: this.listConversations().map((conversation) => ({
        ...conversation,
        messages: this.listMessages(conversation.id),
      })),
    };
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

  saveMessageEmbedding({ messageId, conversationId, chunkText, embedding }) {
    const timestamp = now();
    const id = randomUUID();
    const embeddingJson = JSON.stringify(embedding);

    this.db
      .prepare(`
        INSERT INTO message_embeddings (id, message_id, conversation_id, chunk_text, embedding_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(id, messageId, conversationId, chunkText, embeddingJson, timestamp);
  }

  searchVectorMemory(queryEmbedding, limit = 5, currentConversationId = null) {
    if (!queryEmbedding || !queryEmbedding.length) {
      return [];
    }

    let rows;
    if (currentConversationId) {
      rows = this.db
        .prepare(`
          SELECT conversation_id, chunk_text, embedding_json
          FROM message_embeddings
          WHERE conversation_id != ?
        `)
        .all(currentConversationId);
    } else {
      rows = this.db
        .prepare(`
          SELECT conversation_id, chunk_text, embedding_json
          FROM message_embeddings
        `)
        .all();
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

  // Specialist Hub Methods
  listSpecialistHubs() {
    const hubs = this.db
      .prepare(`
        SELECT
          h.id,
          h.name,
          h.description,
          h.system_prompt AS systemPrompt,
          h.icon,
          h.created_at AS createdAt,
          h.updated_at AS updatedAt,
          COUNT(c.id) AS chunkCount
        FROM specialist_hubs h
        LEFT JOIN specialist_chunks c ON c.hub_id = h.id
        GROUP BY h.id
        ORDER BY h.updated_at DESC
      `)
      .all();
    return hubs;
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
    const chunkCount = this.db
      .prepare(`SELECT COUNT(*) as count FROM specialist_chunks WHERE hub_id = ?`)
      .get(id).count;
    return { ...hub, chunkCount };
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

  saveSpecialistChunk({ hubId, sourceTitle, sourceUrl = '', chunkText, embedding }) {
    const timestamp = now();
    const id = randomUUID();
    const embeddingJson = JSON.stringify(embedding);

    this.db
      .prepare(`
        INSERT INTO specialist_chunks (id, hub_id, source_title, source_url, chunk_text, embedding_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, hubId, sourceTitle, sourceUrl, chunkText, embeddingJson, timestamp);

    // Update hub timestamp
    this.db
      .prepare(`UPDATE specialist_hubs SET updated_at = ? WHERE id = ?`)
      .run(timestamp, hubId);
  }

  searchSpecialistVectorMemory(hubId, queryEmbedding, limit = 5) {
    if (!hubId || !queryEmbedding || !queryEmbedding.length) {
      return [];
    }

    const rows = this.db
      .prepare(`
        SELECT hub_id, source_title, source_url, chunk_text, embedding_json
        FROM specialist_chunks
        WHERE hub_id = ?
      `)
      .all(hubId);

    const scored = rows
      .map((row) => {
        try {
          const vec = JSON.parse(row.embedding_json);
          const score = cosineSimilarity(queryEmbedding, vec);
          return {
            hubId: row.hub_id,
            sourceTitle: row.source_title,
            sourceUrl: row.source_url,
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
  createAutoTitle,
};


