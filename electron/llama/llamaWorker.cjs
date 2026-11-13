'use strict';

// Utility-process entry point. This process deliberately owns every native
// node-llama-cpp handle; the Electron main process keeps SQLite and all user
// data coordination. The IPC channel is Electron's private process channel,
// not a network listener.
const { LlamaCppProvider } = require('./llamaCppProvider.cjs');

let provider = null;
let settings = {};
const requests = new Map();

function reply(id, payload) {
  process.parentPort.postMessage({ type: 'response', id, ...payload });
}

function event(id, name, payload) {
  process.parentPort.postMessage({ type: 'event', id, name, payload });
}

async function invoke(message) {
  const { id, method, args = {}, workerSettings = {} } = message;
  settings = workerSettings;
  if (!provider) {
    provider = new LlamaCppProvider({
      modelsDir: message.modelsDir,
      getSettings: () => settings,
    });
  }
  const controller = new AbortController();
  requests.set(id, controller);
  try {
    if (method === 'benchmark') {
      const started = Date.now();
      const text = await provider.generateChat({
        model: args.model,
        messages: [{ role: 'user', content: 'Reply with the single word ready.' }],
        signal: controller.signal,
      });
      const embedding = await provider.generateEmbedding({
        model: args.embeddingModel,
        input: 'calibration',
      });
      reply(id, {
        ok: true,
        result: {
          backend: 'auto',
          elapsedMs: Date.now() - started,
          tokensPerSecond: text
            ? Number(
                (text.split(/\s+/).length / Math.max(0.001, (Date.now() - started) / 1000)).toFixed(
                  2,
                ),
              )
            : 0,
          embeddingDimensions: embedding?.length || 0,
        },
      });
      return;
    }
    if (method === 'dispose') {
      await provider.disposeAll();
      reply(id, { ok: true, result: undefined });
      return;
    }
    if (method === 'deleteModel') {
      reply(id, { ok: true, result: await provider.deleteModel(args.name) });
      return;
    }
    const fn = provider[method];
    if (typeof fn !== 'function') throw new Error(`Unsupported inference worker method: ${method}`);
    const result = await fn.call(provider, {
      ...args,
      signal: controller.signal,
      onChunk: (text, fullText) => event(id, 'chunk', { text, fullText }),
      onProgress: (progress) => event(id, 'progress', progress),
    });
    reply(id, { ok: true, result });
  } catch (error) {
    reply(id, { ok: false, error: { message: error.message, code: error.code } });
  } finally {
    requests.delete(id);
  }
}

// Electron delivers messages to a utility process as a MessageEvent ({ data,
// ports }), while older versions emitted the payload directly. Unwrap both
// shapes so the worker keeps working across Electron upgrades.
process.parentPort.on('message', (eventOrMessage) => {
  const message = eventOrMessage?.data ?? eventOrMessage;
  if (!message) return;
  if (message.type === 'cancel') {
    requests.get(message.id)?.abort();
    return;
  }
  if (message.type === 'request') invoke(message);
});

process.on('uncaughtException', (error) => {
  process.parentPort.postMessage({ type: 'fatal', error: error.message });
  process.exit(1);
});
