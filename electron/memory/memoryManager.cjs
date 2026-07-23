class MemoryManager {
  constructor({ repository, ollama }) {
    this.repository = repository;
    this.ollama = ollama;
  }

  async retrieveContext({ query, currentConversationId, model }) {
    const contextSections = [];

    // 1. Retrieve Structured User Memories
    try {
      const memories = this.repository.listUserMemories();
      if (memories && memories.length > 0) {
        const memoryLines = memories.slice(0, 10).map((m) => `- ${m.fact} (${m.category})`);
        contextSections.push(`### Stored User Preferences & Facts:\n${memoryLines.join('\n')}`);
      }
    } catch (_e) {
      // Memory list fallback
    }

    // 2. Retrieve Vector RAG Memory (Cross-conversation historical memory)
    try {
      if (query && model) {
        const queryEmbedding = await this.ollama.generateEmbedding({
          model,
          input: query,
        });

        if (queryEmbedding && queryEmbedding.length > 0) {
          const relevantChunks = this.repository.searchVectorMemory(
            queryEmbedding,
            4,
            currentConversationId,
          );

          if (relevantChunks && relevantChunks.length > 0) {
            const chunkLines = relevantChunks.map(
              (c) => `- Historical Context: "${c.chunkText.slice(0, 300)}"`,
            );
            contextSections.push(`### Relevant Past Conversation History:\n${chunkLines.join('\n')}`);
          }
        }
      }
    } catch (_e) {
      // Vector embedding fallback - silently fail or rely on FTS5 fallback
    }

    // 3. Retrieve Active Conversation Summary if present
    if (currentConversationId) {
      try {
        const summaryObj = this.repository.getConversationSummary(currentConversationId);
        if (summaryObj && summaryObj.summary) {
          contextSections.push(`### Executive Summary of Earlier Conversation:\n${summaryObj.summary}`);
        }
      } catch (_e) {
        // Summary fallback
      }
    }

    if (contextSections.length === 0) {
      return '';
    }

    return `\n\n[CONTEXTUAL MEMORY VAULT]\nUse the following stored memory context if relevant to personalize and enrich your response:\n${contextSections.join('\n\n')}\n`;
  }

  async maybeUpdateRollingSummary({ conversationId, messages, model }) {
    if (!messages || messages.length < 8 || !model) {
      return;
    }

    // Don't re-summarize if summary was recently updated
    const summaryObj = this.repository.getConversationSummary(conversationId);
    const existingSummary = summaryObj?.summary || '';

    // Only summarize older turns (excluding last 4 turns)
    const olderMessages = messages.slice(0, messages.length - 4);
    const textToSummarize = olderMessages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    try {
      const summaryPrompt = [
        {
          role: 'system',
          content:
            'You are a concise executive summarizer. Synthesize the key points, technical decisions, and user goals from the following conversation history into a bulleted summary of 100 words or less.',
        },
        {
          role: 'user',
          content: existingSummary
            ? `Existing Summary:\n${existingSummary}\n\nNew Message History to include:\n${textToSummarize}`
            : `Summarize the following conversation:\n${textToSummarize}`,
        },
      ];

      const newSummary = await this.ollama.generateChatSync({
        model,
        messages: summaryPrompt,
      });

      if (newSummary && newSummary.trim()) {
        this.repository.updateConversationSummary(conversationId, newSummary.trim());
      }
    } catch (_e) {
      // Background summarization failure is non-blocking
    }
  }

  async extractAndSaveFacts({ conversationId, userMessage, assistantMessage, model }) {
    if (!userMessage || !assistantMessage || !model) {
      return;
    }

    // Quick heuristic to avoid unnecessary LLM calls if message doesn't contain key personal terms
    const text = userMessage.toLowerCase();
    const factTriggers = [
      'my name',
      'i am',
      'i use',
      'i work',
      'i prefer',
      'my stack',
      'my project',
      'remember that',
      'always use',
      'never use',
      'my server',
    ];

    const containsTrigger = factTriggers.some((t) => text.includes(t));
    if (!containsTrigger) {
      return;
    }

    try {
      const extractionPrompt = [
        {
          role: 'system',
          content:
            'Extract explicit user facts, hardware/software stack preferences, or permanent rules stated by the user. Output ONLY a valid JSON array of strings representing facts (e.g. ["User uses Windows 11", "User prefers React with Vite"]). If no explicit facts exist, return [].',
        },
        {
          role: 'user',
          content: `User Message: "${userMessage}"\nAssistant Message: "${assistantMessage}"`,
        },
      ];

      const jsonString = await this.ollama.generateChatSync({
        model,
        messages: extractionPrompt,
      });

      if (jsonString) {
        const match = jsonString.match(/\[[\s\S]*\]/);
        if (match) {
          const facts = JSON.parse(match[0]);
          if (Array.isArray(facts)) {
            for (const fact of facts) {
              if (typeof fact === 'string' && fact.trim()) {
                this.repository.addUserMemory({
                  fact: fact.trim(),
                  category: 'auto-extracted',
                  conversationId,
                });
              }
            }
          }
        }
      }
    } catch (_e) {
      // Non-blocking fact extraction
    }
  }

  async indexMessageEmbedding({ messageId, conversationId, content, model }) {
    if (!content || !model || content.length < 20) {
      return;
    }

    try {
      const embedding = await this.ollama.generateEmbedding({
        model,
        input: content,
      });

      if (embedding && embedding.length > 0) {
        this.repository.saveMessageEmbedding({
          messageId,
          conversationId,
          chunkText: content.slice(0, 500),
          embedding,
        });
      }
    } catch (_e) {
      // Embeddings failure non-blocking
    }
  }
}

module.exports = {
  MemoryManager,
};
