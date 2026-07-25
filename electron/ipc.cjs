const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { dialog, ipcMain } = require('electron');

const channels = require('../shared/channels.json');
const { ConversationRepository } = require('./repository.cjs');
const { OllamaService } = require('./ollama.cjs');
const { MemoryManager } = require('./memory/memoryManager.cjs');
const { DeepResearchWorker } = require('./research/deepResearch.cjs');
const { buildChatContext } = require('./contextBuilder.cjs');

function stampFilename(prefix) {
  const value = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${value}.json`;
}

function registerIpcHandlers({ userDataPath }) {
  const repository = new ConversationRepository(path.join(userDataPath, 'sidekick.db'));
  const ollama = new OllamaService({
    getBaseUrl: () => repository.getSetting('ollamaBaseUrl'),
  });
  const memoryManager = new MemoryManager({ repository, ollama });
  const researchWorker = new DeepResearchWorker({ repository, ollama });
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

  // Settings Handlers
  ipcMain.handle(channels.settings.get, async () => {
    return repository.getAllSettings();
  });

  ipcMain.handle(channels.settings.set, async (_event, { key, value }) => {
    repository.setSetting(key, value);
    return repository.getAllSettings();
  });

  // Profile Handlers
  ipcMain.handle(channels.profile.get, async () => {
    return repository.getUserProfile();
  });

  ipcMain.handle(channels.profile.set, async (_event, profileObj) => {
    return repository.setUserProfile(profileObj);
  });

  // Specialist Hub Handlers
  ipcMain.handle(channels.specialist.list, async () => {
    return repository.listSpecialistHubs();
  });

  ipcMain.handle(channels.specialist.get, async (_event, id) => {
    return repository.getSpecialistHub(id);
  });

  ipcMain.handle(channels.specialist.create, async (_event, hubData) => {
    return repository.createSpecialistHub(hubData);
  });

  ipcMain.handle(channels.specialist.update, async (_event, hubData) => {
    return repository.updateSpecialistHub(hubData);
  });

  ipcMain.handle(channels.specialist.delete, async (_event, id) => {
    const success = repository.deleteSpecialistHub(id);
    return { success };
  });

  // Notes: editable knowledge attached to an Expert. Every write re-embeds the note
  // so what the model can retrieve always matches what the user wrote.
  ipcMain.handle(channels.notes.list, async (_event, hubId) => {
    return repository.listNotes(hubId);
  });

  ipcMain.handle(channels.notes.create, async (_event, payload) => {
    const embeddingModel = repository.getSetting('embeddingModel');
    const preflight = await ollama.checkEmbedding(embeddingModel);
    const note = repository.createNote(payload);
    if (!preflight.ok) {
      return { note, indexed: false, reason: preflight.reason };
    }
    const result = await researchWorker.indexNote({ note, embeddingModel });
    return { note, indexed: result.success, reason: result.reason, chunksCount: result.chunksCount };
  });

  ipcMain.handle(channels.notes.update, async (_event, payload) => {
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

  ipcMain.handle(channels.notes.delete, async (_event, id) => {
    const success = repository.deleteNote(id);
    return { success };
  });

  ipcMain.handle(channels.specialist.reindex, async (event, { hubId }) => {
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
  ipcMain.handle(channels.research.start, async (event, { hubId, topic, seedUrls, depth }) => {
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

  ipcMain.handle(channels.research.ingestFile, async (event, { hubId }) => {
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
  ipcMain.handle(channels.memory.list, async () => {
    return repository.listUserMemories();
  });

  ipcMain.handle(channels.memory.add, async (_event, payload) => {
    return repository.addUserMemory(payload);
  });

  ipcMain.handle(channels.memory.update, async (_event, payload) => {
    return repository.updateUserMemory(payload);
  });

  ipcMain.handle(channels.memory.delete, async (_event, id) => {
    const success = repository.deleteUserMemory(id);
    return { success };
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

  ipcMain.handle(channels.chat.importAll, async () => {
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
    return { imported: true, counts, filePath: result.filePaths[0] };
  });

  ipcMain.handle(channels.system.getIntegrity, async () => {
    return repository.integrity;
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
    memoryManager,
  };
}

module.exports = {
  registerIpcHandlers,
};

