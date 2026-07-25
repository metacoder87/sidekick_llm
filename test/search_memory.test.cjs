const test = require('node:test');
const assert = require('node:assert/strict');

const { extractMainText } = require('../electron/search/scraper.cjs');
const { rankMemoriesByRelevance } = require('../electron/memory/memoryManager.cjs');
const { selectTopMatches, contributionByExpert, fuseHybrid } = require('../electron/retrieval.cjs');

const { classifyQuery, planRetrievalQueries, unionMatches } = require('../electron/queryPlanner.cjs');

test('classifyQuery picks the retrieval strategy a question actually needs', () => {
  assert.equal(classifyQuery('What is the liability cap?').type, 'simple');
  assert.equal(classifyQuery('What does this Expert say about indemnity overall?').type, 'aggregate');
  assert.equal(classifyQuery('Summarize the key takeaways').type, 'aggregate');
  assert.equal(classifyQuery('How does my lab result relate to the medication prescribed?').type, 'multihop');
  assert.equal(classifyQuery('Is there anything here that contradicts what my doctor said?').type, 'contradiction');
  // Flags are independent of the dominant type.
  assert.equal(classifyQuery('Is that correct?').contradiction, true);

  // Inflected forms must match — a trailing \b on the stem would silently miss
  // these and drop the strategy.
  assert.equal(classifyQuery('Does this contradicts the guidance?').contradiction, true);
  assert.equal(classifyQuery('Any conflicting advice here?').contradiction, true);
  assert.equal(classifyQuery('How do these relates to each other?').multihop, true);
  assert.equal(classifyQuery('Summarizing the findings please').aggregate, true);
});

test('planRetrievalQueries adds opposing probes for contradiction questions', async () => {
  const query = 'Is there anything that conflicts with the recommended dose?';
  const queries = await planRetrievalQueries({ query, classification: classifyQuery(query) });

  assert.equal(queries[0], query, 'the original question is always retrieved for');
  assert.ok(queries.length > 1, 'contradiction questions retrieve opposing framings too');
  assert.ok(queries.some((q) => /evidence against/i.test(q)));
  assert.ok(queries.some((q) => /limitations|contraindications/i.test(q)));
});

test('planRetrievalQueries decomposes multi-hop questions via the background model', async () => {
  const query = 'Does my vitamin D level relate to the statin I was prescribed?';
  const ollama = {
    generateChatSync: async () => '["What do the sources say about vitamin D levels?", "What do the sources say about statin interactions?"]',
  };
  const queries = await planRetrievalQueries({
    query,
    classification: classifyQuery(query),
    ollama,
    model: 'llama3:8b',
  });

  assert.equal(queries[0], query);
  assert.ok(queries.some((q) => /vitamin D/i.test(q)));
  assert.ok(queries.some((q) => /statin/i.test(q)));
});

test('planRetrievalQueries degrades to the original query when the model fails', async () => {
  const query = 'How do A and B relate together?';
  const ollama = { generateChatSync: async () => { throw new Error('model offline'); } };
  const queries = await planRetrievalQueries({ query, classification: classifyQuery(query), ollama, model: 'x' });
  assert.deepEqual(queries, [query]);
});

test('unionMatches merges per-query results keeping each chunk at its best score', () => {
  const merged = unionMatches([
    [{ chunkId: 'a', score: 0.5 }, { chunkId: 'b', score: 0.9 }],
    [{ chunkId: 'a', score: 0.8 }, { chunkId: 'c', score: 0.4 }],
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].chunkId, 'b');
  assert.equal(merged.find((m) => m.chunkId === 'a').score, 0.8, 'keeps the best score seen for a chunk');
});

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

test('findSupersessionCandidates proposes same-topic facts, not identical or unrelated ones', () => {
  const { findSupersessionCandidates } = require('../electron/memory/memoryManager.cjs');
  const memories = [
    { id: '1', fact: 'User runs Windows 11 as their operating system' },
    { id: '2', fact: 'User enjoys hiking on weekends' },
    { id: '3', fact: 'User switched to Linux as their operating system' },
  ];

  const candidates = findSupersessionCandidates('User switched to Linux as their operating system', memories);
  const ids = candidates.map((c) => c.id);

  assert.ok(ids.includes('1'), 'the same-topic older fact is a candidate');
  assert.ok(!ids.includes('3'), 'an identical fact is not a supersession candidate');
  assert.ok(!ids.includes('2'), 'unrelated facts are not candidates');
});

test('rankMemoriesByRelevance favours reinforced facts and decays stale unreinforced ones', () => {
  const old = new Date(Date.now() - 400 * 86400000).toISOString(); // >180 days
  const memories = [
    { fact: 'User deploys with Docker', category: 'stack', updatedAt: old, reinforcedCount: 1 },
    { fact: 'User deploys with Docker Swarm', category: 'stack', updatedAt: old, reinforcedCount: 5 },
  ];
  // Equal lexical relevance → the repeatedly-stated fact wins the tiebreak.
  const ranked = rankMemoriesByRelevance(memories, 'deploys', 2);
  assert.equal(ranked[0].reinforcedCount, 5);
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
