const test = require('node:test');
const assert = require('node:assert/strict');

const { ConversationRepository } = require('../electron/repository.cjs');
const { chunkText } = require('../electron/research/deepResearch.cjs');

test('repository handles user profile get and set operations', () => {
  const repository = new ConversationRepository(':memory:');

  const defaultProfile = repository.getUserProfile();
  assert.equal(defaultProfile.name, 'User');
  assert.equal(defaultProfile.role, 'Software Developer');

  const updatedProfile = repository.setUserProfile({
    name: 'MILLI',
    role: 'AI System Architect',
    tone: 'Concise & Direct',
    stack: 'React, Node.js, Electron',
    instructions: 'Always output TypeScript code snippets with strict typing.',
  });

  assert.equal(updatedProfile.name, 'MILLI');
  assert.equal(updatedProfile.role, 'AI System Architect');
  assert.equal(updatedProfile.tone, 'Concise & Direct');

  const reFetched = repository.getUserProfile();
  assert.equal(reFetched.name, 'MILLI');

  repository.close();
});

test('repository manages specialist hubs and indexes knowledge chunks for vector search', () => {
  const repository = new ConversationRepository(':memory:');

  const hub = repository.createSpecialistHub({
    name: 'React 19 Specialist',
    description: 'Expert knowledge on React 19 hooks and Server Components',
    systemPrompt: 'You are an expert React 19 engineer.',
    icon: 'code',
  });

  assert.ok(hub.id);
  assert.equal(hub.name, 'React 19 Specialist');

  const hubs = repository.listSpecialistHubs();
  assert.equal(hubs.length, 1);
  assert.equal(hubs[0].name, 'React 19 Specialist');

  repository.saveSpecialistChunk({
    hubId: hub.id,
    sourceTitle: 'React 19 Docs',
    sourceUrl: 'https://react.dev',
    chunkText: 'React Server Components allow rendering on the server before sending to client.',
    embedding: [1, 0, 0, 0],
  });

  const matches = repository.searchSpecialistVectorMemory(hub.id, [0.95, 0, 0, 0], 5);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].sourceTitle, 'React 19 Docs');
  assert.ok(matches[0].chunkText.includes('React Server Components'));

  const deleted = repository.deleteSpecialistHub(hub.id);
  assert.equal(deleted, true);
  assert.equal(repository.listSpecialistHubs().length, 0);

  repository.close();
});

test('deepResearch chunkText splits large text into overlapping chunks', () => {
  const sampleText = 'Alpha '.repeat(300);
  const chunks = chunkText(sampleText, 200, 50);

  assert.ok(chunks.length > 1);
  assert.ok(chunks[0].includes('Alpha'));
});
