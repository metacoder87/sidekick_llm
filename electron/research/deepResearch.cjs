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

  async ingestFilePath({ hubId, filePath, model, onProgress = () => {} }) {
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

    let count = 0;
    for (const chunk of chunks) {
      count++;
      let embedding = null;
      try {
        embedding = await this.ollama.generateEmbedding({ model, input: chunk });
      } catch (_e) {
        // Fallback null embedding
      }

      this.repository.saveSpecialistChunk({
        hubId,
        sourceTitle: title,
        sourceUrl: `file://${filePath.replace(/\\/g, '/')}`,
        chunkText: chunk,
        embedding: embedding || [],
      });

      onProgress({
        status: 'embedding',
        message: `Indexed chunk ${count} of ${chunks.length}...`,
        total: chunks.length,
        current: count,
      });
    }

    onProgress({ status: 'complete', message: `Successfully ingested ${title} (${count} chunks)!` });
    return { success: true, chunksCount: count };
  }

  async runWebDeepResearch({ hubId, topic, seedUrls = [], depth = 1, model, onProgress = () => {} }) {
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
          embedding = await this.ollama.generateEmbedding({ model, input: chunk });
        } catch (_e) {
          // Fallback
        }

        this.repository.saveSpecialistChunk({
          hubId,
          sourceTitle: `Web: ${title}`,
          sourceUrl: url,
          chunkText: chunk,
          embedding: embedding || [],
        });

        totalChunks++;
      }
    }

    onProgress({
      status: 'complete',
      message: `Deep research finished! Indexed ${totalChunks} knowledge chunks into Specialist Hub.`,
    });

    return { success: true, totalChunks };
  }
}

module.exports = {
  DeepResearchWorker,
  chunkText,
};
