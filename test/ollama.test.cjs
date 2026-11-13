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

test('listModels accepts the newer `model` field when `name` is absent', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      models: [{ model: 'qwen3:8b', size: 42, capabilities: ['completion'] }],
    }),
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const models = await new OllamaService().listModels();

  assert.equal(models[0].name, 'qwen3:8b');
  assert.deepEqual(models[0].capabilities, ['completion']);
});

test('deleteModel calls the Ollama delete endpoint', async (t) => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, text: async () => '' };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const service = new OllamaService();
  const result = await service.deleteModel('llama3.2');

  assert.equal(result.ok, true);
  assert.match(requests[0].url, /\/api\/delete$/);
  assert.equal(requests[0].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: 'llama3.2',
    name: 'llama3.2',
  });
});

test('deleteModel reports Ollama failures instead of throwing', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () => 'model not found',
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const service = new OllamaService();
  const result = await service.deleteModel('missing-model');

  assert.equal(result.ok, false);
  assert.match(result.reason, /404/);
  assert.match(result.reason, /model not found/);
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
