'use strict';

const path = require('node:path');
const os = require('node:os');

const { OllamaService } = require('./ollama.cjs');
const { LlamaCppProvider } = require('./llama/llamaCppProvider.cjs');
const { NativeWorkerProvider } = require('./llama/nativeWorkerProvider.cjs');
const { hardwareProfile } = require('./llama/hardware.cjs');
const ollamaCatalog = require('../shared/modelCatalog.json');

// Ollama tags models with a variant (`mistral:7b`, `nomic-embed-text:latest`).
// Compare the installed name against a catalog name tolerantly so a `:latest`
// tag, a variant suffix, or a bare untagged name all match.
function catalogNameMatches(installedName, catalogName) {
  if (!installedName || !catalogName) return false;
  return (
    installedName === catalogName ||
    installedName.startsWith(`${catalogName}-`) ||
    installedName.split(':')[0] === catalogName
  );
}

// OllamaProvider: the pre-existing external-Ollama engine, wrapped in the
// provider interface. Kept as an option for users who already run Ollama and
// have their models there.
class OllamaProvider {
  kind = 'ollama';

  constructor(options = {}) {
    this.service = new OllamaService(options);
  }

  getStatus() {
    return this.service.getStatus();
  }

  listModels() {
    // Ollama's /api/tags does not report what a model is for. Annotate known
    // entries from the catalog so the UI can keep embedding models out of the
    // chat/background pickers and offer them in the embedding picker. Unknown
    // models remain chat models.
    return this.service.listModels().then((models) =>
      models.map((model) => {
        const base = String(model.name || '').split(':')[0];
        const entry = ollamaCatalog.models.find(
          (candidate) => candidate.name === model.name || candidate.name === base,
        );
        // Recent Ollama versions report capabilities. That is the most reliable
        // way to keep an embedding model (which may not be in our catalog) out
        // of the chat picker.
        const isEmbedding = Array.isArray(model.capabilities)
          ? model.capabilities.includes('embedding')
          : false;
        return { ...model, role: entry?.role || (isEmbedding ? 'embedding' : 'chat') };
      }),
    );
  }

  generateChat(options) {
    return this.service.generateChat(options);
  }

  generateChatSync(options) {
    return this.service.generateChatSync(options);
  }

  pullModel(options) {
    return this.service.pullModel(options);
  }

  deleteModel(name) {
    return this.service.deleteModel(name);
  }

  checkEmbedding(model) {
    return this.service.checkEmbedding(model);
  }

  generateEmbedding(options) {
    return this.service.generateEmbedding(options);
  }

  async generateEmbeddingDetailed(options) {
    const embedding = await this.service.generateEmbeddingDetailed(options);
    return embedding;
  }

  async getCatalog() {
    const hardware = hardwareProfile();
    const installed = await this.listModels().catch(() => []);
    const models = ollamaCatalog.models.map((model) => ({
      ...model,
      // Match "llama3.1:8b" against an installed "llama3.1:8b" or "llama3.1:8b-...",
      // and "nomic-embed-text" against Ollama's "nomic-embed-text:latest".
      installed: installed.some((entry) => catalogNameMatches(entry.name, model.name)),
      fits: hardware.totalRamGB >= model.minRamGB,
      tight: hardware.totalRamGB >= model.minRamGB && hardware.totalRamGB < model.minRamGB * 1.5,
    }));

    // The curated list is a starting point, not a filter. Anything already
    // downloaded into Ollama must stay visible in the gallery — including
    // models pulled from HuggingFace under `hf.co/...` names.
    const uncurated = installed.filter(
      (entry) => !ollamaCatalog.models.some((model) => catalogNameMatches(entry.name, model.name)),
    );
    for (const entry of uncurated) {
      const sizeGB = entry.size ? Number((entry.size / 1e9).toFixed(1)) : null;
      // A rough RAM floor for an already-downloaded model. We only use it to
      // flag models that are likely to be slow, never to hide them.
      const minRamGB = sizeGB ? Math.max(4, Math.ceil(sizeGB * 1.25)) : 8;
      models.push({
        name: entry.name,
        role: entry.role || 'chat',
        label: entry.role === 'embedding' ? 'Embedding (installed)' : 'Installed in Ollama',
        sizeGB,
        minRamGB,
        installed: true,
        fits: hardware.totalRamGB >= minRamGB,
        tight: hardware.totalRamGB >= minRamGB && hardware.totalRamGB < minRamGB * 1.5,
        description:
          'Already downloaded in Ollama. Selecting it in the model picker switches Sidekick to the Ollama engine.',
        why: 'Managed by Ollama. Delete removes it from your local Ollama store.',
        source: 'ollama',
      });
    }

    return {
      hardware,
      installed: installed.map((m) => m.name),
      models,
    };
  }

  async disposeAll() {
    // Nothing to release: Ollama owns its own models.
  }
}

// Facade used by the IPC layer. Routes every call to whichever engine the
// user has selected in Settings, so switching engines works at runtime with no
// restart: `llmProvider` = 'builtin' (default) or 'ollama'.
//
// Both concrete providers stay constructed (and the built-in one keeps its
// model cache), so a user can flip back and forth freely.
function createLLMProvider({ getSettings = () => ({}), userDataPath, fetchImpl } = {}) {
  // In the Electron main process `app` is a global; in plain Node (tests) it is
  // not. Access it via globalThis so the module stays lint-clean in both.
  const electronApp = globalThis.app;
  const baseDir =
    userDataPath ||
    (electronApp && typeof electronApp.getPath === 'function'
      ? electronApp.getPath('userData')
      : path.join(os.homedir(), 'sidekick'));
  const ollama = new OllamaProvider({
    getBaseUrl: () => getSettings().ollamaBaseUrl || 'http://localhost:11434',
  });
  const builtin = new NativeWorkerProvider({
    modelsDir: path.join(baseDir, 'models'),
    getSettings,
    fetchImpl,
  });

  const active = () => (getSettings().llmProvider === 'ollama' ? ollama : builtin);

  return {
    get kind() {
      return active().kind;
    },
    getStatus: () => active().getStatus(),
    listModels: () => active().listModels(),
    // Both engines at once, each model tagged with the engine that owns it.
    // The UI uses this so a model downloaded into Ollama is never hidden just
    // because the built-in engine happens to be selected. A provider that is
    // unreachable contributes an empty list rather than failing the call.
    listAllModels: async () => {
      const [builtinModels, ollamaModels] = await Promise.allSettled([
        builtin.listModels(),
        ollama.listModels(),
      ]);
      const tag = (engine, result) =>
        (result.status === 'fulfilled' ? result.value || [] : []).map((model) => ({
          ...model,
          engine,
        }));
      return [...tag('builtin', builtinModels), ...tag('ollama', ollamaModels)];
    },
    generateChat: (options) => active().generateChat(options),
    generateChatSync: (options) => active().generateChatSync(options),
    pullModel: (options) => active().pullModel(options),
    checkEmbedding: (model) => active().checkEmbedding(model),
    generateEmbedding: (options) => active().generateEmbedding(options),
    generateEmbeddingDetailed: (options) => active().generateEmbeddingDetailed(options),
    getCatalog: () => active().getCatalog(),
    deleteModel: (name) => active().deleteModel(name),
    benchmark: (options) => {
      const provider = active();
      if (typeof provider.benchmark !== 'function') {
        return Promise.resolve({
          skipped: true,
          reason: 'Calibration is available only for the built-in engine.',
        });
      }
      return provider.benchmark(options);
    },
    disposeAll: () =>
      Promise.allSettled([ollama.disposeAll(), builtin.disposeAll()]).then(() => undefined),
    // Exposed for tests only — production code talks to the facade.
    _ollama: ollama,
    _builtin: builtin,
  };
}

module.exports = {
  OllamaProvider,
  LlamaCppProvider,
  NativeWorkerProvider,
  createLLMProvider,
  hardwareProfile,
};
