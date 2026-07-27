const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'as',
  'at',
  'by',
  'it',
  'this',
  'that',
  'i',
  'you',
  'my',
  'me',
  'do',
  'does',
  'how',
  'what',
  'why',
  'when',
  'can',
  'should',
  'would',
  'about',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// Rank stored memories by lexical relevance to the query, with recency as the
// tie-breaker, and return the top `limit`. Replaces pure-recency selection so a
// burst of unrelated facts can't push the facts that matter to THIS question out
// of the context window (ROADMAP §2 — memory must compound, not degrade). With no
// query, this degrades gracefully to recency order.
function rankMemoriesByRelevance(memories, query, limit = 12) {
  const queryTerms = new Set(tokenize(query));
  const nowMs = Date.now();

  const scored = memories.map((m) => {
    let overlap = 0;
    if (queryTerms.size > 0) {
      for (const term of new Set(tokenize(`${m.fact} ${m.category || ''}`))) {
        if (queryTerms.has(term)) overlap += 1;
      }
    }

    // Reinforcement: a fact the user has stated repeatedly outranks a one-off
    // mention at equal relevance. Staleness: an old fact that was never reinforced
    // gently decays, so the vault reflects who the user is NOW without ever hard-
    // deleting history (ROADMAP Stage 2 — memory that compounds).
    const ageDays = Math.max(0, (nowMs - new Date(m.updatedAt || 0).getTime()) / 86400000);
    const reinforcement = Math.min(3, Math.log2(1 + (m.reinforcedCount || 1)));
    const staleness = ageDays > 180 && (m.reinforcedCount || 1) <= 1 ? -0.5 : 0;

    return { memory: m, overlap, tiebreak: reinforcement + staleness };
  });

  scored.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    if (b.tiebreak !== a.tiebreak) return b.tiebreak - a.tiebreak;
    return new Date(b.memory.updatedAt || 0) - new Date(a.memory.updatedAt || 0);
  });

  return scored.slice(0, limit).map((s) => s.memory);
}

// Candidate facts that the new fact might REPLACE: same topic (meaningful token
// overlap) but not identical. Cheap pre-filter so the LLM supersession check only
// runs on plausible pairs instead of the whole vault.
function findSupersessionCandidates(newFact, memories, maxCandidates = 3) {
  const newTerms = new Set(tokenize(newFact));
  if (newTerms.size === 0) return [];

  return memories
    .map((m) => {
      const terms = new Set(tokenize(m.fact));
      let shared = 0;
      for (const t of terms) if (newTerms.has(t)) shared += 1;
      const union = new Set([...terms, ...newTerms]).size || 1;
      return { memory: m, jaccard: shared / union, shared };
    })
    .filter((c) => c.shared >= 1 && c.jaccard >= 0.2 && c.jaccard < 1)
    .sort((a, b) => b.jaccard - a.jaccard)
    .slice(0, maxCandidates)
    .map((c) => c.memory);
}

class MemoryManager {
  constructor({ repository, ollama }) {
    this.repository = repository;
    this.ollama = ollama;
  }

  async retrieveContext({ query, currentConversationId, model, embeddingModel }) {
    // Cross-conversation RAG queries the vector store, which is keyed by embedding
    // dimension — so the query MUST be embedded with the same dedicated embedding
    // model the chunks were written with, never the chat model (invariant #5).
    const embedModel = embeddingModel || model;
    const contextSections = [];

    // 1. Retrieve Structured User Memories, ranked by relevance to this query so
    //    the most pertinent facts survive the context budget rather than whatever
    //    was most recent.
    try {
      const memories = this.repository.listUserMemories();
      if (memories && memories.length > 0) {
        const relevant = rankMemoriesByRelevance(memories, query, 12);
        const memoryLines = relevant.map((m) => `- ${m.fact} (${m.category})`);
        contextSections.push(`### Stored User Preferences & Facts:\n${memoryLines.join('\n')}`);
      }
    } catch (_e) {
      // Memory list fallback
    }

    // 2. Retrieve Vector RAG Memory (Cross-conversation historical memory)
    try {
      if (query && embedModel) {
        const queryEmbedding = await this.ollama.generateEmbedding({
          model: embedModel,
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
            contextSections.push(
              `### Relevant Past Conversation History:\n${chunkLines.join('\n')}`,
            );
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
          contextSections.push(
            `### Executive Summary of Earlier Conversation:\n${summaryObj.summary}`,
          );
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
                const saved = this.repository.addUserMemory({
                  fact: fact.trim(),
                  category: 'auto-extracted',
                  conversationId,
                });
                // A genuinely new fact may REPLACE an older one ("I use Windows" →
                // "I switched to Linux"). Retire the old one so the assistant stops
                // acting on knowledge the user has moved past.
                if (!saved.deduped) {
                  await this.maybeSupersede({ newMemory: saved, model });
                }
              }
            }
          }
        }
      }
    } catch (_e) {
      // Non-blocking fact extraction
    }
  }

  // Ask the background model whether the new fact replaces any same-topic fact, and
  // retire those it does. Conservative by design: only clear replacements are
  // retired, because wrongly forgetting something the user told us is worse than
  // briefly holding two related facts.
  async maybeSupersede({ newMemory, model }) {
    if (!newMemory || !model || typeof this.ollama.generateChatSync !== 'function') {
      return [];
    }

    let candidates = [];
    try {
      const others = this.repository.listUserMemories().filter((m) => m.id !== newMemory.id);
      candidates = findSupersessionCandidates(newMemory.fact, others);
    } catch (_e) {
      return [];
    }
    if (candidates.length === 0) return [];

    const numbered = candidates.map((c, i) => `${i + 1}. ${c.fact}`).join('\n');
    try {
      const out = await this.ollama.generateChatSync({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Decide which older statements are now OUT OF DATE because the new statement replaces them (the same attribute changed). Do NOT list statements that merely relate to the same topic but can both be true. Output ONLY a JSON array of the numbers to retire, e.g. [1]. If none, output [].',
          },
          {
            role: 'user',
            content: `New statement: "${newMemory.fact}"\n\nOlder statements:\n${numbered}`,
          },
        ],
      });

      const match = out && out.match(/\[[\s\S]*?\]/);
      if (!match) return [];
      const indexes = JSON.parse(match[0]);
      if (!Array.isArray(indexes)) return [];

      const retired = [];
      for (const raw of indexes) {
        const index = Number(raw);
        const target = candidates[index - 1];
        if (target && this.repository.supersedeUserMemory(target.id, newMemory.id)) {
          retired.push(target.id);
        }
      }
      return retired;
    } catch (_e) {
      return [];
    }
  }

  async indexMessageEmbedding({ messageId, conversationId, content, model, embeddingModel }) {
    const embedModel = embeddingModel || model;
    if (!content || !embedModel || content.length < 20) {
      return;
    }

    try {
      const embedding = await this.ollama.generateEmbedding({
        model: embedModel,
        input: content,
      });

      if (embedding && embedding.length > 0) {
        this.repository.saveMessageEmbedding({
          messageId,
          conversationId,
          chunkText: content.slice(0, 500),
          embedding,
          embeddingModel: embedModel,
        });
      }
    } catch (_e) {
      // Embeddings failure non-blocking
    }
  }
}

module.exports = {
  MemoryManager,
  rankMemoriesByRelevance,
  findSupersessionCandidates,
};
