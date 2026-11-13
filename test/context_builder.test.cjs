const test = require('node:test');
const assert = require('node:assert/strict');

const { ConversationRepository } = require('../electron/repository.cjs');
const { MemoryManager } = require('../electron/memory/memoryManager.cjs');
const { DeepResearchWorker } = require('../electron/research/deepResearch.cjs');
const { buildChatContext } = require('../electron/contextBuilder.cjs');

// A deterministic embedder: vectors point along an axis chosen by keyword, so
// "related" texts score high with each other and unrelated ones score ~0.
function stubOllama() {
  const axis = (text) => {
    const t = text.toLowerCase();
    if (t.includes('liability') || t.includes('indemnity')) return [1, 0, 0];
    if (t.includes('protein') || t.includes('nutrition')) return [0, 1, 0];
    return [0, 0, 1];
  };
  return {
    generateEmbedding: async ({ input }) => axis(input),
    generateEmbeddingDetailed: async ({ input }) => ({ vector: axis(input), error: null }),
    generateChatSync: async () => '[]',
  };
}

function setup() {
  const repository = new ConversationRepository(':memory:');
  const ollama = stubOllama();
  const memoryManager = new MemoryManager({ repository, ollama });
  const researchWorker = new DeepResearchWorker({ repository, ollama });
  const allSettings = repository.getAllSettings();
  return { repository, ollama, memoryManager, researchWorker, allSettings };
}

test('buildChatContext grounds an answer in the consulted Expert and reports precise sources', async () => {
  const { repository, ollama, memoryManager, researchWorker, allSettings } = setup();
  const embeddingModel = allSettings.embeddingModel;

  const hub = repository.createSpecialistHub({
    name: 'Legal Expert',
    systemPrompt: 'Read contracts literally.',
  });
  repository.saveSpecialistChunk({
    hubId: hub.id,
    sourceTitle: 'agreement.pdf',
    sourceUrl: 'file:///c/agreement.pdf',
    chunkText: 'Clause 7.2 caps liability at fees paid in the prior twelve months.',
    embedding: [1, 0, 0],
    embeddingModel,
    location: 'p. 2',
    page: 2,
    sourceType: 'pdf',
  });

  const conversation = repository.createConversation('Contract review');
  const result = await buildChatContext({
    repository,
    ollama,
    memoryManager,
    researchWorker,
    content: 'What is the liability cap?',
    conversationId: conversation.id,
    payload: { activeSpecialistIds: [hub.id] },
    model: 'chat-model',
    embeddingModel,
    backgroundModel: 'bg-model',
    allSettings,
    isWebSearchEnabled: false,
  });

  // The expert's persona and its retrieved knowledge both reach the prompt.
  assert.match(result.systemContent, /Legal Expert/);
  assert.match(result.systemContent, /Read contracts literally/);
  assert.match(result.systemContent, /Clause 7\.2 caps liability/);

  // Grounding is reported with verifiable, precise provenance.
  assert.equal(result.specialistGrounding.grounded, true);
  assert.equal(result.specialistGrounding.sources.length, 1);
  const [source] = result.specialistGrounding.sources;
  assert.equal(source.page, 2);
  assert.equal(source.location, 'p. 2');
  assert.equal(source.expertName, 'Legal Expert');
  assert.match(source.quote, /Clause 7\.2/);

  repository.close();
});

test('buildChatContext flags an ungrounded answer when the vault has no relevant knowledge', async () => {
  const { repository, ollama, memoryManager, researchWorker, allSettings } = setup();
  const embeddingModel = allSettings.embeddingModel;

  const hub = repository.createSpecialistHub({ name: 'Legal Expert' });
  repository.saveSpecialistChunk({
    hubId: hub.id,
    sourceTitle: 'agreement.pdf',
    chunkText: 'Clause 7.2 caps liability at fees paid.',
    embedding: [1, 0, 0],
    embeddingModel,
  });

  const conversation = repository.createConversation('Off-topic');
  const result = await buildChatContext({
    repository,
    ollama,
    memoryManager,
    researchWorker,
    content: 'How much protein should I eat?', // orthogonal to the vault
    conversationId: conversation.id,
    payload: { activeSpecialistIds: [hub.id] },
    model: 'chat-model',
    embeddingModel,
    backgroundModel: 'bg-model',
    allSettings,
    isWebSearchEnabled: false,
  });

  // The persona still loads, but the prompt must SAY there was no matching
  // knowledge — a persona speaking from weights must never look grounded.
  assert.equal(result.specialistGrounding.grounded, false);
  assert.equal(result.specialistGrounding.sources.length, 0);
  assert.match(result.systemContent, /No matching knowledge/i);

  repository.close();
});

test('buildChatContext suggests an un-consulted Expert that holds relevant knowledge', async () => {
  const { repository, ollama, memoryManager, researchWorker, allSettings } = setup();
  const embeddingModel = allSettings.embeddingModel;

  const legal = repository.createSpecialistHub({ name: 'Legal Expert' });
  repository.saveSpecialistChunk({
    hubId: legal.id,
    sourceTitle: 'a.pdf',
    chunkText: 'liability clause text',
    embedding: [1, 0, 0],
    embeddingModel,
  });
  const nutrition = repository.createSpecialistHub({ name: 'Nutrition Expert' });
  repository.saveSpecialistChunk({
    hubId: nutrition.id,
    sourceTitle: 'b.pdf',
    chunkText: 'protein intake guidance',
    embedding: [0, 1, 0],
    embeddingModel,
  });

  const conversation = repository.createConversation('Mixed');
  const result = await buildChatContext({
    repository,
    ollama,
    memoryManager,
    researchWorker,
    content: 'How much protein do I need?',
    conversationId: conversation.id,
    payload: { activeSpecialistIds: [legal.id] }, // consulting the WRONG expert
    model: 'chat-model',
    embeddingModel,
    backgroundModel: 'bg-model',
    allSettings,
    isWebSearchEnabled: false,
  });

  assert.equal(result.suggestedExperts.length, 1);
  assert.equal(result.suggestedExperts[0].name, 'Nutrition Expert');

  repository.close();
});

test('buildChatContext always includes the profile and omits specialist context with no panel', async () => {
  const { repository, ollama, memoryManager, researchWorker, allSettings } = setup();

  repository.setUserProfile({ name: 'Ada', role: 'Researcher' });
  const conversation = repository.createConversation('Plain');

  const result = await buildChatContext({
    repository,
    ollama,
    memoryManager,
    researchWorker,
    content: 'Hello there',
    conversationId: conversation.id,
    payload: {},
    model: 'chat-model',
    embeddingModel: allSettings.embeddingModel,
    backgroundModel: 'bg-model',
    allSettings,
    isWebSearchEnabled: false,
  });

  assert.match(result.systemContent, /You are Sidekick/);
  assert.match(result.systemContent, /Ada/);
  assert.equal(result.specialistGrounding, null);
  assert.deepEqual(result.citations, []);

  repository.close();
});

test('buildChatContext surfaces groundingDisabled when the preflight flags the embedder as unavailable', async () => {
  const { repository, ollama, memoryManager, researchWorker, allSettings } = setup();
  const embeddingModel = allSettings.embeddingModel;

  const hub = repository.createSpecialistHub({
    name: 'Legal Expert',
    systemPrompt: 'Read contracts literally.',
  });
  // No chunks saved — with the embedder ruled out, nothing can be retrieved.
  const conversation = repository.createConversation('Contract review');
  const result = await buildChatContext({
    repository,
    ollama,
    memoryManager,
    researchWorker,
    content: 'What is the liability cap?',
    conversationId: conversation.id,
    // Simulate the IPC preflight having ruled the embedder out.
    payload: {
      activeSpecialistIds: [hub.id],
      groundingDisabled: {
        reason: `Embedding model "${embeddingModel}" is not available: not downloaded.`,
      },
    },
    model: 'chat-model',
    embeddingModel,
    backgroundModel: 'bg-model',
    allSettings,
    isWebSearchEnabled: false,
  });

  // Embedding was skipped entirely; the reason is surfaced in grounding payload.
  assert.equal(result.specialistGrounding?.groundingDisabled?.reason, `Embedding model "${embeddingModel}" is not available: not downloaded.`);
  assert.equal(result.specialistGrounding?.grounded, false);
  assert.equal(result.specialistGrounding?.matches, 0);

  repository.close();
});

test('buildChatContext degrades to keyword-only retrieval when the embedding model fails at runtime', async () => {
  const { repository, memoryManager, researchWorker, allSettings } = setup();
  const embeddingModel = allSettings.embeddingModel;

  // An embedder that always fails — simulates a missing/misconfigured GGUF.
  const failingOllama = {
    generateEmbedding: async () => null,
    generateEmbeddingDetailed: async () => ({ vector: null, error: 'Model not found' }),
    generateChatSync: async () => '[]',
  };

  const hub = repository.createSpecialistHub({
    name: 'Legal Expert',
    systemPrompt: 'Read contracts literally.',
  });
  repository.saveSpecialistChunk({
    hubId: hub.id,
    sourceTitle: 'agreement.pdf',
    chunkText: 'Clause 7.2 caps liability at fees paid in the prior twelve months.',
    embedding: [1, 0, 0],
    embeddingModel,
  });

  const conversation = repository.createConversation('Contract review');
  const result = await buildChatContext({
    repository,
    ollama: failingOllama,
    memoryManager,
    researchWorker,
    content: 'liability cap', // keyword matches the vault chunk
    conversationId: conversation.id,
    payload: { activeSpecialistIds: [hub.id] },
    model: 'chat-model',
    embeddingModel,
    backgroundModel: 'bg-model',
    allSettings,
    isWebSearchEnabled: false,
  });

  // Embedding failed, so groundingDisabled is set.
  assert.equal(result.specialistGrounding?.groundingDisabled?.reason, `Embedding model "${embeddingModel}" is not available for retrieval. Vault search is keyword-only until the model is downloaded or the engine is switched.`);
  // But keyword search still found the chunk — vault is not invisible.
  assert.equal(result.specialistGrounding?.matches, 1);
  assert.match(result.systemContent, /Clause 7\.2 caps liability/);

  repository.close();
});
