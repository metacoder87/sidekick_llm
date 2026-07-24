const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFParse } = require('pdf-parse');
const { scrapePage } = require('../search/scraper.cjs');
const { searchDuckDuckGo } = require('../search/searchService.cjs');

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
  constructor({ repository, ollama }) {
    this.repository = repository;
    this.ollama = ollama;
  }

  async ingestFilePath({ hubId, filePath, model, embeddingModel, onProgress = () => {} }) {
    // Embeddings always use the dedicated embedding model, never the chat model
    // (ROADMAP §3 invariant #5). Fall back to `model` for older callers/tests.
    const embedModel = embeddingModel || model;
    const ext = path.extname(filePath).toLowerCase();
    let title = path.basename(filePath);
    let fullText = '';

    onProgress({ status: 'reading_file', message: `Reading ${title}...` });

    if (ext === '.pdf') {
      // pdf-parse v2 exposes a PDFParse class (the v1 callable default no longer
      // exists). The pdfjs worker it spins up must be destroyed or it leaks.
      const buffer = await fs.readFile(filePath);
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        fullText = result.text || '';
      } finally {
        await parser.destroy();
      }
    } else {
      fullText = await fs.readFile(filePath, 'utf8');
    }

    const chunks = chunkText(fullText);

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
        embedding = await this.ollama.generateEmbedding({ model: embedModel, input: chunk });
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
          sourceUrl: `file://${filePath.replace(/\\/g, '/')}`,
          chunkText: chunk,
          embedding,
          embeddingModel: embedModel,
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

  async runWebDeepResearch({ hubId, topic, seedUrls = [], depth = 1, model, embeddingModel, onProgress = () => {} }) {
    const embedModel = embeddingModel || model;
    onProgress({ status: 'searching', message: `Initializing research for "${topic}"...` });

    let targetUrls = [...seedUrls];

    if (topic && topic.trim()) {
      try {
        const searchResults = await searchDuckDuckGo(topic, 5);
        for (const res of searchResults) {
          if (res.url && !targetUrls.includes(res.url)) {
            targetUrls.push(res.url);
          }
        }
      } catch (_e) {
        // Search fallback
      }
    }

    onProgress({
      status: 'scraping',
      message: `Found ${targetUrls.length} web sources. Scraping content...`,
      total: targetUrls.length,
      current: 0,
    });

    let totalChunks = 0;
    let totalFailed = 0;
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

      const chunks = chunkText(pageText);
      for (const chunk of chunks) {
        let embedding = null;
        try {
          embedding = await this.ollama.generateEmbedding({ model: embedModel, input: chunk });
        } catch (_e) {
          embedding = null;
        }

        // Skip chunks that could not be embedded — a dead vector is unretrievable
        // and the write boundary would reject it (invariant #4).
        if (!Array.isArray(embedding) || embedding.length === 0) {
          totalFailed++;
          continue;
        }

        this.repository.saveSpecialistChunk({
          hubId,
          sourceTitle: `Web: ${title}`,
          sourceUrl: url,
          chunkText: chunk,
          embedding,
          embeddingModel: embedModel,
        });

        totalChunks++;
      }
    }

    if (totalChunks === 0) {
      const reason = `Scraped ${targetUrls.length} sources but indexed nothing — check that the embedding model "${embedModel}" is installed and supports embeddings, or that sources were reachable.`;
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
