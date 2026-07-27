const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const fsSync = require('node:fs');
const { BrowserWindow, dialog, ipcMain, powerMonitor, safeStorage } = require('electron');

const channels = require('../shared/channels.json');
const expertCatalog = require('../shared/expertCatalog.json');
const modelCatalog = require('../shared/modelCatalog.json');
const {
  ConversationRepository,
  isDatabaseEncrypted,
  canOpenWithPassphrase,
  rekeyDatabase,
} = require('./repository.cjs');
const { OllamaService } = require('./ollama.cjs');
const { MemoryManager } = require('./memory/memoryManager.cjs');
const { DeepResearchWorker } = require('./research/deepResearch.cjs');
const { buildChatContext } = require('./contextBuilder.cjs');
const { RoundtableOrchestrator } = require('./roundtable.cjs');

function stampFilename(prefix) {
  const value = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${value}.json`;
}

function registerIpcHandlers({ userDataPath }) {
  const dbPath = path.join(userDataPath, 'sidekick.db');
  // Where the OS-keychain-wrapped passphrase lives when "remember on this device"
  // is enabled. It holds an encrypted blob, never the passphrase itself.
  const keyCachePath = path.join(userDataPath, 'sidekick.keycache');

  // When the corpus is encrypted the repository CANNOT be opened until the user
  // supplies a passphrase, so construction is deferred. Everything that holds a
  // repository reference is built at the same moment (handlers read these variables
  // at call time, so they pick up the real instances once assigned).
  let repository = null;
  let memoryManager = null;
  let researchWorker = null;

  const ollama = new OllamaService({
    getBaseUrl: () =>
      (repository && repository.getSetting('ollamaBaseUrl')) || 'http://localhost:11434',
  });

  const activeGenerations = new Map();
  // requestIds for which the user pressed "Answer now": the orchestrator checks this
  // between turns to skip remaining rounds and go straight to the moderator.
  const wrapUpRequests = new Set();

  function openRepository(passphrase = null) {
    repository = new ConversationRepository(dbPath, { passphrase });
    memoryManager = new MemoryManager({ repository, ollama });
    researchWorker = new DeepResearchWorker({ repository, ollama });

    // Record the session opening, and any integrity problem, as the first audit
    // entries — a gap in the session record is itself a signal.
    repository.appendAudit({ action: 'app.open', detail: `schema v${repository.getSchemaVersion()}` });
    if (repository.integrity && repository.integrity.ok === false) {
      repository.appendAudit({ action: 'integrity.failed', detail: repository.integrity.detail });
    }
    return repository;
  }

  function closeRepository() {
    try { if (repository) repository.close(); } catch (_e) { /* ignore */ }
    repository = null;
    memoryManager = null;
    researchWorker = null;
  }

  // Channels that must work while the corpus is locked (the lock screen itself).
  const UNLOCKED_CHANNELS = new Set(Object.values(channels.security || {}));

  // Every other handler refuses to run while locked, rather than throwing an opaque
  // null-reference error. The renderer shows the lock screen on this signal.
  function handleSecure(channel, fn) {
    ipcMain.handle(channel, async (...args) => {
      if (!repository && !UNLOCKED_CHANNELS.has(channel)) {
        const error = new Error('Sidekick is locked — unlock with your passphrase to continue.');
        error.code = 'LOCKED';
        throw error;
      }
      return fn(...args);
    });
  }

  // A plaintext corpus opens immediately; an encrypted one waits for the passphrase.
  if (!isDatabaseEncrypted(dbPath)) {
    openRepository(null);
  }

  // ---- Security: app lock & encryption at rest ----------------------------------
  // "Remember on this device" wraps the passphrase with the OS keychain via
  // safeStorage. The plaintext passphrase is never written to disk, and the cache is
  // useless on another machine or another OS account.
  function cacheRemembered(passphrase) {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      fsSync.writeFileSync(keyCachePath, safeStorage.encryptString(passphrase));
      return true;
    } catch (error) {
      console.error('Could not remember passphrase:', error.message);
      return false;
    }
  }

  function readRemembered() {
    try {
      if (!fsSync.existsSync(keyCachePath) || !safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(fsSync.readFileSync(keyCachePath));
    } catch (_error) {
      return null;
    }
  }

  function forgetRemembered() {
    try { fsSync.rmSync(keyCachePath, { force: true }); } catch (_e) { /* ignore */ }
  }

  function securityStatus() {
    const encrypted = isDatabaseEncrypted(dbPath);
    return {
      encrypted,
      unlocked: Boolean(repository),
      // Locked only means "encrypted and not yet opened this session".
      locked: encrypted && !repository,
      remembered: fsSync.existsSync(keyCachePath),
      keychainAvailable: safeStorage.isEncryptionAvailable(),
    };
  }

  // ---- Auto-lock on idle ---------------------------------------------------------
  // Uses OS-level idle time rather than window focus: "the user walked away" is the
  // condition worth locking on, and working in another app should NOT trigger it.
  // Enforced in the main process so a wedged renderer cannot keep the corpus open.
  function lockNow(reason) {
    if (!repository) return;
    repository.appendAudit({ action: 'security.autolock', detail: reason });
    closeRepository();
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(channels.events.locked, { reason });
    }
  }

  function startAutoLockWatcher() {
    setInterval(() => {
      try {
        // Read the setting each tick so a change takes effect without a restart.
        if (!repository || !isDatabaseEncrypted(dbPath)) return;
        const minutes = Number(repository.getSetting('autoLockMinutes') || 0);
        if (!minutes || minutes <= 0) return;
        if (powerMonitor.getSystemIdleTime() >= minutes * 60) {
          lockNow(`idle for ${minutes} minute${minutes === 1 ? '' : 's'}`);
        }
      } catch (_error) {
        // A failing watcher must never take the app down.
      }
    }, 30_000).unref?.();

    // Walking away is often signalled explicitly — honour those immediately.
    powerMonitor.on('suspend', () => lockNow('system suspended'));
    powerMonitor.on('lock-screen', () => lockNow('workstation locked'));
  }

  startAutoLockWatcher();

  ipcMain.handle(channels.security.status, async () => securityStatus());

  ipcMain.handle(channels.security.unlock, async (_event, { passphrase, useRemembered = false } = {}) => {
    if (repository) return { unlocked: true, ...securityStatus() };

    const secret = useRemembered ? readRemembered() : passphrase;
    if (!secret) {
      return { unlocked: false, reason: useRemembered ? 'No remembered passphrase on this device.' : 'Enter your passphrase.' };
    }
    if (!canOpenWithPassphrase(dbPath, secret)) {
      // Do not distinguish "wrong passphrase" from "corrupt file" any further than
      // this — and never log the attempt's input.
      return { unlocked: false, reason: 'That passphrase did not open the corpus.' };
    }

    openRepository(secret);
    repository.appendAudit({ action: 'security.unlock', detail: useRemembered ? 'via device keychain' : 'via passphrase' });
    return { unlocked: true, ...securityStatus() };
  });

  ipcMain.handle(channels.security.lock, async () => {
    if (repository) repository.appendAudit({ action: 'security.lock' });
    closeRepository();
    return securityStatus();
  });

  ipcMain.handle(channels.security.enable, async (_event, { passphrase, remember = false } = {}) => {
    if (isDatabaseEncrypted(dbPath)) {
      return { ok: false, reason: 'The corpus is already encrypted.' };
    }
    if (!passphrase || passphrase.length < 8) {
      return { ok: false, reason: 'Choose a passphrase of at least 8 characters.' };
    }

    // The rekey rewrites every page, so the database must be closed first.
    if (repository) repository.appendAudit({ action: 'security.encrypt.start' });
    closeRepository();

    try {
      const result = rekeyDatabase({ filename: dbPath, newPassphrase: passphrase, backupTag: 'encrypt' });
      openRepository(passphrase);
      repository.appendAudit({ action: 'security.encrypt.done', detail: `backup ${result.backupPath}` });
      if (remember) cacheRemembered(passphrase);
      return { ok: true, backupPath: result.backupPath, ...securityStatus() };
    } catch (error) {
      // Reopen whatever state the corpus is in so the app is never left dead.
      try { openRepository(isDatabaseEncrypted(dbPath) ? passphrase : null); } catch (_e) { /* stays locked */ }
      return { ok: false, reason: error.message };
    }
  });

  ipcMain.handle(channels.security.disable, async (_event, { passphrase } = {}) => {
    if (!isDatabaseEncrypted(dbPath)) {
      return { ok: false, reason: 'The corpus is not encrypted.' };
    }
    if (!canOpenWithPassphrase(dbPath, passphrase)) {
      return { ok: false, reason: 'That passphrase did not open the corpus.' };
    }

    closeRepository();
    try {
      const result = rekeyDatabase({ filename: dbPath, currentPassphrase: passphrase, newPassphrase: '', backupTag: 'decrypt' });
      forgetRemembered();
      openRepository(null);
      repository.appendAudit({ action: 'security.decrypt.done', detail: `backup ${result.backupPath}` });
      return { ok: true, backupPath: result.backupPath, ...securityStatus() };
    } catch (error) {
      try { openRepository(isDatabaseEncrypted(dbPath) ? passphrase : null); } catch (_e) { /* stays locked */ }
      return { ok: false, reason: error.message };
    }
  });

  ipcMain.handle(channels.security.changePassphrase, async (_event, { currentPassphrase, newPassphrase, remember = false } = {}) => {
    if (!isDatabaseEncrypted(dbPath)) {
      return { ok: false, reason: 'The corpus is not encrypted.' };
    }
    if (!newPassphrase || newPassphrase.length < 8) {
      return { ok: false, reason: 'Choose a passphrase of at least 8 characters.' };
    }
    if (!canOpenWithPassphrase(dbPath, currentPassphrase)) {
      return { ok: false, reason: 'The current passphrase is incorrect.' };
    }

    closeRepository();
    try {
      const result = rekeyDatabase({
        filename: dbPath,
        currentPassphrase,
        newPassphrase,
        backupTag: 'rekey',
      });
      openRepository(newPassphrase);
      repository.appendAudit({ action: 'security.passphrase.changed', detail: `backup ${result.backupPath}` });
      forgetRemembered();
      if (remember) cacheRemembered(newPassphrase);
      return { ok: true, backupPath: result.backupPath, ...securityStatus() };
    } catch (error) {
      try { openRepository(currentPassphrase); } catch (_e) { /* stays locked */ }
      return { ok: false, reason: error.message };
    }
  });

  ipcMain.handle(channels.security.setRemember, async (_event, { remember, passphrase } = {}) => {
    if (!remember) {
      forgetRemembered();
      if (repository) repository.appendAudit({ action: 'security.forgetDevice' });
      return securityStatus();
    }
    if (!isDatabaseEncrypted(dbPath) || !canOpenWithPassphrase(dbPath, passphrase)) {
      return { ...securityStatus(), error: 'A correct passphrase is required to remember it.' };
    }
    cacheRemembered(passphrase);
    if (repository) repository.appendAudit({ action: 'security.rememberDevice' });
    return securityStatus();
  });

  // ---- Model catalog & downloads --------------------------------------------------
  // Recommendations are based on total system RAM. GPU VRAM would be a better
  // signal but cannot be read reliably cross-platform (Windows WMI AdapterRAM
  // under-reports modern cards — an RTX 5080 reports 4 GB), so we name the GPU and
  // size on RAM rather than assert a VRAM figure we do not trust.
  function hardwareProfile() {
    const totalRamGB = os.totalmem() / 1024 ** 3;
    return {
      totalRamGB: Number(totalRamGB.toFixed(1)),
      freeRamGB: Number((os.freemem() / 1024 ** 3).toFixed(1)),
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model?.trim() || 'unknown',
      platform: process.platform,
    };
  }

  // These run while LOCKED too: a first-run user has no corpus yet, and someone with
  // an encrypted corpus may still need to fix a missing model before unlocking.
  ipcMain.handle(channels.models.hardware, async () => hardwareProfile());

  ipcMain.handle(channels.models.catalog, async () => {
    const hardware = hardwareProfile();
    const installed = await ollama.listModels().catch(() => []);
    const installedNames = new Set(installed.map((m) => m.name));

    return {
      hardware,
      installed: installed.map((m) => m.name),
      models: modelCatalog.models.map((model) => ({
        ...model,
        // Match "llama3.1:8b" against an installed "llama3.1:8b" or "llama3.1:8b-...".
        installed: [...installedNames].some((n) => n === model.name || n.startsWith(`${model.name}-`)),
        fits: hardware.totalRamGB >= model.minRamGB,
        tight: hardware.totalRamGB >= model.minRamGB && hardware.totalRamGB < model.minRamGB * 1.5,
      })),
    };
  });

  ipcMain.handle(channels.models.pull, async (event, { name } = {}) => {
    if (!name) return { ok: false, reason: 'No model selected.' };

    const controller = new AbortController();
    activeGenerations.set(`pull:${name}`, controller);
    try {
      const result = await ollama.pullModel({
        name,
        signal: controller.signal,
        onProgress: (progress) => {
          event.sender.send(channels.events.modelPull, { name, ...progress });
        },
      });
      // Only audit once the corpus is open — a first-run pull happens before it is.
      if (repository && result.ok) {
        repository.appendAudit({ action: 'model.pull', detail: name });
      }
      return result;
    } finally {
      activeGenerations.delete(`pull:${name}`);
    }
  });

  handleSecure(channels.models.list, async () => {
    return ollama.listModels();
  });

  handleSecure(channels.models.getActive, async () => {
    const savedModel = repository.getSetting('activeModel');
    if (savedModel) {
      return savedModel;
    }

    const models = await ollama.listModels();
    const firstModel = models[0]?.name || '';
    if (firstModel) {
      repository.setSetting('activeModel', firstModel);
    }
    return firstModel;
  });

  handleSecure(channels.models.setActive, async (_event, modelName) => {
    repository.setSetting('activeModel', modelName);
    return modelName;
  });

  handleSecure(channels.ollama.status, async () => {
    return ollama.getStatus();
  });

  // Settings Handlers
  handleSecure(channels.settings.get, async () => {
    return repository.getAllSettings();
  });

  handleSecure(channels.settings.set, async (_event, { key, value }) => {
    // Record that a setting changed, but never the value of a secret.
    const isSecret = /apikey$/i.test(key);
    repository.appendAudit({
      action: 'settings.set',
      detail: isSecret ? `${key}=<redacted>` : `${key}=${value}`,
    });
    repository.setSetting(key, value);
    return repository.getAllSettings();
  });

  // Profile Handlers
  handleSecure(channels.profile.get, async () => {
    return repository.getUserProfile();
  });

  handleSecure(channels.profile.set, async (_event, profileObj) => {
    return repository.setUserProfile(profileObj);
  });

  // Specialist Hub Handlers
  handleSecure(channels.specialist.list, async () => {
    return repository.listSpecialistHubs();
  });

  handleSecure(channels.specialist.get, async (_event, id) => {
    return repository.getSpecialistHub(id);
  });

  handleSecure(channels.specialist.create, async (_event, hubData) => {
    return repository.createSpecialistHub(hubData);
  });

  handleSecure(channels.specialist.update, async (_event, hubData) => {
    return repository.updateSpecialistHub(hubData);
  });

  handleSecure(channels.specialist.delete, async (_event, id) => {
    const hub = repository.getSpecialistHub(id);
    const success = repository.deleteSpecialistHub(id);
    if (success) {
      repository.appendAudit({
        action: 'expert.delete',
        detail: hub ? `${hub.name} (${hub.chunkCount} chunks)` : id,
      });
    }
    return { success };
  });

  // Notes: editable knowledge attached to an Expert. Every write re-embeds the note
  // so what the model can retrieve always matches what the user wrote.
  handleSecure(channels.notes.list, async (_event, hubId) => {
    return repository.listNotes(hubId);
  });

  handleSecure(channels.notes.create, async (_event, payload) => {
    const embeddingModel = repository.getSetting('embeddingModel');
    const preflight = await ollama.checkEmbedding(embeddingModel);
    const note = repository.createNote(payload);
    if (!preflight.ok) {
      return { note, indexed: false, reason: preflight.reason };
    }
    const result = await researchWorker.indexNote({ note, embeddingModel });
    return { note, indexed: result.success, reason: result.reason, chunksCount: result.chunksCount };
  });

  handleSecure(channels.notes.update, async (_event, payload) => {
    const note = repository.updateNote(payload);
    if (!note) {
      throw new Error('Note not found.');
    }
    const embeddingModel = repository.getSetting('embeddingModel');
    const preflight = await ollama.checkEmbedding(embeddingModel);
    if (!preflight.ok) {
      return { note, indexed: false, reason: preflight.reason };
    }
    const result = await researchWorker.indexNote({ note, embeddingModel });
    return { note, indexed: result.success, reason: result.reason, chunksCount: result.chunksCount };
  });

  handleSecure(channels.notes.delete, async (_event, id) => {
    const note = repository.getNote(id);
    const success = repository.deleteNote(id);
    if (success) repository.appendAudit({ action: 'note.delete', detail: note ? note.title : id });
    return { success };
  });

  // Expert Library: curated recipe packs. A template ships a persona plus a seed
  // research brief; installing creates the Expert instantly and (optionally) runs
  // that research on THIS machine, so no third-party content is redistributed
  // (ROADMAP Stage 7 — licensing).
  handleSecure(channels.specialist.catalog, async () => {
    const installed = repository.listSpecialistHubs().map((hub) => hub.name.toLowerCase());
    return {
      ...expertCatalog,
      templates: expertCatalog.templates.map((template) => ({
        ...template,
        alreadyInstalled: installed.includes(template.name.toLowerCase()),
      })),
    };
  });

  handleSecure(channels.specialist.installFromCatalog, async (event, { templateId, runResearch = true }) => {
    const template = expertCatalog.templates.find((t) => t.id === templateId);
    if (!template) {
      throw new Error('Unknown Expert template.');
    }

    // The persona is available immediately — research fills the vault afterwards, so
    // the Expert is usable (ungrounded, and labelled as such) from the first second.
    const hub = repository.createSpecialistHub({
      name: template.name,
      description: template.description,
      systemPrompt: template.systemPrompt,
      icon: template.icon || 'brain',
    });

    if (!runResearch) {
      return { installed: true, hub, researched: false };
    }

    const embeddingModel = repository.getSetting('embeddingModel');
    const preflight = await ollama.checkEmbedding(embeddingModel);
    if (!preflight.ok) {
      return { installed: true, hub, researched: false, reason: preflight.reason };
    }

    let model = repository.getSetting('activeModel');
    if (!model) {
      const models = await ollama.listModels();
      model = models[0]?.name || '';
    }

    const allSettings = repository.getAllSettings();
    const research = await researchWorker.runWebDeepResearch({
      hubId: hub.id,
      topic: template.seedResearch,
      model: repository.getSetting('backgroundModel') || model,
      embeddingModel,
      searchOptions: {
        provider: allSettings.searchProvider || 'duckduckgo',
        searxngUrl: allSettings.searxngUrl,
        tavilyApiKey: allSettings.tavilyApiKey,
        braveApiKey: allSettings.braveApiKey,
      },
      onProgress: (progress) => {
        event.sender.send(channels.events.researchProgress, { hubId: hub.id, ...progress });
      },
    });

    return {
      installed: true,
      hub: repository.getSpecialistHub(hub.id),
      researched: research.success,
      chunksIndexed: research.totalChunks || 0,
      reason: research.reason,
    };
  });

  // Expert Packs: share, back up, or install a single Expert.
  handleSecure(channels.specialist.exportPack, async (_event, hubId) => {
    const pack = repository.exportExpertPack(hubId);
    if (!pack) {
      throw new Error('Expert not found.');
    }

    const safeName = (pack.expert.name || 'expert').replace(/[^a-z0-9\-_ ]/gi, '').trim() || 'expert';
    const target = await dialog.showSaveDialog({
      title: 'Export Expert Pack',
      defaultPath: `${safeName}.sidekick-expert.json`,
      filters: [{ name: 'Sidekick Expert Pack', extensions: ['json'] }],
    });

    if (target.canceled || !target.filePath) {
      return { saved: false, cancelled: true };
    }

    await fs.writeFile(target.filePath, JSON.stringify(pack, null, 2), 'utf8');
    repository.appendAudit({
      action: 'expertPack.export',
      detail: `${pack.expert.name} → ${target.filePath}`,
    });
    return { saved: true, filePath: target.filePath, manifest: pack.manifest };
  });

  handleSecure(channels.specialist.importPack, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Install Expert Pack',
      filters: [{ name: 'Sidekick Expert Pack', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (result.canceled || !result.filePaths[0]) {
      return { imported: false, cancelled: true };
    }

    const raw = await fs.readFile(result.filePaths[0], 'utf8');
    let pack;
    try {
      pack = JSON.parse(raw);
    } catch (_error) {
      throw new Error('That file is not valid JSON.');
    }

    const outcome = repository.importExpertPack(pack);
    repository.appendAudit({
      action: 'expertPack.import',
      detail: `${outcome.hub.name} (${outcome.chunksImported} chunks) from ${result.filePaths[0]}`,
    });
    return { imported: true, ...outcome };
  });

  handleSecure(channels.specialist.reindex, async (event, { hubId }) => {
    const embeddingModel = repository.getSetting('embeddingModel');
    const preflight = await ollama.checkEmbedding(embeddingModel);
    if (!preflight.ok) {
      return { success: false, reason: preflight.reason };
    }

    return researchWorker.reindexHub({
      hubId,
      embeddingModel,
      onProgress: (progress) => {
        event.sender.send(channels.events.researchProgress, { hubId, ...progress });
      },
    });
  });

  // Deep Research & Document Ingestion Handlers
  handleSecure(channels.research.start, async (event, { hubId, topic, seedUrls, depth }) => {
    let model = repository.getSetting('activeModel');
    if (!model) {
      const models = await ollama.listModels();
      model = models[0]?.name || '';
    }

    const allSettings = repository.getAllSettings();

    // Fail fast if embeddings won't work, before scraping the web for minutes.
    const embeddingModel = repository.getSetting('embeddingModel');
    const preflight = await ollama.checkEmbedding(embeddingModel);
    if (!preflight.ok) {
      return { success: false, reason: preflight.reason };
    }

    return researchWorker.runWebDeepResearch({
      hubId,
      topic,
      seedUrls: seedUrls || [],
      depth: depth || 1,
      // Query decomposition is utility work — use the background model if set.
      model: repository.getSetting('backgroundModel') || model,
      embeddingModel,
      searchOptions: {
        provider: allSettings.searchProvider || 'duckduckgo',
        searxngUrl: allSettings.searxngUrl,
        tavilyApiKey: allSettings.tavilyApiKey,
        braveApiKey: allSettings.braveApiKey,
      },
      onProgress: (progress) => {
        event.sender.send(channels.events.researchProgress, { hubId, ...progress });
      },
    });
  });

  // Drop a document straight into the conversation: ingest it immediately into a new
  // Expert named after the file, so the user can ask about it in seconds instead of
  // first learning what an Expert is. This is the cold-start fix (ROADMAP §5a).
  handleSecure(channels.research.quickIngest, async (event, { filePaths = [], hubId = null }) => {
    const paths = filePaths.filter((p) => typeof p === 'string' && p.trim());
    if (paths.length === 0) {
      return { success: false, reason: 'No readable file was dropped.' };
    }

    const supported = ['.pdf', '.txt', '.md', '.json', '.csv'];
    const usable = paths.filter((p) => supported.includes(path.extname(p).toLowerCase()));
    if (usable.length === 0) {
      return {
        success: false,
        reason: `Unsupported file type. Drop a PDF, TXT, MD, JSON or CSV.`,
      };
    }

    const embeddingModel = repository.getSetting('embeddingModel');
    const preflight = await ollama.checkEmbedding(embeddingModel);
    if (!preflight.ok) {
      return { success: false, reason: preflight.reason };
    }

    let model = repository.getSetting('activeModel');
    if (!model) {
      const models = await ollama.listModels();
      model = models[0]?.name || '';
    }

    // Reuse the given Expert, or create one named after the first document.
    let hub = hubId ? repository.getSpecialistHub(hubId) : null;
    let createdHub = false;
    if (!hub) {
      const base = path.basename(usable[0], path.extname(usable[0])).slice(0, 60);
      hub = repository.createSpecialistHub({
        name: base || 'Dropped document',
        description: `Created from ${usable.map((p) => path.basename(p)).join(', ')}`,
        systemPrompt: 'Answer strictly from the provided documents, and cite them.',
        icon: 'book',
      });
      createdHub = true;
    }

    let indexed = 0;
    let failed = 0;
    const failures = [];
    for (const filePath of usable) {
      const result = await researchWorker.ingestFilePath({
        hubId: hub.id,
        filePath,
        model,
        embeddingModel,
        onProgress: (progress) => {
          event.sender.send(channels.events.researchProgress, { hubId: hub.id, ...progress });
        },
      });
      if (result.success) {
        indexed += result.chunksCount || 0;
      } else {
        failed += 1;
        failures.push(`${path.basename(filePath)}: ${result.reason}`);
      }
    }

    // Nothing indexed means nothing to ask about — remove the empty Expert we just
    // made rather than leaving a useless husk behind.
    if (indexed === 0) {
      if (createdHub) repository.deleteSpecialistHub(hub.id);
      return {
        success: false,
        reason: failures[0] || 'The document contained no indexable text.',
      };
    }

    return {
      success: true,
      hub: repository.getSpecialistHub(hub.id),
      createdHub,
      chunksIndexed: indexed,
      filesFailed: failed,
      failures,
      skipped: paths.length - usable.length,
    };
  });

  handleSecure(channels.research.ingestFile, async (event, { hubId }) => {
    const result = await dialog.showOpenDialog({
      title: 'Select PDF or Text Document for Specialist Vault',
      filters: [
        { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'json', 'csv'] },
      ],
      properties: ['openFile'],
    });

    if (result.canceled || !result.filePaths[0]) {
      return { success: false, cancelled: true };
    }

    const filePath = result.filePaths[0];
    let model = repository.getSetting('activeModel');
    if (!model) {
      const models = await ollama.listModels();
      model = models[0]?.name || '';
    }

    // Fail fast if embeddings won't work, before reading and chunking the file.
    const embeddingModel = repository.getSetting('embeddingModel');
    const preflight = await ollama.checkEmbedding(embeddingModel);
    if (!preflight.ok) {
      return { success: false, reason: preflight.reason };
    }

    return researchWorker.ingestFilePath({
      hubId,
      filePath,
      model,
      embeddingModel,
      onProgress: (progress) => {
        event.sender.send(channels.events.researchProgress, { hubId, ...progress });
      },
    });
  });

  // Memory Handlers
  handleSecure(channels.memory.list, async () => {
    return repository.listUserMemories();
  });

  handleSecure(channels.memory.add, async (_event, payload) => {
    return repository.addUserMemory(payload);
  });

  handleSecure(channels.memory.update, async (_event, payload) => {
    return repository.updateUserMemory(payload);
  });

  handleSecure(channels.memory.delete, async (_event, id) => {
    const success = repository.deleteUserMemory(id);
    if (success) repository.appendAudit({ action: 'memory.delete', detail: id });
    return { success };
  });

  handleSecure(channels.chat.createConversation, async (_event, title) => {
    return repository.createConversation(title);
  });

  handleSecure(channels.chat.listConversations, async () => {
    return repository.listConversations();
  });

  handleSecure(channels.chat.getConversation, async (_event, conversationId) => {
    return repository.getConversation(conversationId);
  });

  handleSecure(channels.chat.renameConversation, async (_event, payload) => {
    return repository.renameConversation(payload.conversationId, payload.title);
  });

  handleSecure(channels.chat.deleteConversation, async (_event, conversationId) => {
    const success = repository.deleteConversation(conversationId);
    if (success) repository.appendAudit({ action: 'conversation.delete', detail: conversationId });
    return { success };
  });

  handleSecure(channels.chat.searchConversations, async (_event, query) => {
    return repository.searchConversations(query);
  });

  handleSecure(channels.chat.sendMessageStream, async (event, payload) => {
    const content = payload.content.trim();
    if (!content) {
      throw new Error('Message content cannot be empty.');
    }

    let conversation =
      payload.conversationId && repository.getConversationSummary(payload.conversationId);
    if (!conversation) {
      conversation = repository.createConversation();
    }

    const userMessage = repository.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content,
    });

    conversation = repository.maybeAutoTitleConversation(conversation.id, content);

    let model = repository.getSetting('activeModel');
    if (!model) {
      const models = await ollama.listModels();
      model = models[0]?.name || '';
      if (model) {
        repository.setSetting('activeModel', model);
      }
    }

    if (!model) {
      throw new Error('No Ollama models are available.');
    }

    // Embeddings use the dedicated embedding model regardless of the chat model,
    // so vector dimensions stay stable across chat-model switches (invariant #5).
    const embeddingModel = repository.getSetting('embeddingModel');
    // Background/utility LLM work (summaries, fact extraction) runs on the optional
    // background model, falling back to the chat model when none is configured.
    const backgroundModel = repository.getSetting('backgroundModel') || model;

    // Check Settings
    const allSettings = repository.getAllSettings();
    const isWebSearchEnabled =
      payload.webSearchOverride ?? (allSettings.webSearchEnabled === 'true');

    // ---- Roundtable mode -------------------------------------------------------
    // When the user has chosen Roundtable and Experts are consulted, each Expert
    // speaks in its own grounded voice and a moderator consolidates, instead of one
    // blended answer (ROADMAP Stage 2.5).
    const requestedIds = Array.isArray(payload.activeSpecialistIds)
      ? payload.activeSpecialistIds.filter(Boolean)
      : payload.activeSpecialistId
        ? [payload.activeSpecialistId]
        : [];
    const panelMode = payload.panelModeOverride || allSettings.panelMode || 'synthesized';

    if (panelMode === 'roundtable' && requestedIds.length > 0) {
      const hubs = requestedIds
        .map((id) => repository.getSpecialistHub(id))
        .filter(Boolean)
        .map((hub) => ({ id: hub.id, name: hub.name }));

      if (hubs.length > 0) {
        const rounds = Number(payload.roundsOverride || allSettings.roundtableRounds || 1);
        const requestId = randomUUID();
        const abortController = new AbortController();
        activeGenerations.set(requestId, abortController);
        wrapUpRequests.delete(requestId);

        const orchestrator = new RoundtableOrchestrator({
          repository,
          ollama,
          // Each Expert is grounded through the normal context pipeline, scoped to
          // its own vault so its turn cites only what it actually knows.
          buildContext: ({ hubIds, content: question, conversationId }) =>
            buildChatContext({
              repository,
              ollama,
              memoryManager,
              researchWorker,
              content: question,
              conversationId,
              payload: { activeSpecialistIds: hubIds },
              model,
              embeddingModel,
              backgroundModel,
              allSettings,
              isWebSearchEnabled,
            }),
        });

        const history = repository
          .listMessages(conversation.id)
          .map((message) => ({ role: message.role, content: message.content }));

        Promise.resolve()
          .then(async () => {
            const result = await orchestrator.run({
              conversationId: conversation.id,
              content,
              hubs,
              rounds,
              model,
              // The answer the user reads uses the chat model; Expert turns may use
              // the faster background model when one is configured.
              moderatorModel: model,
              expertModel: repository.getSetting('backgroundModel') || model,
              history,
              control: {
                signal: abortController.signal,
                shouldWrapUp: () => wrapUpRequests.has(requestId),
              },
              onTurnStart: (turn) => {
                event.sender.send(channels.events.turnStart, { requestId, ...turn });
              },
              onTurnDelta: (turn) => {
                event.sender.send(channels.events.turnDelta, { requestId, ...turn });
              },
              onTurnComplete: (turn) => {
                // Persist each turn as its own attributed assistant message so the
                // discussion reloads coherently with per-turn citations.
                const saved = repository.addMessage({
                  conversationId: conversation.id,
                  role: 'assistant',
                  content: turn.content,
                  expertId: turn.expertId || null,
                  expertName: turn.expertName || null,
                  round: turn.round || null,
                  turnKind: turn.passed ? 'pass' : 'expert',
                });
                event.sender.send(channels.events.turnComplete, {
                  requestId,
                  ...turn,
                  message: { ...saved, specialistGrounding: turn.grounding || undefined },
                });
              },
            });

            if (result.moderator) {
              const saved = repository.addMessage({
                conversationId: conversation.id,
                role: 'assistant',
                content: result.moderator.content,
                expertName: 'Moderator',
                turnKind: 'moderator',
              });
              event.sender.send(channels.events.turnComplete, {
                requestId,
                ...result.moderator,
                message: saved,
              });
            }

            event.sender.send(channels.events.streamComplete, {
              requestId,
              conversationId: conversation.id,
              roundtable: {
                turns: result.turns.length,
                aborted: result.aborted,
                stoppedEarly: result.stoppedEarly || null,
              },
              conversation: repository.getConversationSummary(conversation.id),
            });

            // Background memory work, as in the normal path.
            Promise.allSettled([
              memoryManager.indexMessageEmbedding({
                messageId: userMessage.id,
                conversationId: conversation.id,
                content,
                model,
                embeddingModel,
              }),
            ]).catch(() => {});
          })
          .catch((error) => {
            event.sender.send(channels.events.streamError, {
              requestId,
              conversationId: conversation.id,
              error: error.name === 'AbortError' ? 'Discussion cancelled.' : error.message,
            });
          })
          .finally(() => {
            activeGenerations.delete(requestId);
            wrapUpRequests.delete(requestId);
          });

        return { requestId, conversation, userMessage, mode: 'roundtable', experts: hubs, rounds };
      }
    }

    // Assemble every context layer for this turn (web grounding, Expert panel with
    // planning/hybrid retrieval/reranking/aggregation, memory, profile) plus the
    // grounding payload and Expert suggestions. See electron/contextBuilder.cjs.
    const { systemContent, citations, specialistGrounding, suggestedExperts } = await buildChatContext({
      repository,
      ollama,
      memoryManager,
      researchWorker,
      content,
      conversationId: conversation.id,
      payload,
      model,
      embeddingModel,
      backgroundModel,
      allSettings,
      isWebSearchEnabled,
    });
    const rawHistory = repository.listMessages(conversation.id).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const formattedMessages = [
      { role: 'system', content: systemContent },
      ...rawHistory,
    ];

    const requestId = randomUUID();
    const abortController = new AbortController();
    activeGenerations.set(requestId, abortController);

    Promise.resolve()
      .then(async () => {
        const assistantText = await ollama.generateChat({
          model,
          messages: formattedMessages,
          signal: abortController.signal,
          onChunk: (_delta, fullText) => {
            event.sender.send(channels.events.streamUpdate, {
              requestId,
              conversationId: conversation.id,
              content: fullText,
              citations,
            });
          },
        });

        const assistantMessage = repository.addMessage({
          conversationId: conversation.id,
          role: 'assistant',
          content: assistantText,
        });

        event.sender.send(channels.events.streamComplete, {
          requestId,
          conversationId: conversation.id,
          message: {
            ...assistantMessage,
            citations: citations.length > 0 ? citations : undefined,
            specialistGrounding: specialistGrounding || undefined,
            suggestedExperts: suggestedExperts.length > 0 ? suggestedExperts : undefined,
          },
          conversation: repository.getConversationSummary(conversation.id),
        });

        // 4. Trigger Async Non-Blocking Background Memory Tasks. Summarization and
        //    fact extraction are utility work → run on the background model.
        Promise.allSettled([
          memoryManager.maybeUpdateRollingSummary({
            conversationId: conversation.id,
            messages: rawHistory,
            model: backgroundModel,
          }),
          memoryManager.extractAndSaveFacts({
            conversationId: conversation.id,
            userMessage: content,
            assistantMessage: assistantText,
            model: backgroundModel,
          }),
          memoryManager.indexMessageEmbedding({
            messageId: userMessage.id,
            conversationId: conversation.id,
            content,
            model,
            embeddingModel,
          }),
        ]).catch(() => {
          // Ignore background task errors
        });
      })
      .catch((error) => {
        event.sender.send(channels.events.streamError, {
          requestId,
          conversationId: conversation.id,
          error: error.name === 'AbortError' ? 'Generation cancelled.' : error.message,
        });
      })
      .finally(() => {
        activeGenerations.delete(requestId);
      });

    return {
      requestId,
      conversation,
      userMessage,
    };
  });

  // "Answer now": stop going around the table and have the moderator wrap up. The
  // orchestrator checks this between turns, so the turn in flight still completes.
  handleSecure(channels.chat.answerNow, async (_event, requestId) => {
    if (!activeGenerations.has(requestId)) {
      return { requested: false };
    }
    wrapUpRequests.add(requestId);
    return { requested: true };
  });

  handleSecure(channels.chat.cancelGeneration, async (_event, requestId) => {
    const controller = activeGenerations.get(requestId);
    if (!controller) {
      return { cancelled: false };
    }

    controller.abort();
    return { cancelled: true };
  });

  handleSecure(channels.chat.exportConversation, async (_event, conversationId) => {
    const payload = repository.exportConversation(conversationId);
    if (!payload) {
      throw new Error('Conversation not found.');
    }

    const target = await dialog.showSaveDialog({
      defaultPath: stampFilename('sidekick-conversation'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (target.canceled || !target.filePath) {
      return { saved: false };
    }

    await fs.writeFile(target.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { saved: true, filePath: target.filePath };
  });

  handleSecure(channels.chat.importAll, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Sidekick corpus (conversations, memory, experts)',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (result.canceled || !result.filePaths[0]) {
      return { imported: false, cancelled: true };
    }

    const raw = await fs.readFile(result.filePaths[0], 'utf8');
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_error) {
      throw new Error('Selected file is not valid JSON.');
    }

    if (payload.app !== 'sidekick-llm' || payload.kind !== 'corpus-export') {
      throw new Error('Selected file is not a Sidekick corpus export.');
    }

    const counts = repository.importAll(payload);
    repository.appendAudit({
      action: 'corpus.import',
      detail: `${JSON.stringify(counts)} from ${result.filePaths[0]}`,
    });
    return { imported: true, counts, filePath: result.filePaths[0] };
  });

  handleSecure(channels.system.getIntegrity, async () => {
    return repository.integrity;
  });

  // ---- Audit log surface --------------------------------------------------------
  handleSecure(channels.system.auditList, async (_event, options) => {
    return {
      entries: repository.listAudit(options || {}),
      total: repository.countAudit(),
    };
  });

  handleSecure(channels.system.auditVerify, async () => {
    return repository.verifyAuditChain();
  });

  handleSecure(channels.system.auditExport, async () => {
    const verification = repository.verifyAuditChain();
    const payload = {
      app: 'sidekick-llm',
      kind: 'audit-log',
      exportedAt: new Date().toISOString(),
      verification,
      entries: repository.listAudit({ limit: 100000 }).reverse(),
    };

    const target = await dialog.showSaveDialog({
      title: 'Export audit log',
      defaultPath: stampFilename('sidekick-audit'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (target.canceled || !target.filePath) {
      return { saved: false, cancelled: true };
    }

    await fs.writeFile(target.filePath, JSON.stringify(payload, null, 2), 'utf8');
    repository.appendAudit({ action: 'audit.export', detail: target.filePath });
    return { saved: true, filePath: target.filePath, verification };
  });

  handleSecure(channels.chat.exportAll, async () => {
    const payload = repository.exportAll();
    const target = await dialog.showSaveDialog({
      defaultPath: stampFilename('sidekick-history'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (target.canceled || !target.filePath) {
      return { saved: false };
    }

    await fs.writeFile(target.filePath, JSON.stringify(payload, null, 2), 'utf8');
    // A full-corpus export leaves the app's protection: worth recording, and worth
    // remembering that the JSON itself is plaintext (see Stage 4 threat model).
    repository.appendAudit({
      action: 'corpus.export',
      detail: `${payload.conversations.length} conversations, ${payload.specialistHubs.length} experts → ${target.filePath}`,
    });
    return { saved: true, filePath: target.filePath };
  });

  return {
    repository,
    memoryManager,
  };
}

module.exports = {
  registerIpcHandlers,
};

