const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConversationRepository } = require('../electron/repository.cjs');
const { chunkText, DeepResearchWorker } = require('../electron/research/deepResearch.cjs');

// Minimal but valid single-page PDF with the given text and correct xref offsets.
function buildPdf(text) {
  const header = '%PDF-1.4\n';
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '';
  const offsets = [];
  let pos = header.length;
  objects.forEach((obj, i) => {
    offsets[i] = pos;
    const chunk = `${i + 1} 0 obj\n${obj}\nendobj\n`;
    body += chunk;
    pos += chunk.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`;
  return Buffer.from(header + body + xref + trailer, 'latin1');
}

test('repository handles user profile get and set operations', () => {
  const repository = new ConversationRepository(':memory:');

  const defaultProfile = repository.getUserProfile();
  assert.equal(defaultProfile.name, 'User');
  assert.equal(defaultProfile.role, 'Software Developer');

  const updatedProfile = repository.setUserProfile({
    name: 'MILLI',
    role: 'AI System Architect',
    tone: 'Concise & Direct',
    stack: 'React, Node.js, Electron',
    instructions: 'Always output TypeScript code snippets with strict typing.',
  });

  assert.equal(updatedProfile.name, 'MILLI');
  assert.equal(updatedProfile.role, 'AI System Architect');
  assert.equal(updatedProfile.tone, 'Concise & Direct');

  const reFetched = repository.getUserProfile();
  assert.equal(reFetched.name, 'MILLI');

  repository.close();
});

test('repository manages specialist hubs and indexes knowledge chunks for vector search', () => {
  const repository = new ConversationRepository(':memory:');

  const hub = repository.createSpecialistHub({
    name: 'React 19 Specialist',
    description: 'Expert knowledge on React 19 hooks and Server Components',
    systemPrompt: 'You are an expert React 19 engineer.',
    icon: 'code',
  });

  assert.ok(hub.id);
  assert.equal(hub.name, 'React 19 Specialist');

  const hubs = repository.listSpecialistHubs();
  assert.equal(hubs.length, 1);
  assert.equal(hubs[0].name, 'React 19 Specialist');

  repository.saveSpecialistChunk({
    hubId: hub.id,
    sourceTitle: 'React 19 Docs',
    sourceUrl: 'https://react.dev',
    chunkText: 'React Server Components allow rendering on the server before sending to client.',
    embedding: [1, 0, 0, 0],
  });

  const matches = repository.searchSpecialistVectorMemory(hub.id, [0.95, 0, 0, 0], 5);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].sourceTitle, 'React 19 Docs');
  assert.ok(matches[0].chunkText.includes('React Server Components'));

  const deleted = repository.deleteSpecialistHub(hub.id);
  assert.equal(deleted, true);
  assert.equal(repository.listSpecialistHubs().length, 0);

  repository.close();
});

test('deepResearch chunkText splits large text into overlapping chunks', () => {
  const sampleText = 'Alpha '.repeat(300);
  const chunks = chunkText(sampleText, 200, 50);

  assert.ok(chunks.length > 1);
  assert.ok(chunks[0].includes('Alpha'));
});

test('notes are embedded into the vault, re-indexed on edit, and removed on delete', async () => {
  const repository = new ConversationRepository(':memory:');
  const model = repository.getSetting('embeddingModel');
  const ollama = { generateEmbedding: async () => new Array(768).fill(0.02) };
  const worker = new DeepResearchWorker({ repository, ollama });
  const hub = repository.createSpecialistHub({ name: 'Notes Hub' });

  // Create → indexed as retrievable vault knowledge, tagged as a note.
  const note = repository.createNote({ hubId: hub.id, title: 'Key finding', body: 'Consistency matters more than timing for supplementation.' });
  const created = await worker.indexNote({ note, embeddingModel: model });
  assert.equal(created.success, true);
  assert.ok(created.chunksCount >= 1);

  const query = new Array(768).fill(0.02);
  let hits = repository.searchSpecialistVectorMemory(hub.id, query, 8, model);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sourceType, 'note');
  assert.equal(hits[0].sourceUrl, `note://${note.id}`);

  // Edit → old chunks are REPLACED, not appended (no stale knowledge lingering).
  repository.updateNote({ id: note.id, body: 'Revised: five grams daily is sufficient.' });
  await worker.indexNote({ note: repository.getNote(note.id), embeddingModel: model });
  hits = repository.searchSpecialistVectorMemory(hub.id, query, 8, model);
  assert.equal(hits.length, 1, 'editing a note must not duplicate its chunks');
  assert.ok(hits[0].chunkText.includes('five grams daily'));
  assert.ok(!hits[0].chunkText.includes('Consistency matters more'));

  // Delete → removed from the vault so it stops influencing answers.
  assert.equal(repository.deleteNote(note.id), true);
  assert.equal(repository.searchSpecialistVectorMemory(hub.id, query, 8, model).length, 0);
  assert.equal(repository.countNotes(hub.id), 0);

  repository.close();
});

test('specialist hub reports retrievable vs total chunk counts by current embedding model', () => {
  const repository = new ConversationRepository(':memory:');
  const model = repository.getSetting('embeddingModel'); // nomic-embed-text
  const hub = repository.createSpecialistHub({ name: 'Counts' });

  // One chunk from the current model, one from a stale/previous model.
  repository.saveSpecialistChunk({ hubId: hub.id, sourceTitle: 'a', chunkText: 'current', embedding: [1, 2, 3], embeddingModel: model });
  repository.saveSpecialistChunk({ hubId: hub.id, sourceTitle: 'b', chunkText: 'stale', embedding: [1, 2, 3, 4], embeddingModel: 'old-model' });

  const got = repository.getSpecialistHub(hub.id);
  assert.equal(got.chunkCount, 2);
  assert.equal(got.retrievableChunkCount, 1);

  // listSpecialistHubs reports the same split.
  const listed = repository.listSpecialistHubs().find((h) => h.id === hub.id);
  assert.equal(listed.chunkCount, 2);
  assert.equal(listed.retrievableChunkCount, 1);

  repository.close();
});

test('reindexHub re-embeds stale/legacy chunks so they become retrievable', async () => {
  const repository = new ConversationRepository(':memory:');
  const model = repository.getSetting('embeddingModel'); // nomic-embed-text
  const hub = repository.createSpecialistHub({ name: 'Reindex' });

  // A legacy chunk embedded by a different model at a different dimension.
  repository.saveSpecialistChunk({ hubId: hub.id, sourceTitle: 'legacy', chunkText: 'reactor criticality data', embedding: [0.1, 0.2, 0.3, 0.4], embeddingModel: 'old-model' });
  assert.equal(repository.getSpecialistHub(hub.id).retrievableChunkCount, 0);

  // Stub embedder returns the current model's 768-d vectors.
  const ollama = { generateEmbedding: async () => new Array(768).fill(0).map((_, i) => Math.sin(i)) };
  const worker = new DeepResearchWorker({ repository, ollama });

  const result = await worker.reindexHub({ hubId: hub.id, embeddingModel: model });
  assert.equal(result.success, true);
  assert.equal(result.reindexed, 1);
  assert.equal(result.failed, 0);

  // Now retrievable, and actually matchable with a current-model query.
  assert.equal(repository.getSpecialistHub(hub.id).retrievableChunkCount, 1);
  const q = new Array(768).fill(0).map((_, i) => Math.sin(i));
  const hits = repository.searchSpecialistVectorMemory(hub.id, q, 4, model);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sourceTitle, 'legacy');

  // Idempotent: a second re-index has nothing to do.
  const again = await worker.reindexHub({ hubId: hub.id, embeddingModel: model });
  assert.equal(again.reindexed, 0);
  assert.equal(again.total, 0);

  repository.close();
});

test('deriveSearchQueries extracts explicit quoted queries from a long research brief', async () => {
  const worker = new DeepResearchWorker({ repository: {}, ollama: {} });
  const brief = `Target Domain: Software Design Patterns and Clean Code.
Execute deep research for enterprise patterns and refactoring.
Seed queries:
- "site:refactoring.guru software design patterns clean code"
- "TypeScript enterprise architecture patterns and SOLID principles"
- "Node.js asynchronous error handling best practices production"`;

  const queries = await worker.deriveSearchQueries(brief, 'llama3:8b');

  // The four-figure blob must NOT be searched verbatim; the quoted queries are used.
  assert.ok(queries.length >= 2 && queries.length <= 5);
  assert.ok(queries.some((q) => q.includes('refactoring.guru')));
  assert.ok(queries.some((q) => /SOLID principles/i.test(q)));
  assert.ok(queries.every((q) => q.length < 120));
});

test('deriveSearchQueries returns a short simple topic verbatim (no model call)', async () => {
  // ollama has no generateChatSync — proves the short path never invokes the model.
  const worker = new DeepResearchWorker({ repository: {}, ollama: {} });
  const queries = await worker.deriveSearchQueries('photosynthesis basics', 'llama3:8b');
  assert.deepEqual(queries, ['photosynthesis basics']);
});

test('deriveSearchQueries falls back to a heuristic first line when no quotes and no model', async () => {
  const worker = new DeepResearchWorker({ repository: {}, ollama: {} });
  const brief = 'Target Domain: Clean Architecture and decoupled service layers\nMore detail follows on the next lines that should be ignored.';
  const queries = await worker.deriveSearchQueries(brief, null); // no model → heuristic
  assert.equal(queries.length, 1);
  assert.ok(/Clean Architecture/i.test(queries[0]));
  assert.ok(!/Target Domain:/i.test(queries[0])); // label stripped
});

test('runWebDeepResearch reports an honest failure when search finds no sources', async () => {
  const saved = [];
  const repository = { saveSpecialistChunk: (c) => saved.push(c) };
  const ollama = { generateEmbedding: async () => new Array(768).fill(0.01) };
  // Inject a searcher that finds nothing (simulates every provider empty).
  const worker = new DeepResearchWorker({ repository, ollama, search: async () => [] });

  const res = await worker.runWebDeepResearch({ hubId: 'h', topic: 'an extremely obscure topic', embeddingModel: 'nomic-embed-text' });

  assert.equal(res.success, false);
  assert.match(res.reason, /no sources/i);
  assert.equal(res.totalChunks, 0);
  assert.equal(saved.length, 0);
});

test('runWebDeepResearch indexes search snippets so unreachable pages do not zero the run', async () => {
  const saved = [];
  const repository = { saveSpecialistChunk: (c) => saved.push(c) };
  const ollama = { generateEmbedding: async () => new Array(768).fill(0.01) };
  // One result with a usable snippet but a URL that refuses instantly (local, no
  // network): the page scrape fails, yet the snippet still gets indexed.
  const search = async () => [{ title: 'Photosynthesis', url: 'http://127.0.0.1:9/x', snippet: 'Photosynthesis converts light into chemical energy in plants.' }];
  const worker = new DeepResearchWorker({ repository, ollama, search });

  const res = await worker.runWebDeepResearch({ hubId: 'h', topic: 'photosynthesis', embeddingModel: 'nomic-embed-text' });

  assert.equal(res.success, true);
  assert.ok(res.totalChunks >= 1);
  assert.ok(saved.some((c) => /^Snippet:/.test(c.sourceTitle)));
});

test('deepResearch extracts text from a real PDF and indexes it (pdf-parse v2 API)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-pdf-'));
  try {
    const known = 'Sidekick PDF Ingestion Regression Fixture';
    const pdfPath = path.join(dir, 'fixture.pdf');
    fs.writeFileSync(pdfPath, buildPdf(known));

    const saved = [];
    const repository = { saveSpecialistChunk: (c) => saved.push(c) };
    const ollama = { generateEmbedding: async () => new Array(768).fill(0.01) };
    const worker = new DeepResearchWorker({ repository, ollama });

    const result = await worker.ingestFilePath({ hubId: 'h1', filePath: pdfPath, model: 'nomic-embed-text' });

    assert.equal(result.success, true);
    assert.ok(result.chunksCount >= 1);
    assert.ok(saved.map((c) => c.chunkText).join(' ').includes(known));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PDF ingestion records page-level citation provenance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-pdf-'));
  try {
    const pdfPath = path.join(dir, 'provenance.pdf');
    fs.writeFileSync(pdfPath, buildPdf('Clause 7.2 limits liability to fees paid in the prior twelve months.'));

    const saved = [];
    const repository = { saveSpecialistChunk: (c) => saved.push(c) };
    const ollama = { generateEmbedding: async () => new Array(768).fill(0.01) };
    const worker = new DeepResearchWorker({ repository, ollama });

    const result = await worker.ingestFilePath({ hubId: 'h1', filePath: pdfPath, model: 'nomic-embed-text' });
    assert.equal(result.success, true);

    // Every chunk must know which page it came from, so a citation can point there.
    assert.ok(saved.length >= 1);
    assert.equal(saved[0].page, 1);
    assert.equal(saved[0].location, 'p. 1');
    assert.equal(saved[0].sourceType, 'pdf');
    assert.equal(typeof saved[0].charStart, 'number');
    assert.ok(saved[0].chunkText.includes('Clause 7.2'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deepResearch reports a scanned/empty PDF as failure, never silent 0-chunk success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-pdf-'));
  try {
    const pdfPath = path.join(dir, 'scanned.pdf');
    fs.writeFileSync(pdfPath, buildPdf('')); // valid PDF, no extractable text

    const saved = [];
    const repository = { saveSpecialistChunk: (c) => saved.push(c) };
    const ollama = { generateEmbedding: async () => new Array(768).fill(0.01) };
    const worker = new DeepResearchWorker({ repository, ollama });

    const result = await worker.ingestFilePath({ hubId: 'h1', filePath: pdfPath, model: 'nomic-embed-text' });

    assert.equal(result.success, false);
    assert.equal(result.chunksCount, 0);
    assert.match(result.reason, /scanned|image-only|readable/i);
    assert.equal(saved.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
