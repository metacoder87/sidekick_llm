const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { dialog, ipcMain } = require('electron');

const channels = require('../shared/channels.json');
const { ConversationRepository } = require('./repository.cjs');
const { OllamaService } = require('./ollama.cjs');
const { performWebSearch } = require('./search/searchService.cjs');
const { scrapeTopResults } = require('./search/scraper.cjs');
const { MemoryManager } = require('./memory/memoryManager.cjs');
const { DeepResearchWorker } = require('./research/deepResearch.cjs');

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
      model,
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

    // Check Settings
    const allSettings = repository.getAllSettings();
    const isWebSearchEnabled =
      payload.webSearchOverride ?? (allSettings.webSearchEnabled === 'true');

    let webSearchContext = '';
    const citations = [];

    // 1. Perform Web Search & Scraping if enabled
    if (isWebSearchEnabled) {
      try {
        const searchResults = await performWebSearch({
          query: content,
          provider: allSettings.searchProvider,
          options: {
            searxngUrl: allSettings.searxngUrl,
            tavilyApiKey: allSettings.tavilyApiKey,
            braveApiKey: allSettings.braveApiKey,
            maxResults: 4,
          },
        });

        if (searchResults && searchResults.length > 0) {
          const scraped = await scrapeTopResults(searchResults, 3);
          const contextParts = [];

          scraped.forEach((item, index) => {
            const citeId = index + 1;
            try {
              const urlObj = new URL(item.url);
              citations.push({
                id: citeId,
                title: item.title,
                url: item.url,
                snippet: item.snippet,
                domain: urlObj.hostname.replace(/^www\./, ''),
              });
            } catch (_e) {
              citations.push({
                id: citeId,
                title: item.title,
                url: item.url,
                snippet: item.snippet,
                domain: item.url,
              });
            }

            contextParts.push(
              `[Source ${citeId}]: ${item.title} (${item.url})\n"${item.content.slice(0, 1200)}"`,
            );
          });

          webSearchContext = `\n\n<web_context>\n[REAL-TIME INTERNET SEARCH RESULTS]\nUse the web search results below to ensure complete accuracy and freshness. Cite your sources using bracketed numbers like [1], [2] matching the source numbers.\n\n${contextParts.join('\n\n')}\n</web_context>\n`;
        }
      } catch (searchErr) {
        console.error('Web Search Error:', searchErr.message);
      }
    }

    // 2. Retrieve Contextual Memory (Facts + Vector RAG + Rolling Summary)
    let memoryContext = '';
    try {
      memoryContext = await memoryManager.retrieveContext({
        query: content,
        currentConversationId: conversation.id,
        model,
        embeddingModel,
      });
    } catch (memErr) {
      console.error('Memory Retrieval Error:', memErr.message);
    }

    // 3. Retrieve User Profile & Custom System Instructions
    const userProfile = repository.getUserProfile();
    const profileContext = `\n[USER PROFILE & SYSTEM PREFERENCES]\n- User Name: ${userProfile.name}\n- User Role: ${userProfile.role}\n- Tech Stack: ${userProfile.stack}\n- Preferred Response Tone: ${userProfile.tone}\n- Global System Instructions: ${userProfile.instructions}\n`;

    // 4. Retrieve Specialist RAG Context if an Active Specialist Hub is selected.
    //    Track grounding so the UI can flag an answer that came from the persona
    //    alone, with no matching vault knowledge (invariant #1 — a persona speaking
    //    from model weights must never look like a grounded, cited answer).
    let specialistContext = '';
    let specialistGrounding = null;
    if (payload.activeSpecialistId) {
      try {
        const hub = repository.getSpecialistHub(payload.activeSpecialistId);
        if (hub) {
          let specialistRag = '';
          let matchCount = 0;
          const queryEmbedding = await ollama.generateEmbedding({ model: embeddingModel, input: content });
          if (queryEmbedding && queryEmbedding.length > 0) {
            const matches = repository.searchSpecialistVectorMemory(hub.id, queryEmbedding, 4, embeddingModel);
            if (matches && matches.length > 0) {
              matchCount = matches.length;
              const chunkLines = matches.map(
                (m) => `[Source (${m.sourceTitle})]: "${m.chunkText}"`,
              );
              specialistRag = `\n[SPECIALIST KNOWLEDGE VAULT: ${hub.name}]\n${chunkLines.join('\n\n')}`;
            }
          }

          specialistGrounding = { name: hub.name, grounded: matchCount > 0, matches: matchCount };
          specialistContext = `\n<specialist_role>\nYou are currently operating as an AI Specialist: ${hub.name}.\n${hub.description ? `Description: ${hub.description}\n` : ''}${hub.systemPrompt ? `Expert Instructions: ${hub.systemPrompt}\n` : ''}${specialistRag}\n</specialist_role>\n`;
        }
      } catch (specErr) {
        console.error('Specialist RAG Error:', specErr.message);
      }
    }

    // 5. Construct Final Prompt History with Injected Context
    const rawHistory = repository.listMessages(conversation.id).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    // Build system message with profile, specialist, memory & search context
    const systemContent = [
      'You are Sidekick, an accurate, grounded, and helpful AI desktop assistant.',
      profileContext,
      specialistContext,
      memoryContext,
      webSearchContext,
    ]
      .filter(Boolean)
      .join('\n\n');

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
          },
          conversation: repository.getConversationSummary(conversation.id),
        });

        // 4. Trigger Async Non-Blocking Background Memory Tasks
        Promise.allSettled([
          memoryManager.maybeUpdateRollingSummary({
            conversationId: conversation.id,
            messages: rawHistory,
            model,
          }),
          memoryManager.extractAndSaveFacts({
            conversationId: conversation.id,
            userMessage: content,
            assistantMessage: assistantText,
            model,
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

