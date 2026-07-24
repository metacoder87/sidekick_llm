const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  ConversationRepository,
  DEFAULT_TITLE,
  createAutoTitle,
} = require('../electron/repository.cjs');

test('repository stores messages, auto-titles default conversations, and exports history', () => {
  const repository = new ConversationRepository(':memory:');
  const conversation = repository.createConversation();
  assert.equal(conversation.title, DEFAULT_TITLE);

  const userMessage = repository.addMessage({
    conversationId: conversation.id,
    role: 'user',
    content: 'Summarize the latest notes from my local project folder',
  });
  repository.maybeAutoTitleConversation(conversation.id, userMessage.content);
  repository.addMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: 'I can help once the folder is attached.',
  });

  const storedConversation = repository.getConversation(conversation.id);
  assert.equal(storedConversation.messages.length, 2);
  assert.equal(storedConversation.title, createAutoTitle(userMessage.content));

  const exported = repository.exportAll();
  assert.equal(exported.conversations.length, 1);
  assert.equal(exported.conversations[0].messages[0].role, 'user');

  repository.close();
});

test('repository searches conversations by title and message content', () => {
  const repository = new ConversationRepository(':memory:');
  const planningConversation = repository.createConversation('Implementation planning');
  repository.addMessage({
    conversationId: planningConversation.id,
    role: 'user',
    content: 'Draft the rollout sequence for the desktop shell.',
  });

  const bugConversation = repository.createConversation('Bug triage');
  repository.addMessage({
    conversationId: bugConversation.id,
    role: 'assistant',
    content: 'The crash only occurs when the Ollama process is unavailable.',
  });

  const titleMatches = repository.searchConversations('Implementation');
  const messageMatches = repository.searchConversations('Ollama');

  assert.equal(titleMatches.length, 1);
  assert.equal(titleMatches[0].id, planningConversation.id);
  assert.equal(messageMatches.length, 1);
  assert.equal(messageMatches[0].id, bugConversation.id);

  repository.close();
});

test('repository stores and retrieves user memories and settings', () => {
  const repository = new ConversationRepository(':memory:');

  // Test Settings
  repository.setSetting('webSearchEnabled', 'true');
  assert.equal(repository.getSetting('webSearchEnabled'), 'true');
  const allSettings = repository.getAllSettings();
  assert.equal(allSettings.webSearchEnabled, 'true');

  // Test User Memories
  const memory = repository.addUserMemory({
    fact: 'User prefers React with Vite',
    category: 'tech-stack',
  });
  assert.ok(memory.id);
  assert.equal(memory.fact, 'User prefers React with Vite');

  const memories = repository.listUserMemories();
  assert.equal(memories.length, 1);
  assert.equal(memories[0].fact, 'User prefers React with Vite');

  const deleted = repository.deleteUserMemory(memory.id);
  assert.equal(deleted, true);
  assert.equal(repository.listUserMemories().length, 0);

  repository.close();
});

test('repository saves message vector embeddings and performs cosine search', () => {
  const repository = new ConversationRepository(':memory:');
  const conv = repository.createConversation('Vector Test');

  repository.saveMessageEmbedding({
    messageId: 'msg-1',
    conversationId: conv.id,
    chunkText: 'React components and hooks performance optimization',
    embedding: [1, 0, 0, 0],
  });

  repository.saveMessageEmbedding({
    messageId: 'msg-2',
    conversationId: conv.id,
    chunkText: 'Database indexing with SQLite WAL mode',
    embedding: [0, 1, 0, 0],
  });

  const matches = repository.searchVectorMemory([0.9, 0.1, 0, 0], 5);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].chunkText, 'React components and hooks performance optimization');

  repository.close();
});

test('repository stamps schema version and reports a clean integrity check', () => {
  const repository = new ConversationRepository(':memory:');
  assert.equal(repository.getSchemaVersion(), 1);
  assert.equal(repository.integrity.ok, true);
  assert.equal(repository.integrity.detail, 'ok');
  repository.close();
});

test('repository backs up a legacy unversioned database before migrating, preserving data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mig-'));
  const dbPath = path.join(dir, 'legacy.db');

  try {
    // Simulate a pre-versioning database: real data, user_version still 0.
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_at TEXT
    );`);
    raw.prepare(`INSERT INTO conversations VALUES ('legacy-1','Legacy thread',NULL,'t','t',NULL)`).run();
    raw.pragma('user_version = 0');
    raw.close();

    const repository = new ConversationRepository(dbPath);

    // Version bumped, legacy row survived.
    assert.equal(repository.getSchemaVersion(), 1);
    const survivor = repository.db
      .prepare(`SELECT title FROM conversations WHERE id = 'legacy-1'`)
      .get();
    assert.equal(survivor.title, 'Legacy thread');

    // Exactly one backup of the pre-migration database was created.
    const backups = fs.readdirSync(dir).filter((n) => n.startsWith('legacy.db.bak-v0-'));
    assert.equal(backups.length, 1);

    repository.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repository exports the full corpus and re-imports it losslessly and idempotently', () => {
  const source = new ConversationRepository(':memory:');

  const conv = source.createConversation('Quantum notes');
  source.addMessage({ conversationId: conv.id, role: 'user', content: 'What is superposition?' });
  source.addMessage({ conversationId: conv.id, role: 'assistant', content: 'A combination of basis states.' });
  source.addUserMemory({ fact: 'User studies quantum physics', category: 'user-defined' });
  source.setUserProfile({ name: 'Ada', role: 'Researcher' });
  const hub = source.createSpecialistHub({ name: 'Quantum Expert', systemPrompt: 'Be precise' });
  source.saveSpecialistChunk({
    hubId: hub.id,
    sourceTitle: 'Griffiths',
    chunkText: 'The Schrodinger equation governs time evolution.',
    embedding: [0.1, 0.2, 0.3],
  });

  const dump = source.exportAll();
  source.close();

  // Envelope carries the whole corpus, not just chat history.
  assert.equal(dump.kind, 'corpus-export');
  assert.equal(dump.specialistHubs[0].chunks.length, 1);
  assert.equal(dump.userMemories.length, 1);

  // Restore into an empty database.
  const target = new ConversationRepository(':memory:');
  const counts = target.importAll(dump);
  assert.equal(counts.conversations, 1);
  assert.equal(counts.messages, 2);
  assert.equal(counts.userMemories, 1);
  assert.equal(counts.specialistHubs, 1);
  assert.equal(counts.specialistChunks, 1);

  // Fidelity: content, profile, and — critically — the embedding survive so the
  // restored vault is actually retrievable, not merely present.
  const restored = target.getConversation(conv.id);
  assert.equal(restored.messages[0].content, 'What is superposition?');
  assert.equal(target.getUserProfile().name, 'Ada');
  const hits = target.searchSpecialistVectorMemory(hub.id, [0.1, 0.2, 0.3], 4);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sourceTitle, 'Griffiths');

  // Idempotency: importing the same corpus again inserts nothing.
  const second = target.importAll(dump);
  assert.equal(second.conversations, 0);
  assert.equal(second.messages, 0);
  assert.equal(second.specialistChunks, 0);

  target.close();
});

