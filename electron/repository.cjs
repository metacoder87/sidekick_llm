const Database = require('better-sqlite3');
const { randomUUID } = require('node:crypto');

const DEFAULT_TITLE = 'New conversation';
const DEFAULT_SETTINGS = {
  ollamaBaseUrl: 'http://localhost:11434',
};

function now() {
  return new Date().toISOString();
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

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_message_at AS lastMessageAt
        FROM conversations
        WHERE id = ?
      `)
      .get(conversationId);
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

  setSetting(key, value) {
    this.db
      .prepare(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, value);
  }
}

module.exports = {
  ConversationRepository,
  DEFAULT_TITLE,
  DEFAULT_SETTINGS,
  createAutoTitle,
};
