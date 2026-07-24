const test = require('node:test');
const assert = require('node:assert/strict');

const { extractMainText } = require('../electron/search/scraper.cjs');
const { rankMemoriesByRelevance } = require('../electron/memory/memoryManager.cjs');
const { selectTopMatches, contributionByExpert } = require('../electron/retrieval.cjs');

test('selectTopMatches globally ranks chunks across vaults, so the best win regardless of expert', () => {
  const groups = [
    {
      expert: { id: 'a', name: 'Expert A' },
      matches: [
        { sourceTitle: 'a1', chunkText: 'weak a', score: 0.50 },
        { sourceTitle: 'a2', chunkText: 'mid a', score: 0.72 },
      ],
    },
    {
      expert: { id: 'b', name: 'Expert B' },
      matches: [
        { sourceTitle: 'b1', chunkText: 'best b', score: 0.91 },
        { sourceTitle: 'b2', chunkText: 'good b', score: 0.80 },
      ],
    },
  ];

  const top = selectTopMatches(groups, 3);
  assert.equal(top.length, 3);
  // Highest score first, across experts.
  assert.deepEqual(top.map((t) => t.sourceTitle), ['b1', 'b2', 'a2']);
  // The weakest chunk (a1, 0.50) was dropped even though its expert was consulted.
  assert.ok(!top.some((t) => t.sourceTitle === 'a1'));

  const contrib = contributionByExpert(top);
  assert.equal(contrib.get('b'), 2);
  assert.equal(contrib.get('a'), 1);
});

test('selectTopMatches handles empty groups and missing scores', () => {
  assert.deepEqual(selectTopMatches([], 5), []);
  const top = selectTopMatches([{ expert: { id: 'x', name: 'X' }, matches: [{ sourceTitle: 's', chunkText: 'c' }] }], 5);
  assert.equal(top.length, 1);
  assert.equal(top[0].score, 0);
});

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
