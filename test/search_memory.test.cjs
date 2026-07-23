const test = require('node:test');
const assert = require('node:assert/strict');

const { extractMainText } = require('../electron/search/scraper.cjs');

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
