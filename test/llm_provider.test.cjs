'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { chooseGpuOffload, hardwareProfile } = require('../electron/llama/hardware.cjs');
const { downloadFile } = require('../electron/llama/downloader.cjs');
const { LlamaCppProvider } = require('../electron/llama/llamaCppProvider.cjs');
const { NativeWorkerProvider } = require('../electron/llama/nativeWorkerProvider.cjs');
const { OllamaProvider, createLLMProvider } = require('../electron/llmProvider.cjs');

// ---- Shared helpers -------------------------------------------------------------

// Run `fn(dir)` inside a fresh temp directory that is removed afterwards.
async function withTempDir(t, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-llm-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fn(dir);
}

// A Buffer's .buffer can be a shared pool (for small allocations); this returns
// an ArrayBuffer that is exactly the buffer's own bytes.
function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function streamBody(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

// A 200 response with a streaming body (like a real HTTP fetch).
function okStreamResponse(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-length', String(total)]]),
    body: streamBody(chunks),
  };
}

function abortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

// ---- VRAM offload planning (pure logic) ------------------------------------------

test('hardwareProfile reports sane machine facts', () => {
  const hw = hardwareProfile();
  assert.ok(hw.totalRamGB > 0, 'total RAM must be reported');
  assert.ok(hw.cpuCount >= 1, 'at least one CPU core');
  assert.equal(typeof hw.platform, 'string');
  assert.ok(hw.cpuModel.length > 0);
});

test('chooseGpuOffload: no VRAM means CPU tier with clamped thread count', () => {
  const plan = chooseGpuOffload({ vramGB: 0, ramGB: 16, modelGB: 5, cpuCount: 64 });
  assert.equal(plan.tier, 'cpu');
  assert.equal(plan.useGPU, false);
  assert.equal(plan.nGpuLayers, 0);
  assert.equal(plan.nThreads, 8, 'threads are capped at 8');

  const fewCores = chooseGpuOffload({ vramGB: 0, cpuCount: 1 });
  assert.equal(fewCores.nThreads, 2, 'threads are floored at 2');
});

test('chooseGpuOffload: VRAM comfortably holding the model means full offload', () => {
  const plan = chooseGpuOffload({ vramGB: 16, modelGB: 5 });
  assert.equal(plan.tier, 'full');
  assert.equal(plan.useGPU, true);
  assert.equal(plan.nGpuLayers, -1, '-1 = all layers');
});

test('chooseGpuOffload: moderate VRAM means partial offload with a sane layer count', () => {
  const plan = chooseGpuOffload({ vramGB: 5, modelGB: 8 });
  assert.equal(plan.tier, 'partial');
  assert.equal(plan.useGPU, true);
  assert.ok(plan.nGpuLayers >= 8 && plan.nGpuLayers <= 40, 'layer estimate stays in bounds');
});

test('chooseGpuOffload: tiny VRAM falls back to CPU', () => {
  const plan = chooseGpuOffload({ vramGB: 2, modelGB: 5 });
  assert.equal(plan.tier, 'cpu');
  assert.equal(plan.useGPU, false);
});

test('chooseGpuOffload: an explicit layer override wins (string or number, -1 = all)', () => {
  const all = chooseGpuOffload({ vramGB: 2, modelGB: 5, nGpuLayers: '-1' });
  assert.equal(all.tier, 'override');
  assert.equal(all.nGpuLayers, -1);

  const some = chooseGpuOffload({ vramGB: 16, modelGB: 5, nGpuLayers: '20' });
  assert.equal(some.tier, 'override');
  assert.equal(some.nGpuLayers, 20);
});

test('chooseGpuOffload: settings force the GPU off or on (stored as strings or booleans)', () => {
  assert.equal(chooseGpuOffload({ vramGB: 16, modelGB: 5, useGPU: 'false' }).tier, 'cpu');
  assert.equal(chooseGpuOffload({ vramGB: 16, modelGB: 5, useGPU: false }).tier, 'cpu');
  assert.equal(chooseGpuOffload({ vramGB: 16, modelGB: 5, useGPU: 'true' }).tier, 'full');
  assert.equal(chooseGpuOffload({ vramGB: 16, modelGB: 5, useGPU: true }).tier, 'full');
});

test('chooseGpuOffload: every plan carries a human-readable rationale', () => {
  for (const args of [
    { vramGB: 0, modelGB: 5 },
    { vramGB: 16, modelGB: 5 },
    { vramGB: 5, modelGB: 8 },
    { vramGB: 2, modelGB: 5 },
    { vramGB: 16, modelGB: 5, nGpuLayers: '12' },
    { vramGB: 16, modelGB: 5, useGPU: 'false' },
  ]) {
    assert.equal(typeof chooseGpuOffload(args).rationale, 'string');
  }
});

// ---- Download pipeline (resumable, cancellable, deterministic) -------------------

test('downloadFile streams the body, reports progress, and renames .part to final', async (t) =>
  withTempDir(t, async (dir) => {
    const dest = path.join(dir, 'model.gguf');
    const a = Buffer.from('hello ');
    const b = Buffer.from('world');
    const fetchImpl = async () => okStreamResponse([a, b]);

    const progress = [];
    const result = await downloadFile({
      url: 'https://example.invalid/model.gguf',
      destPath: dest,
      onProgress: (p) => progress.push(p),
      fetchImpl,
    });

    assert.equal(result.ok, true);
    assert.equal(result.name, 'model.gguf');
    assert.equal(await fs.readFile(dest, 'utf8'), 'hello world');
    await assert.rejects(fs.stat(dest + '.part'), 'no leftover .part file');

    assert.ok(
      progress.some((p) => p.status === 'downloading'),
      'saw progress while downloading',
    );
    assert.equal(progress.at(-1).status, 'complete');
    assert.equal(progress.at(-1).percent, 100);
    assert.equal(progress.at(-1).total, 11);
  }));

test('downloadFile resumes an existing .part with an HTTP Range request', async (t) =>
  withTempDir(t, async (dir) => {
    const dest = path.join(dir, 'model.gguf');
    await fs.writeFile(`${dest}.part`, 'hello');

    let sawRange = null;
    const fetchImpl = async (_url, opts) => {
      sawRange = opts.headers.Range;
      return {
        ok: true,
        status: 206,
        headers: new Map([['content-length', '5']]),
        body: streamBody([Buffer.from('world')]),
      };
    };

    const result = await downloadFile({
      url: 'https://example.invalid/model.gguf',
      destPath: dest,
      fetchImpl,
    });

    assert.equal(result.ok, true);
    assert.equal(sawRange, 'bytes=5-');
    assert.equal(await fs.readFile(dest, 'utf8'), 'helloworld');
  }));

test('downloadFile restarts cleanly when the server ignores Range (answers 200)', async (t) =>
  withTempDir(t, async (dir) => {
    const dest = path.join(dir, 'model.gguf');
    await fs.writeFile(`${dest}.part`, 'stale-bytes');

    const fetchImpl = async () => okStreamResponse([Buffer.from('fresh')]);

    const result = await downloadFile({
      url: 'https://example.invalid/model.gguf',
      destPath: dest,
      fetchImpl,
    });

    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(dest, 'utf8'), 'fresh', 'old .part bytes must not leak in');
  }));

test('downloadFile recovers from a 416 (offset past EOF) by starting over', async (t) =>
  withTempDir(t, async (dir) => {
    const dest = path.join(dir, 'model.gguf');
    await fs.writeFile(`${dest}.part`, 'stale');

    let calls = 0;
    const fetchImpl = async (_url, opts) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(opts.headers.Range, 'bytes=5-');
        return { ok: false, status: 416, headers: new Map() };
      }
      return okStreamResponse([Buffer.from('fresh')]);
    };

    const result = await downloadFile({
      url: 'https://example.invalid/model.gguf',
      destPath: dest,
      fetchImpl,
    });

    assert.equal(calls, 2, 'retried once without the bad offset');
    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(dest, 'utf8'), 'fresh');
  }));

test('downloadFile: an aborted request returns cancelled without touching the destination', async (t) =>
  withTempDir(t, async (dir) => {
    const dest = path.join(dir, 'model.gguf');
    const controller = new AbortController();
    controller.abort();

    const fetchImpl = async (_url, opts) => {
      if (opts.signal.aborted) throw abortError();
      return okStreamResponse([Buffer.from('x')]);
    };

    const result = await downloadFile({
      url: 'https://example.invalid/model.gguf',
      destPath: dest,
      signal: controller.signal,
      fetchImpl,
    });

    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    await assert.rejects(fs.stat(dest), 'no destination file after cancellation');
  }));

test('downloadFile: a mid-stream abort is reported as cancelled, not as a crash', async (t) =>
  withTempDir(t, async (dir) => {
    const dest = path.join(dir, 'model.gguf');
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-length', '100']]),
      body: {
        getReader: () => ({
          read: async () => {
            throw abortError();
          },
        }),
      },
    });

    const result = await downloadFile({
      url: 'https://example.invalid/model.gguf',
      destPath: dest,
      fetchImpl,
    });

    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    await assert.rejects(fs.stat(dest), 'the partial file must never be renamed into place');
  }));

test('downloadFile: an empty transfer is rejected instead of producing a zero-byte "model"', async (t) =>
  withTempDir(t, async (dir) => {
    const dest = path.join(dir, 'model.gguf');
    const fetchImpl = async () => okStreamResponse([]);

    const result = await downloadFile({
      url: 'https://example.invalid/model.gguf',
      destPath: dest,
      fetchImpl,
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /empty/i);
    await assert.rejects(fs.stat(dest));
    await assert.rejects(fs.stat(`${dest}.part`), 'the empty .part is cleaned up');
  }));

test('downloadFile: HTTP failures surface a reason, never a throw', async (t) =>
  withTempDir(t, async (dir) => {
    const dest = path.join(dir, 'model.gguf');
    const fetchImpl = async () => ({ ok: false, status: 500, headers: new Map() });

    const result = await downloadFile({
      url: 'https://example.invalid/model.gguf',
      destPath: dest,
      fetchImpl,
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /500/);
  }));

test('downloadFile: missing arguments fail fast with a reason', async () => {
  const missingUrl = await downloadFile({ destPath: '/tmp/never.gguf' });
  assert.equal(missingUrl.ok, false);
  const missingDest = await downloadFile({ url: 'https://example.invalid/x' });
  assert.equal(missingDest.ok, false);
});

test('downloadFile: non-streaming bodies (test stubs, some fetch impls) are handled', async (t) =>
  withTempDir(t, async (dir) => {
    const dest = path.join(dir, 'model.gguf');
    const payload = Buffer.from('GGUF-DATA');
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-length', String(payload.byteLength)]]),
      arrayBuffer: async () => toArrayBuffer(payload),
    });

    const result = await downloadFile({
      url: 'https://example.invalid/model.gguf',
      destPath: dest,
      fetchImpl,
    });

    assert.equal(result.ok, true);
    assert.equal(result.total, payload.byteLength);
    assert.equal(await fs.readFile(dest, 'utf8'), 'GGUF-DATA');
  }));

// ---- Built-in provider (no native lib involved in these paths) -------------------

test('LlamaCppProvider.listModels discovers .gguf files and ignores everything else', async (t) =>
  withTempDir(t, async (dir) => {
    const modelsDir = path.join(dir, 'models');
    await fs.mkdir(modelsDir);
    await fs.writeFile(path.join(modelsDir, 'Alpha-7B.gguf'), 'x');
    await fs.writeFile(path.join(modelsDir, 'Beta-8B.GGUF'), 'y');
    await fs.writeFile(path.join(modelsDir, 'notes.txt'), 'not a model');

    const provider = new LlamaCppProvider({ modelsDir, getSettings: () => ({}) });
    const models = await provider.listModels();

    assert.deepEqual(
      models.map((m) => m.name),
      ['Alpha-7B', 'Beta-8B'],
    );
    assert.equal(models[0].isAvailable, true);
  }));

test('LlamaCppProvider.listModels tolerates a missing models folder (first run)', async (t) =>
  withTempDir(t, async (dir) => {
    const provider = new LlamaCppProvider({ modelsDir: path.join(dir, 'does-not-exist') });
    assert.deepEqual(await provider.listModels(), []);
  }));

test('resolveModelPath maps catalog ids, filenames, and absolute paths', async (t) =>
  withTempDir(t, async (dir) => {
    const provider = new LlamaCppProvider({ modelsDir: dir });

    assert.equal(await provider.resolveModelPath('my-model'), path.join(dir, 'my-model.gguf'));
    assert.equal(await provider.resolveModelPath('my-model.gguf'), path.join(dir, 'my-model.gguf'));
    assert.equal(
      await provider.resolveModelPath('  spaced name  '),
      path.join(dir, 'spaced name.gguf'),
    );

    const absolute = path.join(os.tmpdir(), 'somewhere', 'custom.gguf');
    assert.equal(
      await provider.resolveModelPath(absolute),
      absolute,
      'absolute paths are used as-is',
    );

    assert.equal(await provider.resolveModelPath(''), null);
    assert.equal(await provider.resolveModelPath(null), null);

    // A missing file resolves to its expected path so callers can report it accurately.
    assert.equal(
      await provider.resolveModelPath('ghost-model'),
      path.join(dir, 'ghost-model.gguf'),
    );
  }));

test('resolveModelPath falls back to a case-insensitive match for dropped files', async (t) =>
  withTempDir(t, async (dir) => {
    await fs.writeFile(path.join(dir, 'My-Model.GGUF'), 'x');
    const provider = new LlamaCppProvider({ modelsDir: dir });

    // "My-Model" (as listModels reports it) must resolve to the real file whatever
    // the filesystem's case sensitivity — the invariant is a stat-able path, and
    // the name is only ever compared case-insensitively.
    const resolved = await provider.resolveModelPath('My-Model');
    assert.equal(path.basename(resolved).toLowerCase(), 'my-model.gguf');
    const stat = await fs.stat(resolved);
    assert.equal(stat.size, 1);
  }));

test('catalogUrl builds a working HuggingFace download URL', () => {
  const provider = new LlamaCppProvider({ modelsDir: '/models' });
  assert.equal(
    provider.catalogUrl({ repo: 'org/repo', file: 'model v2.gguf' }),
    'https://huggingface.co/org/repo/resolve/main/model%20v2.gguf?download=true',
  );
});

test('pullModel downloads a catalog entry into the models folder by its id', async (t) =>
  withTempDir(t, async (dir) => {
    const modelsDir = path.join(dir, 'models');
    const provider = new LlamaCppProvider({
      modelsDir,
      getSettings: () => ({}),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Map([['content-length', '7']]),
        arrayBuffer: async () => toArrayBuffer(Buffer.from('GGUF!!1')),
      }),
    });

    const result = await provider.pullModel({ name: 'Qwen2.5-3B-Instruct-Q4_K_M' });
    assert.equal(result.ok, true);
    assert.equal(result.name, 'Qwen2.5-3B-Instruct-Q4_K_M');

    const file = path.join(modelsDir, 'Qwen2.5-3B-Instruct-Q4_K_M.gguf');
    assert.equal(await fs.readFile(file, 'utf8'), 'GGUF!!1');

    // The download now shows up as an installed local model.
    const models = await provider.listModels();
    assert.deepEqual(
      models.map((m) => m.name),
      ['Qwen2.5-3B-Instruct-Q4_K_M'],
    );
  }));

test('pullModel rejects unknown names with an actionable reason', async (t) =>
  withTempDir(t, async (dir) => {
    const provider = new LlamaCppProvider({ modelsDir: path.join(dir, 'models') });
    const result = await provider.pullModel({ name: 'not-in-the-gallery' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /gallery/i);
    assert.match(result.reason, /models folder/i);
  }));

test('pullModel with no name fails fast', async (t) =>
  withTempDir(t, async (dir) => {
    const provider = new LlamaCppProvider({ modelsDir: path.join(dir, 'models') });
    const result = await provider.pullModel({});
    assert.equal(result.ok, false);
    assert.match(result.reason, /no model/i);
  }));

test('NativeWorkerProvider sends only structured-cloneable arguments to the worker', async () => {
  // utilityProcess.postMessage cannot clone functions or AbortSignals. Passing
  // the provider options straight through made every download and every chat
  // request fail with "An object could not be cloned."
  const calls = [];
  const provider = new NativeWorkerProvider({ modelsDir: 'models' });
  provider._call = (method, args, callbacks) => {
    calls.push({ method, args, callbacks });
    return Promise.resolve({ ok: true });
  };

  const controller = new AbortController();
  const onProgress = () => {};

  await provider.pullModel({ name: 'Demo-8B', signal: controller.signal, onProgress });
  assert.deepEqual(calls[0].args, { name: 'Demo-8B' });
  assert.equal(calls[0].callbacks.signal, controller.signal);
  assert.equal(calls[0].callbacks.onProgress, onProgress);
  assert.doesNotThrow(() => structuredClone(calls[0].args));

  const onChunk = () => {};
  const messages = [{ role: 'user', content: 'Hi' }];
  await provider.generateChat({ model: 'Demo-8B', messages, signal: controller.signal, onChunk });
  assert.deepEqual(calls[1].args, { model: 'Demo-8B', messages });
  assert.equal(calls[1].callbacks.onChunk, onChunk);
  assert.doesNotThrow(() => structuredClone(calls[1].args));
});

test('checkEmbedding fails fast with an actionable reason when the model is not downloaded', async (t) =>
  withTempDir(t, async (dir) => {
    const provider = new LlamaCppProvider({ modelsDir: path.join(dir, 'models') });

    const missing = await provider.checkEmbedding('nomic-embed-text-v1.5');
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /not downloaded/i);

    const unset = await provider.checkEmbedding('');
    assert.equal(unset.ok, false);
    assert.match(unset.reason, /no embedding model/i);
  }));

test('builtin getCatalog flags installed models and reports hardware fit consistently', async (t) =>
  withTempDir(t, async (dir) => {
    const modelsDir = path.join(dir, 'models');
    await fs.mkdir(modelsDir);
    await fs.writeFile(path.join(modelsDir, 'Qwen2.5-3B-Instruct-Q4_K_M.gguf'), 'x');

    const provider = new LlamaCppProvider({ modelsDir });
    const catalog = await provider.getCatalog();

    assert.equal(catalog.installed.length, 1);
    assert.equal(catalog.installed[0], 'Qwen2.5-3B-Instruct-Q4_K_M');

    const qwen = catalog.models.find((m) => m.id === 'Qwen2.5-3B-Instruct-Q4_K_M');
    assert.equal(qwen.installed, true);
    const llama = catalog.models.find((m) => m.id === 'Llama-3.1-8B-Instruct-Q4_K_M');
    assert.equal(llama.installed, false);

    // The fits flag must always agree with the reported hardware, whatever the
    // test machine is (CI laptops to workstations).
    for (const model of catalog.models) {
      assert.equal(model.fits, catalog.hardware.totalRamGB >= model.minRamGB, model.id);
    }

    // Every entry must be downloadable: a well-formed HuggingFace URL.
    for (const model of catalog.models) {
      assert.match(model.url, /^https:\/\/huggingface\.co\/.+/);
    }

    // The embedding model is the one required entry.
    const required = catalog.models.filter((m) => m.required);
    assert.equal(required.length, 1);
    assert.equal(required[0].role, 'embedding');
  }));

// ---- Ollama provider (delegation, network stubbed) -------------------------------

function stubOllamaFetch() {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /\/api\/tags$/);
    return {
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3.1:8b', size: 12345, modified_at: '2026-04-06T12:00:00Z' }],
      }),
    };
  };
  return () => {
    global.fetch = originalFetch;
  };
}

test('OllamaProvider delegates listModels to the Ollama service', async (t) => {
  const restore = stubOllamaFetch();
  t.after(restore);

  const provider = new OllamaProvider({ getBaseUrl: () => 'http://localhost:11434' });
  const models = await provider.listModels();

  assert.deepEqual(models, [
    {
      name: 'llama3.1:8b',
      size: 12345,
      modifiedAt: '2026-04-06T12:00:00Z',
      isAvailable: true,
      role: 'chat',
    },
  ]);
});

test('OllamaProvider labels known embedding models so the UI can filter them', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ models: [{ name: 'nomic-embed-text:latest', size: 1 }] }),
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const provider = new OllamaProvider({ getBaseUrl: () => 'http://localhost:11434' });
  const models = await provider.listModels();

  assert.equal(models[0].name, 'nomic-embed-text:latest');
  assert.equal(models[0].role, 'embedding');
});

test('OllamaProvider.getCatalog marks models present in Ollama as installed', async (t) => {
  const restore = stubOllamaFetch();
  t.after(restore);

  const provider = new OllamaProvider({ getBaseUrl: () => 'http://localhost:11434' });
  const catalog = await provider.getCatalog();

  const llama = catalog.models.find((m) => m.name === 'llama3.1:8b');
  assert.equal(llama.installed, true);
  const nomic = catalog.models.find((m) => m.name === 'nomic-embed-text');
  assert.equal(nomic.installed, false);

  for (const model of catalog.models) {
    assert.equal(model.fits, catalog.hardware.totalRamGB >= model.minRamGB, model.name);
  }
});

test('OllamaProvider.getCatalog treats a tagged :latest model as installed', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ models: [{ name: 'nomic-embed-text:latest', size: 1 }] }),
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const provider = new OllamaProvider({ getBaseUrl: () => 'http://localhost:11434' });
  const catalog = await provider.getCatalog();

  const nomic = catalog.models.find((m) => m.name === 'nomic-embed-text');
  assert.equal(nomic.installed, true);
});

test('OllamaProvider.getCatalog keeps uncatalogued downloaded models visible', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      models: [
        { name: 'llama3.1:8b', size: 4_700_000_000 },
        { name: 'hf.co/acme/Custom-9B-GGUF:Q4_K_M', size: 5_000_000_000 },
        { name: 'acme-embed:latest', size: 300_000_000, capabilities: ['embedding'] },
      ],
    }),
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const provider = new OllamaProvider({ getBaseUrl: () => 'http://localhost:11434' });
  const catalog = await provider.getCatalog();

  // Curated entry still present exactly once.
  assert.equal(catalog.models.filter((m) => m.name === 'llama3.1:8b').length, 1);
  assert.equal(catalog.models.find((m) => m.name === 'llama3.1:8b').installed, true);

  // Downloaded models that are not in the curated catalog must not disappear.
  const custom = catalog.models.find((m) => m.name === 'hf.co/acme/Custom-9B-GGUF:Q4_K_M');
  assert.ok(custom, 'uncatalogued Ollama model is included in the gallery');
  assert.equal(custom.installed, true);
  assert.equal(custom.source, 'ollama');
  assert.equal(custom.sizeGB, 5);

  // Capabilities identify embedding models even when they are not curated.
  const embedder = catalog.models.find((m) => m.name === 'acme-embed:latest');
  assert.equal(embedder.role, 'embedding');

  // No duplicate rows for the same downloaded model.
  assert.equal(
    catalog.models.filter((m) => m.name === 'hf.co/acme/Custom-9B-GGUF:Q4_K_M').length,
    1,
  );
});

test('listAllModels tags both engines and tolerates an unreachable Ollama', async (t) =>
  withTempDir(t, async (dir) => {
    const modelsDir = path.join(dir, 'models');
    await fs.mkdir(modelsDir);
    await fs.writeFile(path.join(modelsDir, 'Demo-8B.gguf'), 'x');

    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('Ollama is not running');
    };
    t.after(() => {
      global.fetch = originalFetch;
    });

    const provider = createLLMProvider({ getSettings: () => ({}), userDataPath: dir });
    const models = await provider.listAllModels();

    assert.deepEqual(
      models.map((m) => ({ name: m.name, engine: m.engine })),
      [{ name: 'Demo-8B', engine: 'builtin' }],
    );
    await provider.disposeAll();
  }));

test('listAllModels returns tagged models from both engines', async (t) =>
  withTempDir(t, async (dir) => {
    const modelsDir = path.join(dir, 'models');
    await fs.mkdir(modelsDir);
    await fs.writeFile(path.join(modelsDir, 'Demo-8B.gguf'), 'x');

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'mistral:7b', size: 123 }] }),
    });
    t.after(() => {
      global.fetch = originalFetch;
    });

    const provider = createLLMProvider({
      getSettings: () => ({ llmProvider: 'builtin' }),
      userDataPath: dir,
    });
    const models = await provider.listAllModels();

    assert.deepEqual(
      models.map((m) => ({ name: m.name, engine: m.engine })),
      [
        { name: 'Demo-8B', engine: 'builtin' },
        { name: 'mistral:7b', engine: 'ollama' },
      ],
    );
    await provider.disposeAll();
  }));

test('OllamaProvider.pullModel streams progress from Ollama NDJSON', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /\/api\/pull$/);
    const lines = [
      JSON.stringify({ status: 'pulling', total: 100, completed: 25 }),
      JSON.stringify({ status: 'pulling', total: 100, completed: 100 }),
    ].join('\n');
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${lines}\n`));
          controller.close();
        },
      }),
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const provider = new OllamaProvider({ getBaseUrl: () => 'http://localhost:11434' });
  const progress = [];
  const result = await provider.pullModel({
    name: 'llama3.1:8b',
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result.ok, true);
  assert.equal(result.name, 'llama3.1:8b');
  assert.equal(progress.at(-1).percent, 100);
});

// ---- Facade: one interface, runtime switchable ------------------------------------

test('createLLMProvider defaults to the built-in engine (no Ollama needed)', async (t) =>
  withTempDir(t, async (dir) => {
    const modelsDir = path.join(dir, 'models');
    await fs.mkdir(modelsDir);
    await fs.writeFile(path.join(modelsDir, 'Demo-8B.gguf'), 'x');

    const provider = createLLMProvider({ getSettings: () => ({}), userDataPath: dir });
    assert.equal(provider.kind, 'builtin');

    const models = await provider.listModels();
    assert.deepEqual(
      models.map((m) => m.name),
      ['Demo-8B'],
    );

    const status = provider._builtin.getStatus;
    assert.equal(typeof status, 'function', 'provider interface is fully wired');

    await provider.disposeAll();
  }));

test('createLLMProvider switches engines at runtime based on settings', async (t) => {
  const restore = stubOllamaFetch();
  t.after(restore);

  const settings = {};
  const provider = await withTempDir(t, async (dir) => {
    const p = createLLMProvider({ getSettings: () => settings, userDataPath: dir });
    assert.equal(p.kind, 'builtin', 'default is the built-in engine');

    settings.llmProvider = 'ollama';
    assert.equal(p.kind, 'ollama', 'switching is a settings change, not a restart');

    const models = await p.listModels();
    assert.equal(models[0].name, 'llama3.1:8b');

    settings.llmProvider = 'builtin';
    assert.equal(p.kind, 'builtin');
    await p.disposeAll();
    return p;
  });
  assert.equal(provider.kind, 'builtin');
});

test('disposeAll is idempotent and safe with no loaded models', async (t) =>
  withTempDir(t, async (dir) => {
    const provider = createLLMProvider({ getSettings: () => ({}), userDataPath: dir });
    await provider.disposeAll();
    await provider.disposeAll();
  }));
