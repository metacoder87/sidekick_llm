const test = require('node:test');
const assert = require('node:assert/strict');

const { extractMainText } = require('../electron/search/scraper.cjs');
const { rankMemoriesByRelevance } = require('../electron/memory/memoryManager.cjs');

test('rankMemoriesByRelevance surfaces query-relevant facts over merely-recent ones', () => {
  const memories = [
    { fact: 'User deploys with Docker and Kubernetes', category: 'stack', updatedAt: '2026-07-24T10:00:00Z' },
    { fact: 'User prefers React with Vite for frontend work', category: 'stack', updatedAt: '2026-07-24T09:00:00Z' },
    { fact: 'User lives in the Pacific timezone', category: 'personal', updatedAt: '2026-07-24T11:00:00Z' },
  ];

  // With a single slot, the relevant fact must be chosen over the most-recent one
  // (the timezone fact is newest but irrelevant).
  const top = rankMemoriesByRelevance(memories, 'How do I optimize my React component rendering?', 1);
  assert.equal(top.length, 1);
  assert.equal(top[0].fact, 'User prefers React with Vite for frontend work');
});

test('rankMemoriesByRelevance falls back to recency when the query has no overlap', () => {
  const memories = [
    { fact: 'Older fact', category: 'general', updatedAt: '2026-07-01T00:00:00Z' },
    { fact: 'Newer fact', category: 'general', updatedAt: '2026-07-20T00:00:00Z' },
  ];
  const ranked = rankMemoriesByRelevance(memories, 'zzzz', 2);
  assert.equal(ranked[0].fact, 'Newer fact');
});

test('scraper extractMainText strips HTML scripts, styles, and extracts readable body text', () => {
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Test Page</title>
        <style>body { background: red; }</style>
        <script>console.log("secret script");</script>
      </head>
      <body>
        <header><nav><a href="#">Nav item</a></nav></header>
        <main>
          <h1>Sidekick Architecture Guide</h1>
          <p>Sidekick LLM is a desktop application for running local language models with full conversation history stored in SQLite.</p>
          <p>It supports offline inference with Ollama and real-time internet search grounding.</p>
        </main>
      </body>
    </html>
  `;

  const text = extractMainText(sampleHtml);
  assert.ok(text.includes('Sidekick Architecture Guide'));
  assert.ok(text.includes('Sidekick LLM is a desktop application'));
  assert.ok(!text.includes('console.log'));
  assert.ok(!text.includes('body { background: red; }'));
});
