function normalizeBaseUrl(value) {
  return (value || 'http://localhost:11434').replace(/\/+$/, '');
}

class OllamaService {
  constructor(options = {}) {
    this.getBaseUrl = options.getBaseUrl || (() => 'http://localhost:11434');
  }

  baseUrl() {
    return normalizeBaseUrl(this.getBaseUrl());
  }

  async getStatus() {
    try {
      const models = await this.listModels();
      return {
        available: true,
        baseUrl: this.baseUrl(),
        models,
      };
    } catch (error) {
      return {
        available: false,
        baseUrl: this.baseUrl(),
        models: [],
        error: error.message,
      };
    }
  }

  async listModels() {
    const response = await fetch(`${this.baseUrl()}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}.`);
    }

    const payload = await response.json();
    return (payload.models || []).map((model) => ({
      name: model.name,
      size: model.size ?? null,
      modifiedAt: model.modified_at ?? null,
      isAvailable: true,
    }));
  }

  async generateChat({ model, messages, signal, onChunk }) {
    const response = await fetch(`${this.baseUrl()}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}.`);
    }

    if (!response.body) {
      const payload = await response.json();
      return payload.message?.content || '';
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        if (!part.trim()) {
          continue;
        }

        const payload = JSON.parse(part);
        const chunk = payload.message?.content || '';
        if (chunk) {
          fullText += chunk;
          onChunk(chunk, fullText);
        }

        if (payload.error) {
          throw new Error(payload.error);
        }
      }
    }

    if (buffer.trim()) {
      const payload = JSON.parse(buffer);
      const chunk = payload.message?.content || '';
      if (chunk) {
        fullText += chunk;
        onChunk(chunk, fullText);
      }
      if (payload.error) {
        throw new Error(payload.error);
      }
    }

    return fullText.trim();
  }

  async generateChatSync({ model, messages }) {
    const response = await fetch(`${this.baseUrl()}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}.`);
    }

    const payload = await response.json();
    return payload.message?.content || '';
  }

  // Download a model, reporting progress. Ollama streams NDJSON status lines; the
  // ones carrying `total`/`completed` are byte counts we can turn into a percentage.
  // Never throws for a cancelled/failed download — the caller reports it honestly.
  async pullModel({ name, signal, onProgress = () => {} }) {
    if (!name) return { ok: false, reason: 'No model name given.' };

    let response;
    try {
      response = await fetch(`${this.baseUrl()}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, stream: true }),
        signal,
      });
    } catch (error) {
      return { ok: false, reason: `Cannot reach Ollama: ${error.message}` };
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      return { ok: false, reason: `Ollama returned ${response.status}. ${detail}`.trim() };
    }
    if (!response.body) {
      return { ok: true, name };
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let lastError = null;

    const handleLine = (line) => {
      if (!line.trim()) return;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (_error) {
        return;
      }
      if (payload.error) {
        lastError = payload.error;
        return;
      }
      const total = Number(payload.total) || 0;
      const completed = Number(payload.completed) || 0;
      onProgress({
        status: payload.status || '',
        total,
        completed,
        percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : null,
      });
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        for (const part of parts) handleLine(part);
      }
      if (buffer.trim()) handleLine(buffer);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        return { ok: false, cancelled: true, reason: 'Download cancelled.' };
      }
      return { ok: false, reason: error.message };
    }

    if (lastError) {
      return { ok: false, reason: lastError };
    }
    return { ok: true, name };
  }

  // Pre-flight an embedding model before a long ingest/research run so we can fail
  // fast with an actionable reason instead of scraping for minutes and producing an
  // empty vault (ROADMAP §5 Phase 3). Returns { ok, dim } or { ok:false, reason }.
  async checkEmbedding(model) {
    if (!model) {
      return { ok: false, reason: 'No embedding model is configured.' };
    }
    try {
      const response = await fetch(`${this.baseUrl()}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'preflight' }),
      });

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 160);
        return {
          ok: false,
          reason: `Embedding model "${model}" returned HTTP ${response.status}. ${detail}`.trim(),
        };
      }

      const payload = await response.json();
      if (payload.error) {
        return { ok: false, reason: `Embedding model "${model}": ${payload.error}` };
      }
      if (!Array.isArray(payload.embedding) || payload.embedding.length === 0) {
        return {
          ok: false,
          reason: `Model "${model}" returned no embedding — it may not support embeddings. Pull a dedicated model like nomic-embed-text.`,
        };
      }
      return { ok: true, dim: payload.embedding.length };
    } catch (error) {
      return {
        ok: false,
        reason: `Cannot reach Ollama to embed with "${model}": ${error.message}`,
      };
    }
  }

  async generateEmbedding({ model, input }) {
    try {
      const response = await fetch(`${this.baseUrl()}/api/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt: input,
        }),
      });

      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      return payload.embedding || null;
    } catch (_error) {
      return null;
    }
  }
}

module.exports = {
  OllamaService,
  normalizeBaseUrl,
};
