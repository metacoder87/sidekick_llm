const test = require('node:test');
const assert = require('node:assert/strict');

const { OllamaService, normalizeBaseUrl } = require('../electron/ollama.cjs');

test('normalizeBaseUrl trims trailing slashes and keeps defaults', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(normalizeBaseUrl(), 'http://localhost:11434');
});

test('listModels maps the Ollama tags response', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      models: [
        {
          name: 'llama3.2',
          size: 12345,
          modified_at: '2026-04-06T12:00:00Z',
        },
      ],
    }),
  });

  const service = new OllamaService();
  const models = await service.listModels();

  assert.deepEqual(models, [
    {
      name: 'llama3.2',
      size: 12345,
      modifiedAt: '2026-04-06T12:00:00Z',
      isAvailable: true,
    },
  ]);

  global.fetch = originalFetch;
});

test('generateChat streams NDJSON chat chunks into a final response', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ message: { content: 'Hello' } })}\n${JSON.stringify({ message: { content: ' there' }, done: true })}\n`,
          ),
        );
        controller.close();
      },
    }),
  });

  const chunks = [];
  const service = new OllamaService();
  const text = await service.generateChat({
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'Hi' }],
    onChunk: (chunk, snapshot) => {
      chunks.push([chunk, snapshot]);
    },
  });

  assert.equal(text, 'Hello there');
  assert.deepEqual(chunks, [
    ['Hello', 'Hello'],
    [' there', 'Hello there'],
  ]);

  global.fetch = originalFetch;
});
