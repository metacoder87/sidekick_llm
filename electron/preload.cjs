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
  },
  events: {
    onStreamUpdate: (listener) => subscribe(channels.events.streamUpdate, listener),
    onStreamComplete: (listener) => subscribe(channels.events.streamComplete, listener),
    onStreamError: (listener) => subscribe(channels.events.streamError, listener),
  },
});
