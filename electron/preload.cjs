const path = require('path');
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const channels = require(path.join(__dirname, '..', 'shared', 'channels.json'));

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('sidekick', {
  models: {
    list: () => ipcRenderer.invoke(channels.models.list),
    getActive: () => ipcRenderer.invoke(channels.models.getActive),
    // Accepts either a bare model name (legacy) or { name, engine } so choosing
    // an Ollama model can switch engines in the same step.
    setActive: (payload) => ipcRenderer.invoke(channels.models.setActive, payload),
    catalog: () => ipcRenderer.invoke(channels.models.catalog),
    listLocal: () => ipcRenderer.invoke(channels.models.listLocal),
    listAll: () => ipcRenderer.invoke(channels.models.listAll),
    pull: (payload) => ipcRenderer.invoke(channels.models.pull, payload),
    download: (payload) => ipcRenderer.invoke(channels.models.download, payload),
    hardware: () => ipcRenderer.invoke(channels.models.hardware),
    delete: (payload) => ipcRenderer.invoke(channels.models.delete, payload),
  },
  ollama: {
    getStatus: () => ipcRenderer.invoke(channels.ollama.status),
  },
  chat: {
    createConversation: (title) => ipcRenderer.invoke(channels.chat.createConversation, title),
    listConversations: () => ipcRenderer.invoke(channels.chat.listConversations),
    getConversation: (conversationId) =>
      ipcRenderer.invoke(channels.chat.getConversation, conversationId),
    renameConversation: (payload) => ipcRenderer.invoke(channels.chat.renameConversation, payload),
    deleteConversation: (conversationId) =>
      ipcRenderer.invoke(channels.chat.deleteConversation, conversationId),
    searchConversations: (query) => ipcRenderer.invoke(channels.chat.searchConversations, query),
    sendMessageStream: (payload) => ipcRenderer.invoke(channels.chat.sendMessageStream, payload),
    cancelGeneration: (requestId) => ipcRenderer.invoke(channels.chat.cancelGeneration, requestId),
    answerNow: (requestId) => ipcRenderer.invoke(channels.chat.answerNow, requestId),
    exportConversation: (conversationId) =>
      ipcRenderer.invoke(channels.chat.exportConversation, conversationId),
    exportAll: () => ipcRenderer.invoke(channels.chat.exportAll),
    importAll: () => ipcRenderer.invoke(channels.chat.importAll),
  },
  security: {
    status: () => ipcRenderer.invoke(channels.security.status),
    unlock: (payload) => ipcRenderer.invoke(channels.security.unlock, payload),
    lock: () => ipcRenderer.invoke(channels.security.lock),
    enable: (payload) => ipcRenderer.invoke(channels.security.enable, payload),
    disable: (payload) => ipcRenderer.invoke(channels.security.disable, payload),
    changePassphrase: (payload) => ipcRenderer.invoke(channels.security.changePassphrase, payload),
    setRemember: (payload) => ipcRenderer.invoke(channels.security.setRemember, payload),
  },
  system: {
    getIntegrity: () => ipcRenderer.invoke(channels.system.getIntegrity),
    auditList: (options) => ipcRenderer.invoke(channels.system.auditList, options),
    auditVerify: () => ipcRenderer.invoke(channels.system.auditVerify),
    auditExport: () => ipcRenderer.invoke(channels.system.auditExport),
  },
  settings: {
    get: () => ipcRenderer.invoke(channels.settings.get),
    set: (key, value) => ipcRenderer.invoke(channels.settings.set, { key, value }),
  },
  // Custom title-bar controls. The window is created with titleBarStyle:
  // 'hidden', so without these the app has no way to minimize, maximize, or
  // close from the UI.
  window: {
    minimize: () => ipcRenderer.invoke(channels.window.minimize),
    toggleMaximize: () => ipcRenderer.invoke(channels.window.toggleMaximize),
    isMaximized: () => ipcRenderer.invoke(channels.window.isMaximized),
    close: () => ipcRenderer.invoke(channels.window.close),
    onMaximizedChange: (listener) => subscribe(channels.events.windowMaximized, listener),
  },
  license: {
    status: () => ipcRenderer.invoke(channels.license.status),
    activate: (licenseKey) => ipcRenderer.invoke(channels.license.activate, licenseKey),
    validate: () => ipcRenderer.invoke(channels.license.validate),
    deactivate: () => ipcRenderer.invoke(channels.license.deactivate),
  },
  memory: {
    list: () => ipcRenderer.invoke(channels.memory.list),
    add: (payload) => ipcRenderer.invoke(channels.memory.add, payload),
    update: (payload) => ipcRenderer.invoke(channels.memory.update, payload),
    delete: (id) => ipcRenderer.invoke(channels.memory.delete, id),
  },
  profile: {
    get: () => ipcRenderer.invoke(channels.profile.get),
    set: (profileObj) => ipcRenderer.invoke(channels.profile.set, profileObj),
  },
  specialist: {
    list: () => ipcRenderer.invoke(channels.specialist.list),
    get: (id) => ipcRenderer.invoke(channels.specialist.get, id),
    create: (hubData) => ipcRenderer.invoke(channels.specialist.create, hubData),
    update: (hubData) => ipcRenderer.invoke(channels.specialist.update, hubData),
    delete: (id) => ipcRenderer.invoke(channels.specialist.delete, id),
    reindex: (hubId) => ipcRenderer.invoke(channels.specialist.reindex, { hubId }),
    reindexAll: () => ipcRenderer.invoke(channels.specialist.reindexAll),
    exportPack: (hubId) => ipcRenderer.invoke(channels.specialist.exportPack, hubId),
    importPack: () => ipcRenderer.invoke(channels.specialist.importPack),
    catalog: () => ipcRenderer.invoke(channels.specialist.catalog),
    installFromCatalog: (payload) =>
      ipcRenderer.invoke(channels.specialist.installFromCatalog, payload),
  },
  research: {
    start: (payload) => ipcRenderer.invoke(channels.research.start, payload),
    ingestFile: (payload) => ipcRenderer.invoke(channels.research.ingestFile, payload),
    quickIngest: (payload) => ipcRenderer.invoke(channels.research.quickIngest, payload),
  },
  files: {
    // Electron 32+ removed File.path; webUtils is the supported way to resolve a
    // dropped file to a real path. The renderer never gains filesystem access —
    // it only learns the path, and the main process does the reading.
    getPath: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch (_error) {
        return '';
      }
    },
  },
  notes: {
    list: (hubId) => ipcRenderer.invoke(channels.notes.list, hubId),
    create: (payload) => ipcRenderer.invoke(channels.notes.create, payload),
    update: (payload) => ipcRenderer.invoke(channels.notes.update, payload),
    delete: (id) => ipcRenderer.invoke(channels.notes.delete, id),
  },
  events: {
    onStreamUpdate: (listener) => subscribe(channels.events.streamUpdate, listener),
    onStreamComplete: (listener) => subscribe(channels.events.streamComplete, listener),
    onStreamError: (listener) => subscribe(channels.events.streamError, listener),
    onResearchProgress: (listener) => subscribe(channels.events.researchProgress, listener),
    onLocked: (listener) => subscribe(channels.events.locked, listener),
    onModelPull: (listener) => subscribe(channels.events.modelPull, listener),
    onTurnStart: (listener) => subscribe(channels.events.turnStart, listener),
    onTurnDelta: (listener) => subscribe(channels.events.turnDelta, listener),
    onTurnComplete: (listener) => subscribe(channels.events.turnComplete, listener),
  },
});
