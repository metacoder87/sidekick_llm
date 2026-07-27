// Assembles the layered system prompt for a chat turn: web-search grounding, the
// Expert panel (query planning, hybrid retrieval, cross-vault reranking, aggregation),
// contextual memory, and the user profile — plus the grounding/citation payload the UI
// renders and any Experts worth suggesting.
//
// Extracted from the IPC handler so the most valuable logic in the app is testable in
// isolation rather than buried in a 370-line request handler (ROADMAP Stage 2).
const { performWebSearch } = require('./search/searchService.cjs');
const { scrapeTopResults } = require('./search/scraper.cjs');
const {
  selectTopMatches,
  contributionByExpert,
  fuseHybrid,
  suggestExperts,
} = require('./retrieval.cjs');
const { classifyQuery, planRetrievalQueries, unionMatches } = require('./queryPlanner.cjs');

const BASE_INSTRUCTION =
  'You are Sidekick, an accurate, grounded, and helpful AI desktop assistant.';

// Returns { systemContent, citations, specialistGrounding, suggestedExperts }.
async function buildChatContext({
  repository,
  ollama,
  memoryManager,
  researchWorker,
  content,
  conversationId,
  payload = {},
  model,
  embeddingModel,
  backgroundModel,
  allSettings,
  isWebSearchEnabled,
}) {
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
      currentConversationId: conversationId,
      model,
      embeddingModel,
    });
  } catch (memErr) {
    console.error('Memory Retrieval Error:', memErr.message);
  }

  // 3. Retrieve User Profile & Custom System Instructions
  const userProfile = repository.getUserProfile();
  const profileContext = `\n[USER PROFILE & SYSTEM PREFERENCES]\n- User Name: ${userProfile.name}\n- User Role: ${userProfile.role}\n- Tech Stack: ${userProfile.stack}\n- Preferred Response Tone: ${userProfile.tone}\n- Global System Instructions: ${userProfile.instructions}\n`;

  // 4. Retrieve Specialist RAG context. Supports a PANEL of experts (federated
  //    retrieval): the query is embedded once, each selected vault is searched,
  //    and every expert's persona + matched knowledge is layered into the prompt.
  //    Grounding is tracked per expert so the UI can flag persona-only answers
  //    (invariant #1 — a persona speaking from model weights must never look like
  //    a grounded, cited answer).
  const activeSpecialistIds = Array.isArray(payload.activeSpecialistIds)
    ? payload.activeSpecialistIds.filter(Boolean)
    : payload.activeSpecialistId
      ? [payload.activeSpecialistId]
      : [];

  let specialistContext = '';
  let specialistGrounding = null;
  let aggregateSurvey = null;
  if (activeSpecialistIds.length > 0) {
    try {
      // Choose a retrieval strategy for THIS question rather than always doing
      // top-k similarity (see electron/queryPlanner.cjs).
      const classification = classifyQuery(content);
      const retrievalQueries = await planRetrievalQueries({
        query: content,
        classification,
        ollama,
        model: backgroundModel,
      });

      // Embed every planned query once (the original plus any sub-questions or
      // contradiction probes).
      const embeddings = [];
      for (const q of retrievalQueries) {
        const emb = await ollama.generateEmbedding({ model: embeddingModel, input: q });
        if (emb && emb.length > 0) embeddings.push({ query: q, embedding: emb });
      }

      const hubs = [];
      const groups = [];
      for (const specialistId of activeSpecialistIds) {
        const hub = repository.getSpecialistHub(specialistId);
        if (!hub) continue;
        hubs.push(hub);

        // Hybrid retrieval per planned query: vector similarity (paraphrase) fused
        // with BM25 (exact terms) via RRF; results across queries are unioned at
        // best score, then globally reranked across vaults below.
        const perQuery = [];
        for (const { query, embedding } of embeddings) {
          const vectorMatches =
            repository.searchSpecialistVectorMemory(hub.id, embedding, 8, embeddingModel) || [];
          const keywordMatches = repository.searchSpecialistKeyword(hub.id, query, 8) || [];
          perQuery.push(fuseHybrid(vectorMatches, keywordMatches, 8));
        }
        groups.push({
          expert: { id: hub.id, name: hub.name },
          matches: unionMatches(perQuery).slice(0, 8),
        });
      }

      // Aggregation questions need a survey of the whole vault, not top-k. Run it
      // for the first consulted Expert and hand the model a grounded overview.
      if (classification.aggregate && hubs.length > 0) {
        const primary = hubs[0];
        const survey = await researchWorker.aggregateVault({
          hubId: primary.id,
          hubName: primary.name,
          topic: content,
          model: backgroundModel,
        });
        if (survey.success) {
          aggregateSurvey = { expertName: primary.name, ...survey };
        }
      }

      if (hubs.length > 0) {
        const topChunks = selectTopMatches(groups, 6);
        const contribution = contributionByExpert(topChunks);

        // Persona/instructions for every consulted expert.
        const roleBlocks = hubs.map(
          (hub) =>
            `### Expert: ${hub.name}\n${hub.description ? `${hub.description}\n` : ''}${hub.systemPrompt ? `Instructions: ${hub.systemPrompt}\n` : ''}`,
        );

        // A single globally-ranked knowledge section, labeled by expert + source.
        const knowledgeSection = topChunks.length
          ? `Retrieved knowledge (ranked across all consulted vaults):\n${topChunks
              .map((c) => `[${c.expertName} · ${c.sourceTitle}]: "${c.chunkText}"`)
              .join('\n\n')}`
          : `(No matching knowledge was found in the consulted vaults for this question — answer from expertise only, and say so.)`;

        const panelIntro =
          hubs.length === 1
            ? `You are operating as the AI Specialist "${hubs[0].name}".`
            : `You are consulting a panel of ${hubs.length} AI Specialists: ${hubs
                .map((h) => h.name)
                .join(
                  ', ',
                )}. Integrate their expertise; when experts would disagree, present the perspectives rather than flattening them.`;

        // A whole-vault survey (aggregation questions) is grounded evidence too —
        // it is derived from the corpus, so label it as such.
        const surveySection = aggregateSurvey
          ? `\nVault survey of ${aggregateSurvey.expertName} (${aggregateSurvey.sampled} of ${aggregateSurvey.total} chunks, synthesized from the corpus):\n${aggregateSurvey.summary}\n`
          : '';

        // For "does anything here contradict X?" questions, the retrieval above
        // deliberately included opposing framings. Tell the model to weigh them
        // rather than defaulting to agreement (Stance §1 — no narrative-spin).
        const contradictionDirective = classification.contradiction
          ? '\nThis question asks about conflicts or correctness. Actively look for disagreement in the retrieved knowledge. State plainly what the sources support, what they contradict, and where the record is silent — do not smooth over a conflict to make the answer agreeable.'
          : '';

        specialistContext = `\n<specialist_panel>\n${panelIntro}\nWhen you use an expert's vault knowledge, cite the expert and source. Do not fabricate sources.${contradictionDirective}\n\n${roleBlocks.join('\n')}\n${knowledgeSection}\n${surveySection}</specialist_panel>\n`;

        specialistGrounding = {
          experts: hubs.map((h) => ({
            id: h.id,
            name: h.name,
            matches: contribution.get(h.id) || 0,
          })),
          grounded: topChunks.length > 0 || Boolean(aggregateSurvey),
          matches: topChunks.length,
          strategy: classification.type,
          survey: aggregateSurvey
            ? {
                expertName: aggregateSurvey.expertName,
                sampled: aggregateSurvey.sampled,
                total: aggregateSurvey.total,
              }
            : null,
          // The exact chunks that were put in front of the model, with provenance.
          // Source cards are rendered FROM THIS — never parsed out of the model's
          // prose — so a citation is always precise and verifiable (invariant #1).
          sources: topChunks.map((c, index) => ({
            id: index + 1,
            expertName: c.expertName,
            sourceTitle: c.sourceTitle,
            sourceUrl: c.sourceUrl || '',
            quote: c.chunkText,
            location: c.location || null,
            page: c.page ?? null,
            sourceType: c.sourceType || null,
            score: Number(c.score.toFixed(4)),
          })),
        };
      }
    } catch (specErr) {
      console.error('Specialist RAG Error:', specErr.message);
    }
  }

  // Auto-suggest Experts that are NOT currently consulted but hold clearly relevant
  // knowledge — the "cohesive brain" association the user shouldn't have to
  // remember to make. Cheap: one embedding, reused, over the un-consulted vaults.
  let suggestedExperts = [];
  try {
    const allHubs = repository.listSpecialistHubs() || [];
    const notConsulted = allHubs.filter(
      (h) => !activeSpecialistIds.includes(h.id) && h.retrievableChunkCount > 0,
    );
    if (notConsulted.length > 0) {
      const probe = await ollama.generateEmbedding({ model: embeddingModel, input: content });
      if (probe && probe.length > 0) {
        const candidateGroups = notConsulted.slice(0, 12).map((hub) => ({
          expert: { id: hub.id, name: hub.name },
          matches: repository.searchSpecialistVectorMemory(hub.id, probe, 3, embeddingModel) || [],
        }));
        suggestedExperts = suggestExperts(candidateGroups);
      }
    }
  } catch (suggestErr) {
    console.error('Expert suggestion error:', suggestErr.message);
  }

  // Build the system message with profile, specialist panel, memory & search context.
  const systemContent = [
    BASE_INSTRUCTION,
    profileContext,
    specialistContext,
    memoryContext,
    webSearchContext,
  ]
    .filter(Boolean)
    .join('\n\n');

  return { systemContent, citations, specialistGrounding, suggestedExperts };
}

module.exports = { buildChatContext, BASE_INSTRUCTION };
