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
}

module.exports = {
  OllamaService,
  normalizeBaseUrl,
};
