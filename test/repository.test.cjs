const test = require('node:test');
const assert = require('node:assert/strict');

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

