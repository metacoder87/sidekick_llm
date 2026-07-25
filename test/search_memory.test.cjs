const test = require('node:test');
const assert = require('node:assert/strict');

const { extractMainText } = require('../electron/search/scraper.cjs');
const { rankMemoriesByRelevance } = require('../electron/memory/memoryManager.cjs');
const { selectTopMatches, contributionByExpert, fuseHybrid } = require('../electron/retrieval.cjs');

test('fuseHybrid (RRF) rewards chunks ranked well in BOTH vector and keyword lists', () => {
  // `both` is 2nd in each list; `vecOnly` is 1st in vector but absent from keyword.
  // RRF should promote `both`, because agreement across independent rankings is
  // stronger evidence than a single list's top hit.
  const vector = [
    { chunkId: 'vecOnly', chunkText: 'semantically close but wrong', score: 0.80 },
    { chunkId: 'both', chunkText: 'the right passage', score: 0.72 },
  ];
  const keyword = [
    { chunkId: 'kwOnly', chunkText: 'lexical noise' },
    { chunkId: 'both', chunkText: 'the right passage' },
  ];

  const fused = fuseHybrid(vector, keyword, 3);
  assert.equal(fused[0].chunkId, 'both');
  // Keyword-only hits are still available (a safety net for low-cosine matches).
  assert.ok(fused.some((f) => f.chunkId === 'kwOnly'));
  // Real cosine scores survive for the downstream cross-vault reranker.
  assert.equal(fused.find((f) => f.chunkId === 'both').score, 0.72);
  // Keyword-only hits get a usable fallback score rather than undefined.
  assert.equal(typeof fused.find((f) => f.chunkId === 'kwOnly').score, 'number');
});

test('fuseHybrid tolerates an empty side (vector-only or keyword-only)', () => {
  const vecOnly = fuseHybrid([{ chunkId: 'a', score: 0.9 }], [], 5);
  assert.equal(vecOnly.length, 1);
  const kwOnly = fuseHybrid([], [{ chunkId: 'b' }], 5);
  assert.equal(kwOnly.length, 1);
  assert.deepEqual(fuseHybrid([], [], 5), []);
});

test('buildTextFragment produces a start,end fragment for long quotes and a plain one for short', async () => {
  const { buildTextFragment, buildSourceLink } = await import('../src/lib/citations.js');

  // Short quote → matched verbatim.
  assert.equal(buildTextFragment('liability is limited'), '#:~:text=liability%20is%20limited');

  // Long quote → start,end range form (more reliable than one huge match).
  const long = 'Clause seven point two limits the total aggregate liability of the vendor to the fees actually paid during the prior twelve month period';
  const frag = buildTextFragment(long);
  assert.ok(frag.startsWith('#:~:text='));
  assert.ok(frag.includes(','), 'long quotes should use the textStart,textEnd form');

  // Web source → URL + fragment, flagged precise.
  const web = buildSourceLink({ sourceUrl: 'https://example.com/doc', quote: long, location: 'chars 0–120' });
  assert.ok(web.href.startsWith('https://example.com/doc#:~:text='));
  assert.equal(web.precise, true);

  // Local PDF → page anchor.
  const pdf = buildSourceLink({ sourceUrl: 'file:///C:/docs/contract.pdf', quote: 'x', page: 12, location: 'p. 12' });
  assert.equal(pdf.href, 'file:///C:/docs/contract.pdf#page=12');
  assert.equal(pdf.precise, true);
  assert.equal(pdf.label, 'p. 12');

  // No URL → nothing linkable, but the location still shows.
  const none = buildSourceLink({ sourceUrl: '', quote: 'x', location: 'p. 3' });
  assert.equal(none.href, null);
  assert.equal(none.label, 'p. 3');
});

test('selectTopMatches carries citation provenance through to the selected set', () => {
  const groups = [
    {
      expert: { id: 'a', name: 'Legal Expert' },
      matches: [
        { sourceTitle: 'contract.pdf', sourceUrl: 'file:///c/contract.pdf', chunkText: 'Clause 7.2 …', score: 0.9, location: 'p. 12', page: 12, sourceType: 'pdf' },
      ],
    },
  ];
  const [top] = selectTopMatches(groups, 3);
  assert.equal(top.page, 12);
  assert.equal(top.location, 'p. 12');
  assert.equal(top.sourceUrl, 'file:///c/contract.pdf');
  assert.equal(top.sourceType, 'pdf');
});

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
