const path = require('path');
const { contextBridge, ipcRenderer } = require('electron');
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
    setActive: (modelName) => ipcRenderer.invoke(channels.models.setActive, modelName),
  },
  ollama: {
    getStatus: () => ipcRenderer.invoke(channels.ollama.status),
  },
  chat: {
    createConversation: (title) => ipcRenderer.invoke(channels.chat.createConversation, title),
    listConversations: () => ipcRenderer.invoke(channels.chat.listConversations),
    getConversation: (conversationId) => ipcRenderer.invoke(channels.chat.getConversation, conversationId),
    renameConversation: (payload) => ipcRenderer.invoke(channels.chat.renameConversation, payload),
    deleteConversation: (conversationId) => ipcRenderer.invoke(channels.chat.deleteConversation, conversationId),
    searchConversations: (query) => ipcRenderer.invoke(channels.chat.searchConversations, query),
    sendMessageStream: (payload) => ipcRenderer.invoke(channels.chat.sendMessageStream, payload),
    cancelGeneration: (requestId) => ipcRenderer.invoke(channels.chat.cancelGeneration, requestId),
    exportConversation: (conversationId) => ipcRenderer.invoke(channels.chat.exportConversation, conversationId),
    exportAll: () => ipcRenderer.invoke(channels.chat.exportAll),
    importAll: () => ipcRenderer.invoke(channels.chat.importAll),
  },
  system: {
    getIntegrity: () => ipcRenderer.invoke(channels.system.getIntegrity),
  },
  settings: {
    get: () => ipcRenderer.invoke(channels.settings.get),
    set: (key, value) => ipcRenderer.invoke(channels.settings.set, { key, value }),
  },
  memory: {
    list: () => ipcRenderer.invoke(channels.memory.list),
    add: (payload) => ipcRenderer.invoke(channels.memory.add, payload),
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
  },
  research: {
    start: (payload) => ipcRenderer.invoke(channels.research.start, payload),
    ingestFile: (payload) => ipcRenderer.invoke(channels.research.ingestFile, payload),
  },
  events: {
    onStreamUpdate: (listener) => subscribe(channels.events.streamUpdate, listener),
    onStreamComplete: (listener) => subscribe(channels.events.streamComplete, listener),
    onStreamError: (listener) => subscribe(channels.events.streamError, listener),
    onResearchProgress: (listener) => subscribe(channels.events.researchProgress, listener),
  },
});
