const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { dialog, ipcMain } = require('electron');

const channels = require('../shared/channels.json');
const { ConversationRepository } = require('./repository.cjs');
const { OllamaService } = require('./ollama.cjs');

function stampFilename(prefix) {
  const value = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${value}.json`;
}

function registerIpcHandlers({ userDataPath }) {
  const repository = new ConversationRepository(path.join(userDataPath, 'sidekick.db'));
  const ollama = new OllamaService({
    getBaseUrl: () => repository.getSetting('ollamaBaseUrl'),
  });
  const activeGenerations = new Map();

  ipcMain.handle(channels.models.list, async () => {
    return ollama.listModels();
  });

  ipcMain.handle(channels.models.getActive, async () => {
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

  ipcMain.handle(channels.models.setActive, async (_event, modelName) => {
    repository.setSetting('activeModel', modelName);
    return modelName;
  });

  ipcMain.handle(channels.ollama.status, async () => {
    return ollama.getStatus();
  });

  ipcMain.handle(channels.chat.createConversation, async (_event, title) => {
    return repository.createConversation(title);
  });

  ipcMain.handle(channels.chat.listConversations, async () => {
    return repository.listConversations();
  });

  ipcMain.handle(channels.chat.getConversation, async (_event, conversationId) => {
    return repository.getConversation(conversationId);
  });

  ipcMain.handle(channels.chat.renameConversation, async (_event, payload) => {
    return repository.renameConversation(payload.conversationId, payload.title);
  });

  ipcMain.handle(channels.chat.deleteConversation, async (_event, conversationId) => {
    const success = repository.deleteConversation(conversationId);
    return { success };
  });

  ipcMain.handle(channels.chat.searchConversations, async (_event, query) => {
    return repository.searchConversations(query);
  });

  ipcMain.handle(channels.chat.sendMessageStream, async (event, payload) => {
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
    const history = repository.listMessages(conversation.id).map((message) => ({
      role: message.role,
      content: message.content,
    }));

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

    const requestId = randomUUID();
    const abortController = new AbortController();
    activeGenerations.set(requestId, abortController);

    Promise.resolve()
      .then(async () => {
        const assistantText = await ollama.generateChat({
          model,
          messages: history,
          signal: abortController.signal,
          onChunk: (_delta, fullText) => {
            event.sender.send(channels.events.streamUpdate, {
              requestId,
              conversationId: conversation.id,
              content: fullText,
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
          message: assistantMessage,
          conversation: repository.getConversationSummary(conversation.id),
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

  ipcMain.handle(channels.chat.cancelGeneration, async (_event, requestId) => {
    const controller = activeGenerations.get(requestId);
    if (!controller) {
      return { cancelled: false };
    }

    controller.abort();
    return { cancelled: true };
  });

  ipcMain.handle(channels.chat.exportConversation, async (_event, conversationId) => {
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

  ipcMain.handle(channels.chat.exportAll, async () => {
    const payload = repository.exportAll();
    const target = await dialog.showSaveDialog({
      defaultPath: stampFilename('sidekick-history'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (target.canceled || !target.filePath) {
      return { saved: false };
    }

    await fs.writeFile(target.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { saved: true, filePath: target.filePath };
  });

  return {
    repository,
  };
}

module.exports = {
  registerIpcHandlers,
};
