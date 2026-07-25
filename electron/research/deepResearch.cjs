const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PDFParse } = require('pdf-parse');
const { scrapePage } = require('../search/scraper.cjs');
const { performWebSearch } = require('../search/searchService.cjs');

function dedupeStrings(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

// Like chunkText, but reports each chunk's character range within the normalized
// text it came from. Offsets are into the whitespace-normalized extraction (which is
// exactly what we store as chunk_text), so a citation can point at a precise range
// and the stored quote always matches what the model was shown.
function chunkTextWithOffsets(text, chunkSize = 800, overlap = 150) {
  if (!text) return [];
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  let index = 0;

  while (index < clean.length) {
    const slice = clean.slice(index, index + chunkSize);
    if (slice.length > 50) {
      chunks.push({ text: slice, charStart: index, charEnd: index + slice.length });
    }
    index += chunkSize - overlap;
  }

  return chunks;
}

function chunkText(text, chunkSize = 800, overlap = 150) {
  if (!text) return [];
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  let index = 0;

  while (index < clean.length) {
    const chunk = clean.slice(index, index + chunkSize);
    if (chunk.length > 50) {
      chunks.push(chunk);
    }
    index += chunkSize - overlap;
  }

  return chunks;
}

class DeepResearchWorker {
  constructor({ repository, ollama, search = performWebSearch }) {
    this.repository = repository;
    this.ollama = ollama;
    // Injectable so the search/fallback orchestration can be tested without network.
    this.search = search;
  }

  async ingestFilePath({ hubId, filePath, model, embeddingModel, onProgress = () => {} }) {
    // Embeddings always use the dedicated embedding model, never the chat model
    // (ROADMAP §3 invariant #5). Fall back to `model` for older callers/tests.
    const embedModel = embeddingModel || model;
    const ext = path.extname(filePath).toLowerCase();
    const title = path.basename(filePath);

    onProgress({ status: 'reading_file', message: `Reading ${title}...` });

    // Build chunks that carry their own provenance so citations can name an exact
    // location (ROADMAP Stage 2 — precise verifiable citations).
    const chunks = [];

    if (ext === '.pdf') {
      // pdf-parse v2 exposes a PDFParse class (the v1 callable default no longer
      // exists). The pdfjs worker it spins up must be destroyed or it leaks.
      const buffer = await fs.readFile(filePath);
      const parser = new PDFParse({ data: buffer });
      let pages = [];
      try {
        const result = await parser.getText();
        // Per-page extraction gives us real page numbers for citations; fall back to
        // the whole-document text if a build doesn't populate `pages`.
        pages = Array.isArray(result.pages) && result.pages.length
          ? result.pages
          : [{ num: null, text: result.text || '' }];
      } finally {
        await parser.destroy();
      }

      for (const pageResult of pages) {
        const pageNum = typeof pageResult.num === 'number' ? pageResult.num : null;
        const label = pageNum ? `p. ${pageNum}` : null;
        let pieces = chunkTextWithOffsets(pageResult.text || '');

        // Chunking per page buys precise page citations, but a short page would fall
        // below the chunk minimum and be dropped — content the old document-wide
        // chunking kept. Index a short-but-meaningful page as a single chunk instead.
        if (pieces.length === 0) {
          const normalized = (pageResult.text || '').replace(/\s+/g, ' ').trim();
          if (normalized.length >= 20) {
            pieces = [{ text: normalized, charStart: 0, charEnd: normalized.length }];
          }
        }

        for (const piece of pieces) {
          chunks.push({ ...piece, page: pageNum, location: label, sourceType: 'pdf' });
        }
      }
    } else {
      const fullText = await fs.readFile(filePath, 'utf8');
      for (const piece of chunkTextWithOffsets(fullText)) {
        chunks.push({
          ...piece,
          page: null,
          location: `chars ${piece.charStart}–${piece.charEnd}`,
          sourceType: 'document',
        });
      }
    }

    // No indexable chunks means nothing was actually learned — whether the file
    // was empty, scanned/image-only, or too short. Report a clear failure instead
    // of "successfully ingested 0 chunks" (ROADMAP §5 Phase 2 — no silent success).
    if (chunks.length === 0) {
      const reason =
        ext === '.pdf'
          ? 'No indexable text found — this PDF appears to be scanned or image-only. Try an OCR-processed copy.'
          : 'The selected file did not contain enough readable text to index.';
      onProgress({ status: 'error', message: reason });
      return { success: false, reason, chunksCount: 0 };
    }
    onProgress({
      status: 'embedding',
      message: `Extracted ${chunks.length} chunks. Generating embeddings...`,
      total: chunks.length,
      current: 0,
    });

    let indexed = 0;
    let failed = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let embedding = null;
      try {
        embedding = await this.ollama.generateEmbedding({ model: embedModel, input: chunk.text });
      } catch (_e) {
        embedding = null;
      }

      // A chunk without a valid embedding is unretrievable — skip and count it as
      // failed rather than storing a dead row (the repository write boundary would
      // reject it anyway). ROADMAP §5 Phase 1/3 — no silent success.
      if (!Array.isArray(embedding) || embedding.length === 0) {
        failed++;
      } else {
        this.repository.saveSpecialistChunk({
          hubId,
          sourceTitle: title,
          // pathToFileURL yields a correct file URL (three slashes + drive letter on
          // Windows, percent-encoded); hand-building `file://` + path produces
          // `file://C:/…`, where `C:` is parsed as a host and the link won't open.
          sourceUrl: pathToFileURL(filePath).href,
          chunkText: chunk.text,
          embedding,
          embeddingModel: embedModel,
          location: chunk.location,
          page: chunk.page,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          sourceType: chunk.sourceType,
        });
        indexed++;
      }

      onProgress({
        status: 'embedding',
        message: `Indexed chunk ${i + 1} of ${chunks.length}...`,
        total: chunks.length,
        current: i + 1,
      });
    }

    // If embeddings were required but none succeeded, the ingest failed even though
    // text was extracted — report it honestly instead of claiming success.
    if (indexed === 0) {
      const reason = `Extracted ${chunks.length} chunks but could not embed any — check that the embedding model "${embedModel}" is installed and supports embeddings.`;
      onProgress({ status: 'error', message: reason });
      return { success: false, reason, chunksCount: 0, chunksFailed: failed };
    }

    onProgress({
      status: 'complete',
      message: `Ingested ${title}: indexed ${indexed} chunks${failed ? ` (${failed} failed to embed)` : ''}.`,
    });
    return { success: true, chunksCount: indexed, chunksFailed: failed };
  }

  // Turn a topic — which may be a short phrase OR a long multi-paragraph research
  // brief — into concrete web search queries. Search engines return nothing for a
  // 1000-character blob, so "Deep Research" must decompose it (ROADMAP §5 Phase 2 /
  // Stage 2 retrieval). Priority: explicit quoted queries the user wrote → the raw
  // topic if it is already short → LLM-generated queries → a heuristic first line.
  async deriveSearchQueries(topic, model) {
    const trimmed = (topic || '').trim();
    if (!trimmed) return [];

    // 1. Explicit "quoted" search queries embedded in the brief win outright.
    const quoted = [...trimmed.matchAll(/"([^"]{3,200})"/g)].map((m) => m[1].trim()).filter(Boolean);
    if (quoted.length > 0) return dedupeStrings(quoted).slice(0, 5);

    // 2. Already a simple query — use it verbatim.
    if (trimmed.length <= 120 && !trimmed.includes('\n')) return [trimmed];

    // 3. Ask the chat model to decompose the brief into concise queries.
    if (model && typeof this.ollama.generateChatSync === 'function') {
      try {
        const out = await this.ollama.generateChatSync({
          model,
          messages: [
            {
              role: 'system',
              content:
                'You convert a research brief into web search queries. Output ONLY a JSON array of 3 to 5 short query strings (each under 12 words, no quotes, no site: operators unless essential). No prose, no explanation.',
            },
            { role: 'user', content: trimmed.slice(0, 2000) },
          ],
        });
        const match = out && out.match(/\[[\s\S]*\]/);
        if (match) {
          const arr = JSON.parse(match[0]);
          if (Array.isArray(arr)) {
            const queries = dedupeStrings(arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()));
            if (queries.length > 0) return queries.slice(0, 5);
          }
        }
      } catch (_e) {
        // Fall through to the heuristic.
      }
    }

    // 4. Heuristic last resort: first non-empty line, drop a leading "Label:" prefix,
    //    cap to a searchable length.
    const firstLine = trimmed.split('\n').map((s) => s.trim()).find(Boolean) || trimmed;
    const noLabel = firstLine.replace(/^[^:]{0,40}:\s*/, '');
    return [noLabel.split(/\s+/).slice(0, 12).join(' ')];
  }

  async runWebDeepResearch({ hubId, topic, seedUrls = [], depth = 1, model, embeddingModel, searchOptions = {}, onProgress = () => {} }) {
    const embedModel = embeddingModel || model;
    onProgress({ status: 'searching', message: `Searching the web for "${topic}"...` });

    let totalChunks = 0;
    let totalFailed = 0;

    // Helper: embed a piece of text and store it as a vault chunk; returns true on
    // success. Centralizes the write-boundary handling used everywhere below.
    const indexChunk = async ({ sourceTitle, sourceUrl, chunkText: text, location = null, charStart = null, charEnd = null, sourceType = 'web' }) => {
      let embedding = null;
      try {
        embedding = await this.ollama.generateEmbedding({ model: embedModel, input: text });
      } catch (_e) {
        embedding = null;
      }
      if (!Array.isArray(embedding) || embedding.length === 0) {
        totalFailed++;
        return false;
      }
      this.repository.saveSpecialistChunk({
        hubId,
        sourceTitle,
        sourceUrl,
        chunkText: text,
        embedding,
        embeddingModel: embedModel,
        location,
        page: null,
        charStart,
        charEnd,
        sourceType,
      });
      totalChunks++;
      return true;
    };

    let targetUrls = [...seedUrls];
    const trimmedTopic = (topic || '').trim();
    const topicIsUrl = /^https?:\/\//i.test(trimmedTopic) || /^www\./i.test(trimmedTopic);

    if (topicIsUrl) {
      const formatted = /^https?:\/\//i.test(trimmedTopic) ? trimmedTopic : `https://${trimmedTopic}`;
      if (!targetUrls.includes(formatted)) targetUrls.push(formatted);
    } else if (trimmedTopic) {
      // Decompose the topic/brief into concrete queries, then search each. Routes
      // through performWebSearch so the configured provider + fallback chain apply.
      const queries = await this.deriveSearchQueries(trimmedTopic, model);
      onProgress({
        status: 'searching',
        message: `Running ${queries.length} search ${queries.length === 1 ? 'query' : 'queries'} derived from your topic...`,
      });

      const seenUrls = new Set(targetUrls);
      const MAX_SOURCES = 10;
      for (const query of queries) {
        if (targetUrls.length >= MAX_SOURCES) break;
        const searchResults = await this.search({
          query,
          provider: searchOptions.provider || 'duckduckgo',
          options: {
            searxngUrl: searchOptions.searxngUrl,
            tavilyApiKey: searchOptions.tavilyApiKey,
            braveApiKey: searchOptions.braveApiKey,
            maxResults: 5,
          },
        });

        for (const res of searchResults) {
          if (!res.url || seenUrls.has(res.url)) continue;
          seenUrls.add(res.url);
          if (targetUrls.length < MAX_SOURCES) targetUrls.push(res.url);
          // Index the result snippet directly, once per URL. This guarantees the
          // run yields knowledge even if the page later fails to scrape.
          if (res.snippet && res.snippet.length > 40) {
            await indexChunk({
              sourceTitle: `Snippet: ${res.title || res.url}`,
              sourceUrl: res.url,
              chunkText: `${res.title}\n${res.snippet}`,
              location: 'search result snippet',
              sourceType: 'web-snippet',
            });
          }
        }
      }

      // No sources at all — a distinct, actionable failure (not an embedding issue).
      if (targetUrls.length === 0) {
        const reason = `Web search returned no sources for the derived queries (${queries.map((q) => `"${q}"`).join(', ')}). Try simpler keywords, paste a direct URL as the topic, or configure a search provider (Tavily/Brave) in Settings → Web Search.`;
        onProgress({ status: 'error', message: reason });
        return { success: false, reason, totalChunks: 0, totalFailed };
      }
    }

    onProgress({
      status: 'scraping',
      message: `Found ${targetUrls.length} web sources. Scraping content...`,
      total: targetUrls.length,
      current: 0,
    });

    let urlIndex = 0;

    for (const url of targetUrls) {
      urlIndex++;
      onProgress({
        status: 'scraping',
        message: `Scraping source ${urlIndex} of ${targetUrls.length}: ${url}`,
        total: targetUrls.length,
        current: urlIndex,
      });

      const pageText = await scrapePage(url, 8000);
      if (!pageText || pageText.length < 100) continue;

      let title = url;
      try {
        title = new URL(url).hostname;
      } catch (_e) {
        // Fallback title
      }

      for (const piece of chunkTextWithOffsets(pageText)) {
        await indexChunk({
          sourceTitle: `Web: ${title}`,
          sourceUrl: url,
          chunkText: piece.text,
          location: `chars ${piece.charStart}–${piece.charEnd}`,
          charStart: piece.charStart,
          charEnd: piece.charEnd,
          sourceType: 'web',
        });
      }
    }

    if (totalChunks === 0) {
      // We had sources (snippets and/or URLs) but none produced an indexed chunk.
      // Separate the likely causes so the message is actionable.
      const reason =
        totalFailed > 0
          ? `Found ${targetUrls.length} sources but could not embed any content — check that the embedding model "${embedModel}" is installed and supports embeddings.`
          : `Found ${targetUrls.length} sources but none returned readable content — the pages may be unreachable, blocked, or non-HTML. Check your connection or try a direct URL.`;
      onProgress({ status: 'error', message: reason });
      return { success: false, reason, totalChunks: 0, totalFailed };
    }

    onProgress({
      status: 'complete',
      message: `Deep research finished! Indexed ${totalChunks} knowledge chunks${totalFailed ? ` (${totalFailed} failed to embed)` : ''} into Specialist Hub.`,
    });

    return { success: true, totalChunks, totalFailed };
  }

  // Repair a vault by re-embedding every chunk that isn't already indexed with the
  // current embedding model (legacy NULL-model rows, or rows from a prior model).
  // Cheap because chunk_text is already stored — no re-scraping or re-upload needed
  // (ROADMAP §5 Phase 4). Idempotent: a fully-indexed vault re-indexes 0 chunks.
  async reindexHub({ hubId, embeddingModel, onProgress = () => {} }) {
    const targets = this.repository.listChunksForReindex(hubId, embeddingModel);
    if (targets.length === 0) {
      onProgress({ status: 'complete', message: 'Vault is already fully indexed with the current embedding model.' });
      return { success: true, reindexed: 0, failed: 0, total: 0 };
    }

    onProgress({
      status: 'reindexing',
      message: `Re-indexing ${targets.length} chunks with ${embeddingModel}...`,
      total: targets.length,
      current: 0,
    });

    let reindexed = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      let embedding = null;
      try {
        embedding = await this.ollama.generateEmbedding({ model: embeddingModel, input: target.chunkText });
      } catch (_e) {
        embedding = null;
      }

      if (!Array.isArray(embedding) || embedding.length === 0) {
        failed++;
      } else {
        this.repository.updateChunkEmbedding(target.id, embedding, embeddingModel);
        reindexed++;
      }

      onProgress({
        status: 'reindexing',
        message: `Re-indexed ${i + 1} of ${targets.length}...`,
        total: targets.length,
        current: i + 1,
      });
    }

    if (reindexed === 0) {
      const reason = `Could not re-embed any chunks — check that the embedding model "${embeddingModel}" is installed and supports embeddings.`;
      onProgress({ status: 'error', message: reason });
      return { success: false, reason, reindexed: 0, failed, total: targets.length };
    }

    onProgress({
      status: 'complete',
      message: `Re-indexed ${reindexed} chunks${failed ? ` (${failed} failed)` : ''}.`,
    });
    return { success: true, reindexed, failed, total: targets.length };
  }
}

module.exports = {
  DeepResearchWorker,
  chunkText,
};
