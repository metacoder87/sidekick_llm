'use strict';

const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ggufCatalog = require('../../shared/ggufCatalog.json');
const { hardwareProfile, chooseGpuOffload } = require('./hardware.cjs');
const { downloadFile } = require('./downloader.cjs');

const GB = 1024 ** 3;
const DEFAULT_CONTEXT = 8192;

// The native engine is loaded lazily and cached. Loading it eagerly would slow
// startup and would force every plain-Node test (which only exercise the pure
// logic) to resolve the native binding.
//
// node-llama-cpp@3.x ships as pure ESM with top-level await, so it must be
// loaded with a dynamic import() — require() throws ERR_REQUIRE_ASYNC_MODULE.
let llamaModule = null; // ESM namespace: getLlama, LlamaChatSession, LlamaLogLevel, ...
let llamaInstance = null; // shared getLlama() instance (one native binding for the app)

async function loadLlamaModule() {
  if (llamaModule) return llamaModule;
  let mod;
  try {
    mod = await import('node-llama-cpp');
  } catch (error) {
    const wrapped = new Error(
      `The built-in inference engine could not be loaded (${error.message}). ` +
        'If this is a packaged app, the native runtime for your platform may be missing — reinstall the app.',
    );
    wrapped.code = 'LLAMA_UNAVAILABLE';
    throw wrapped;
  }
  llamaModule = mod.default || mod; // named exports; tolerate a default if a bundler adds one
  return llamaModule;
}

// One shared native instance for the process: model loads, VRAM reads and
// inference all go through it. Recreated transparently after disposeAll().
async function getLlamaInstance() {
  if (llamaInstance && !llamaInstance.disposed) return llamaInstance;
  const mod = await loadLlamaModule();
  const logLevel = mod.LlamaLogLevel ? mod.LlamaLogLevel.error : undefined;
  llamaInstance = await mod.getLlama({ logLevel });
  return llamaInstance;
}

// Backwards-compatible name (now async): resolves the engine module.
async function loadLlama() {
  return loadLlamaModule();
}

// The app speaks OpenAI-style { role, content }; node-llama-cpp wants
// { type: 'system'|'user', text } or { type: 'model', response: [text] }.
function toChatHistoryItem(message) {
  if (!message) return null;
  const text =
    message.content != null
      ? String(message.content)
      : message.text != null
        ? String(message.text)
        : '';
  const role = message.role || message.type;
  if (role === 'system') return { type: 'system', text };
  if (role === 'assistant' || role === 'model') return { type: 'model', response: [text] };
  return { type: 'user', text };
}

// Built-in inference engine: runs GGUF models in-process via node-llama-cpp,
// with no external server and no open port. Implements the same interface as
// OllamaProvider so the rest of the app is agnostic to which engine is active.
class LlamaCppProvider {
  kind = 'builtin';

  constructor({ modelsDir, getSettings = () => ({}), fetchImpl } = {}) {
    this.modelsDir = modelsDir;
    this.getSettings = getSettings;
    this.fetchImpl = fetchImpl;
    // path -> { model, context, vocabulary, plan }
    this.cache = new Map();
    // path -> in-flight load promise (dedupes concurrent loads of the same file)
    this.loading = new Map();
  }

  // ---- Catalog & downloads -----------------------------------------------------

  catalogUrl(entry) {
    const revision = entry.revision || 'main';
    return `https://huggingface.co/${entry.repo}/resolve/${encodeURIComponent(revision)}/${encodeURIComponent(entry.file)}?download=true`;
  }

  async fingerprint(filePath) {
    const hash = createHash('sha256');
    const handle = await fs.open(filePath, 'r');
    try {
      const stream = handle.createReadStream();
      for await (const chunk of stream) hash.update(chunk);
    } finally {
      await handle.close();
    }
    return hash.digest('hex');
  }

  async listModels() {
    let files = [];
    try {
      files = (await fs.readdir(this.modelsDir)).filter((f) => f.toLowerCase().endsWith('.gguf'));
    } catch (_error) {
      files = [];
    }
    const models = [];
    for (const file of files) {
      try {
        const stat = await fs.stat(path.join(this.modelsDir, file));
        const name = file.replace(/\.gguf$/i, '');
        const catalogEntry = ggufCatalog.models.find(
          (entry) => entry.id === name || entry.file === file,
        );
        models.push({
          // Strip the extension case-insensitively: path.basename's ext matching
          // is case-sensitive, so "Model.GGUF" would otherwise keep it in the name.
          name,
          file,
          role: catalogEntry?.role || 'chat',
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          isAvailable: stat.size > 0,
        });
      } catch (_error) {
        /* file vanished mid-scan; skip it */
      }
    }
    return models.sort((a, b) => a.name.localeCompare(b.name));
  }

  // A model "name" from settings is the catalog id (or a bare filename); resolve
  // it to the actual file in the models folder. Also accept absolute paths so a
  // user can drop any .gguf in and point the app at it directly.
  //
  // Resolution is case-insensitive on a fallback: listModels reports a file named
  // "Model.GGUF" as "Model", and on case-sensitive filesystems the reconstructed
  // "Model.gguf" would not exist — so if the exact path is missing, match against
  // what is actually in the folder.
  async resolveModelPath(name) {
    if (!name) return null;
    const trimmed = String(name).trim();
    let candidate;
    if (trimmed.toLowerCase().endsWith('.gguf')) {
      if (path.isAbsolute(trimmed) || trimmed.includes(path.sep)) return trimmed;
      candidate = path.join(this.modelsDir, trimmed);
    } else {
      candidate = path.join(this.modelsDir, `${trimmed}.gguf`);
    }
    try {
      await fs.stat(candidate);
      return candidate;
    } catch (_error) {
      /* exact path missing — try a case-insensitive match below */
    }
    let files = [];
    try {
      files = await fs.readdir(this.modelsDir);
    } catch (_error) {
      return candidate; // let the caller's stat produce an accurate "missing" message
    }
    const wanted = path.basename(candidate).toLowerCase();
    const match = files.find((f) => f.toLowerCase() === wanted);
    return match ? path.join(this.modelsDir, match) : candidate;
  }

  async getCatalog() {
    const hardware = hardwareProfile();
    const installed = await this.listModels();
    const installedNames = new Set(installed.map((m) => m.name));
    return {
      hardware,
      installed: installed.map((m) => m.name),
      models: ggufCatalog.models.map((model) => ({
        ...model,
        installed: installedNames.has(model.id),
        fits: hardware.totalRamGB >= model.minRamGB,
        tight: hardware.totalRamGB >= model.minRamGB && hardware.totalRamGB < model.minRamGB * 1.5,
        url: this.catalogUrl(model),
      })),
    };
  }

  async getStatus() {
    const models = await this.listModels().catch(() => []);
    let engine = 'ready';
    let error = null;
    try {
      await loadLlamaModule(); // resolves the engine module without loading a binary
    } catch (loadError) {
      engine = 'error';
      error = loadError.message;
    }
    return {
      available: models.length > 0 && engine === 'ready',
      baseUrl: null,
      engine,
      models,
      error,
    };
  }

  // Download a catalog model (by id) from HuggingFace, resumable and cancellable.
  async pullModel({ name, signal, onProgress = () => {} } = {}) {
    if (!name) return { ok: false, reason: 'No model selected.' };
    const entry = ggufCatalog.models.find((m) => m.id === name || m.file === name);
    if (!entry) {
      return {
        ok: false,
        reason: `"${name}" is not in the built-in gallery. Download its .gguf file and place it in the models folder — it will appear automatically.`,
      };
    }
    const destPath = path.join(this.modelsDir, `${entry.id}.gguf`);
    const result = await downloadFile({
      url: this.catalogUrl(entry),
      destPath,
      signal,
      onProgress,
      fetchImpl: this.fetchImpl,
    });
    if (result.ok) {
      const sha256 = await this.fingerprint(destPath);
      if (entry.sha256 && sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
        await fs.rm(destPath, { force: true });
        return {
          ok: false,
          name: entry.id,
          reason: 'Downloaded model failed its SHA-256 verification.',
        };
      }
      // The sidecar records the exact artifact used for a model even while a
      // catalog entry has no upstream-published hash yet. Imported models can
      // use the same fingerprinting path before they are registered.
      await fs.writeFile(`${destPath}.sha256`, `${sha256}\n`, 'utf8');
      return { ok: true, name: entry.id, total: result.total, sha256 };
    }
    return { ok: false, name: entry.id, reason: result.reason, cancelled: result.cancelled };
  }

  // ---- Inference ----------------------------------------------------------------

  // VRAM as reported by the backend itself (the only source we trust cross-platform).
  async _vramGB() {
    try {
      const llama = await getLlamaInstance();
      const info = llama.getVramState ? await llama.getVramState() : null;
      return info && info.total ? info.total / GB : 0;
    } catch (_error) {
      return 0;
    }
  }

  async _entryFor(modelName) {
    const ggufPath = await this.resolveModelPath(modelName);
    if (!ggufPath) {
      throw new Error(
        `Model "${modelName}" is not downloaded yet. Open Settings → Local Model & Engine and download it from the gallery.`,
      );
    }

    let stat;
    try {
      stat = await fs.stat(ggufPath);
    } catch (_error) {
      throw new Error(`Model file is missing: ${ggufPath}`);
    }
    if (stat.size === 0) {
      throw new Error(
        'The model file is empty — the download was interrupted. Download it again from the gallery.',
      );
    }

    const cached = this.cache.get(ggufPath);
    if (cached && !cached.disposed) return cached;

    // Dedupe concurrent loads of the same file: a chat turn and a background job
    // racing each other would otherwise both load the model, doubling VRAM use
    // and leaking one native model handle.
    const inFlight = this.loading.get(ggufPath);
    if (inFlight) return inFlight;
    const loadPromise = this._loadEntry(ggufPath, stat.size / GB).finally(() => {
      this.loading.delete(ggufPath);
    });
    this.loading.set(ggufPath, loadPromise);
    return loadPromise;
  }

  async _loadEntry(ggufPath, modelGB) {
    const settings = this.getSettings() || {};
    const plan = chooseGpuOffload({
      vramGB: await this._vramGB(),
      modelGB,
      useGPU: settings.useGPU || 'auto',
      nGpuLayers: settings.nGpuLayers || '',
      cpuCount: os.cpus().length,
    });

    const lib = await loadLlamaModule();
    const llama = await getLlamaInstance();

    // Map the offload tier to node-llama-cpp's gpuLayers option.
    const gpuLayers = plan.useGPU ? (plan.nGpuLayers < 0 ? 'max' : plan.nGpuLayers) : 0;

    // ignoreMemorySafetyChecks: let the native backend be the source of truth for
    // memory instead of node-llama-cpp's JS-side pre-checks. Those checks compare
    // estimates against getVramState().free, which some backends report badly —
    // e.g. Vulkan on Windows can report free=0 (used underflows to a uint64)
    // even with gigabytes genuinely free, rejecting valid loads with "A context
    // size of 8192 is too large for the available VRAM". Real OOMs still surface
    // as native init failures and are handled by the CPU fallback below.
    const loadOptions = { modelPath: ggufPath, ignoreMemorySafetyChecks: true };
    // sequences: the context's default is a single sequence, but the app runs
    // one fresh session per chat call and concurrent expert turns may overlap
    // (round table). With only one sequence, the second call throws
    // "No sequences left". Four covers realistic concurrency without doubling
    // KV-cache memory for no benefit.
    const contextOptions = {
      contextSize: DEFAULT_CONTEXT,
      sequences: 4,
      ignoreMemorySafetyChecks: true,
    };

    let model;
    let context;
    try {
      model = await llama.loadModel({ ...loadOptions, gpuLayers });
      context = await model.createContext(contextOptions);
    } catch (error) {
      if (gpuLayers === 0) throw error;
      // Planned offload didn't fit — fall back to CPU so the model still runs.
      try {
        if (model) await model.dispose();
      } catch (_disposeError) {
        /* already disposed */
      }
      let cpuError = null;
      try {
        model = await llama.loadModel({ ...loadOptions, gpuLayers: 0 });
        context = await model.createContext(contextOptions);
      } catch (cpuLoadError) {
        cpuError = cpuLoadError;
        try {
          if (model) await model.dispose();
        } catch (_disposeError) {
          /* already disposed */
        }
        throw new Error(
          `Could not load the model with ${plan.tier === 'full' ? 'full GPU offload' : `${gpuLayers} GPU layers`} (${error.message}) or on CPU (${cpuError.message}). Close other GPU-heavy apps and try again, or lower the context/GPU settings.`,
        );
      }
    }

    const entry = { lib, llama, model, context, plan, embeddingContext: null, disposed: false };
    this.cache.set(ggufPath, entry);
    return entry;
  }

  async generateChat({ model, messages, signal, onChunk = () => {} } = {}) {
    const entry = await this._entryFor(model);
    const msgs = Array.isArray(messages) ? messages : [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    const history = msgs.slice(0, -1).map(toChatHistoryItem).filter(Boolean);
    const promptText = last ? String(last.content ?? last.text ?? '') : '';

    // A fresh session (and context sequence) per call keeps each turn fully
    // stateless and lets concurrent experts in the round table stay isolated.
    const sequence = entry.context.getSequence();
    const session = new entry.lib.LlamaChatSession({ contextSequence: sequence });
    let fullText = '';
    try {
      if (history.length) session.setChatHistory(history);
      const result = await session.prompt(promptText, {
        onTextChunk: (text) => {
          fullText += text;
          onChunk(text, fullText);
        },
        signal,
        stopOnAbortSignal: true,
      });
      if (!fullText && result) fullText = result;
    } finally {
      try {
        session.dispose();
      } catch (_error) {
        /* already disposed */
      }
      // LlamaChatSession.dispose() never releases the sequence by default
      // (autoDisposeSequence is false), and even when it does, it is
      // fire-and-forget: sequence reclamation is async. Await the sequence
      // disposal ourselves so the ID is returned to the context's pool before
      // the next call can request one — otherwise the second chat on the same
      // model fails with "No sequences left". Idempotent and safe to double-run.
      try {
        await sequence.dispose();
      } catch (_error) {
        /* already disposed */
      }
    }
    return (fullText || '').trim();
  }

  async generateChatSync({ model, messages } = {}) {
    return this.generateChat({ model, messages });
  }

  // Embeddings power retrieval: query and chunk vectors must come from the SAME
  // model (invariant #5). We keep one context per file so switching chat models
  // never disturbs the embedding index.
  //
  // Detailed form surfaces *why* an embedding failed (missing GGUF, load error,
  // empty vector) so the chat path can degrade gracefully instead of silently
  // returning zero results. The simple form below stays backward compatible.
  async generateEmbeddingDetailed({ model, input } = {}) {
    try {
      const entry = await this._entryFor(model);
      if (!entry.embeddingContext) {
        // Same rationale as _loadEntry: skip the JS-side VRAM pre-checks, which
        // can reject valid loads when the backend's free-VRAM reporting is broken.
        entry.embeddingContext = await entry.model.createEmbeddingContext({
          ignoreMemorySafetyChecks: true,
        });
      }
      const embedding = await entry.embeddingContext.getEmbeddingFor(String(input));
      if (!embedding || !embedding.vector || embedding.vector.length === 0) {
        return { vector: null, error: `Model "${model}" returned no embedding.` };
      }
      return { vector: Array.from(embedding.vector), error: null };
    } catch (error) {
      return { vector: null, error: error.message };
    }
  }

  async generateEmbedding({ model, input } = {}) {
    const { vector } = await this.generateEmbeddingDetailed({ model, input });
    return vector;
  }

  // Pre-flight an embedding model before a long ingest run (fail fast, with an
  // actionable reason). Mirrors OllamaService.checkEmbedding.
  async checkEmbedding(model) {
    if (!model) {
      return { ok: false, reason: 'No embedding model is configured.' };
    }
    try {
      const ggufPath = await this.resolveModelPath(model);
      if (!ggufPath) {
        return {
          ok: false,
          reason: `Embedding model "${model}" is not downloaded yet — get it from the model gallery.`,
        };
      }
      try {
        const stat = await fs.stat(ggufPath);
        if (stat.size === 0) {
          return {
            ok: false,
            reason: `Embedding model "${model}" has an empty file — download it again.`,
          };
        }
      } catch (_error) {
        return {
          ok: false,
          reason: `Embedding model "${model}" is not downloaded yet — get it from the model gallery.`,
        };
      }
      const probe = await this.generateEmbedding({ model, input: 'preflight' });
      if (!probe || probe.length === 0) {
        return {
          ok: false,
          reason: `Model "${model}" returned no embedding — it may not be an embedding model. Use the "Embeddings" model from the gallery.`,
        };
      }
      return { ok: true, dim: probe.length };
    } catch (error) {
      return { ok: false, reason: `Could not load embedding model "${model}": ${error.message}` };
    }
  }

  // Free native memory. Called on app quit; safe to call multiple times.
  async disposeAll() {
    for (const entry of this.cache.values()) {
      entry.disposed = true;
      try {
        if (entry.embeddingContext) await entry.embeddingContext.dispose();
      } catch (_error) {
        /* already disposed */
      }
      try {
        await entry.context.dispose();
      } catch (_error) {
        /* already disposed */
      }
      try {
        await entry.model.dispose();
      } catch (_error) {
        /* already disposed */
      }
    }
    this.cache.clear();
    this.loading.clear();
    // Release the shared native binding last (every model/context references it).
    try {
      if (llamaInstance && !llamaInstance.disposed) await llamaInstance.dispose();
    } catch (_error) {
      /* already disposed */
    }
    llamaInstance = null;
  }

  async deleteModel(name) {
    const ggufPath = await this.resolveModelPath(name);
    if (!ggufPath) {
      return { ok: false, reason: 'Model not found' };
    }
    try {
      await fs.unlink(ggufPath);
      await fs.rm(`${ggufPath}.sha256`, { force: true });
      this.cache.delete(ggufPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }
}

module.exports = { LlamaCppProvider, loadLlama, loadLlamaModule, getLlamaInstance };
