'use strict';

const path = require('node:path');
const { LlamaCppProvider } = require('./llamaCppProvider.cjs');

const IDLE_DISPOSE_MS = 10 * 60 * 1000;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 3;

// Broker for the isolated node-llama-cpp worker. It intentionally mirrors the
// old provider surface so all persona, citation and retrieval code continues to
// pass rich prompts unchanged while native crashes cannot take SQLite with them.
class NativeWorkerProvider {
  kind = 'builtin';

  constructor({ modelsDir, getSettings = () => ({}) } = {}) {
    this.modelsDir = modelsDir;
    this.getSettings = getSettings;
    this.child = null;
    this.pending = new Map();
    this.restarts = [];
    this.degraded = false;
    this.idleTimer = null;
    this.sequence = 0;
    // Node/unit-test fallback retains deterministic non-native catalog tests.
    this.fallback = new LlamaCppProvider({ modelsDir, getSettings });
  }

  _utilityProcess() {
    try {
      return require('electron').utilityProcess;
    } catch (_error) {
      return null;
    }
  }

  _scheduleIdleDispose() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this._request('dispose').catch(() => {});
    }, IDLE_DISPOSE_MS);
    this.idleTimer.unref?.();
  }

  _start() {
    if (this.child) return this.child;
    const utilityProcess = this._utilityProcess();
    if (!utilityProcess || this.degraded) return null;
    const workerPath = path.join(__dirname, 'llamaWorker.cjs');
    const child = utilityProcess.fork(workerPath, [], {
      stdio: 'ignore',
      serviceName: 'sidekick-inference',
    });
    child.on('message', (...args) => this._onMessage(args.at(-1)));
    child.on('exit', (_event, code) => this._onExit(code));
    this.child = child;
    return child;
  }

  _onMessage(message) {
    if (!message) return;
    if (message.type === 'event') {
      const pending = this.pending.get(message.id);
      if (message.name === 'chunk')
        pending?.onChunk?.(message.payload.text, message.payload.fullText);
      if (message.name === 'progress') pending?.onProgress?.(message.payload);
      return;
    }
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error?.message || 'Inference worker failed.');
      error.code = message.error?.code || 'WORKER_ERROR';
      pending.reject(error);
    }
  }

  _onExit(code) {
    if (!this.child) return;
    this.child = null;
    const now = Date.now();
    this.restarts = this.restarts.filter((time) => now - time < RESTART_WINDOW_MS);
    this.restarts.push(now);
    this.degraded = this.restarts.length > MAX_RESTARTS;
    for (const pending of this.pending.values()) {
      const error = new Error(
        this.degraded
          ? 'Inference worker repeatedly crashed. Restart Sidekick to try again.'
          : 'Inference worker stopped. Please retry your request.',
      );
      error.code = this.degraded ? 'WORKER_DEGRADED' : 'WORKER_RESTART_REQUIRED';
      pending.reject(error);
    }
    this.pending.clear();
    if (code && !this.degraded)
      console.error(`Inference worker exited (${code}); it will restart on the next request.`);
  }

  _request(method, args = {}, { signal, onChunk, onProgress } = {}) {
    const child = this._start();
    if (!child)
      return Promise.reject(
        new Error('The isolated inference worker is unavailable. Restart Sidekick and try again.'),
      );
    const id = `native-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const onAbort = () => child.postMessage({ type: 'cancel', id });
      if (signal?.aborted)
        return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          this._scheduleIdleDispose();
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        onChunk,
        onProgress,
      });
      child.postMessage({
        type: 'request',
        id,
        method,
        args,
        modelsDir: this.modelsDir,
        workerSettings: this.getSettings() || {},
      });
    });
  }

  async _call(method, args = {}, callbacks = {}) {
    // utilityProcess is absent under Electron-as-Node unit tests.
    if (!this._utilityProcess()) {
      if (method === 'deleteModel') return this.fallback.deleteModel(args.name);
      return this.fallback[method]({ ...args, ...callbacks });
    }
    return this._request(method, args, callbacks);
  }

  // `child.postMessage` uses the structured clone algorithm, which rejects
  // functions and AbortSignals with "An object could not be cloned." The
  // provider interface receives live `signal`/`onChunk`/`onProgress` values, so
  // send only the serializable arguments and hand the callbacks to the local
  // request broker, which wires them to worker events and cancellation.
  _transferable(options = {}) {
    const args = { ...options };
    delete args.signal;
    delete args.onChunk;
    delete args.onProgress;
    return args;
  }

  listModels() {
    return this._call('listModels');
  }
  getCatalog() {
    return this._call('getCatalog');
  }
  getStatus() {
    return this._call('getStatus').then((status) => ({
      ...status,
      worker: this.degraded ? 'degraded' : 'isolated',
    }));
  }
  pullModel(options = {}) {
    return this._call('pullModel', this._transferable(options), options);
  }
  deleteModel(name) {
    return this._call('deleteModel', { name });
  }
  generateChat(options = {}) {
    return this._call('generateChat', this._transferable(options), options);
  }
  generateChatSync(options = {}) {
    return this._call('generateChatSync', this._transferable(options), options);
  }
  generateEmbedding(options = {}) {
    return this._call('generateEmbedding', this._transferable(options), options);
  }
  generateEmbeddingDetailed(options = {}) {
    return this._call('generateEmbeddingDetailed', this._transferable(options), options);
  }
  checkEmbedding(model) {
    return this._call('checkEmbedding', { model });
  }
  benchmark(options = {}) {
    return this._request('benchmark', options);
  }
  async disposeAll() {
    clearTimeout(this.idleTimer);
    if (!this._utilityProcess()) return this.fallback.disposeAll();
    if (!this.child) return undefined;
    await this._request('dispose').catch(() => {});
    this.child.kill();
    this.child = null;
  }
}

module.exports = { NativeWorkerProvider, IDLE_DISPOSE_MS, MAX_RESTARTS };
