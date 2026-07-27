const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ConversationRepository,
  isDatabaseEncrypted,
  canOpenWithPassphrase,
  rekeyDatabase,
} = require('../electron/repository.cjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sk-enc-'));
}

// Windows can hold a brief lock on just-closed SQLite files.
function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (_error) {
    /* the OS will clean it up */
  }
}

// Builds a corpus with a distinctive marker we can grep for in the raw file.
function seedCorpus(dbPath, marker) {
  const repo = new ConversationRepository(dbPath);
  const conversation = repo.createConversation('Sensitive matter');
  repo.addMessage({ conversationId: conversation.id, role: 'user', content: marker });
  const hub = repo.createSpecialistHub({ name: 'Medical Expert' });
  repo.saveSpecialistChunk({
    hubId: hub.id,
    sourceTitle: 'records.pdf',
    chunkText: `${marker} appears in the vault too`,
    embedding: [0.1, 0.2, 0.3],
    embeddingModel: repo.getSetting('embeddingModel'),
    page: 4,
    location: 'p. 4',
  });
  repo.addUserMemory({ fact: `${marker} is a stored fact`, category: 'personal' });
  repo.close();
  return { conversationId: conversation.id, hubId: hub.id };
}

function fileContains(filePath, needle) {
  return fs.readFileSync(filePath).toString('latin1').includes(needle);
}

test('encrypting removes plaintext from disk and the corpus still opens with the passphrase', () => {
  const dir = tmpdir();
  try {
    const dbPath = path.join(dir, 'sidekick.db');
    const MARKER = 'PATIENT-RECORD-XYZ-9931';
    const { conversationId, hubId } = seedCorpus(dbPath, MARKER);

    // Baseline: an unencrypted corpus leaks its contents to anyone with the file.
    assert.equal(fileContains(dbPath, MARKER), true);
    assert.equal(isDatabaseEncrypted(dbPath), false);

    const result = rekeyDatabase({ filename: dbPath, newPassphrase: 'correct horse battery', backupTag: 'test' });
    assert.equal(result.encrypted, true);
    assert.ok(fs.existsSync(result.backupPath), 'a backup must be taken before rewriting the corpus');

    // The marker is gone from the raw file, and the header no longer says SQLite.
    assert.equal(fileContains(dbPath, MARKER), false, 'plaintext must not survive on disk');
    assert.equal(isDatabaseEncrypted(dbPath), true);

    // Everything still works with the passphrase — including vault retrieval.
    const repo = new ConversationRepository(dbPath, { passphrase: 'correct horse battery' });
    assert.equal(repo.integrity.ok, true);
    assert.equal(repo.getConversation(conversationId).messages[0].content, MARKER);
    assert.equal(repo.listUserMemories()[0].fact, `${MARKER} is a stored fact`);
    const hits = repo.searchSpecialistVectorMemory(hubId, [0.1, 0.2, 0.3], 4, repo.getSetting('embeddingModel'));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].page, 4, 'citation provenance survives encryption');

    // Writes work while encrypted, and stay encrypted.
    repo.addMessage({ conversationId, role: 'assistant', content: 'reply while encrypted' });
    repo.close();
    assert.equal(fileContains(dbPath, 'reply while encrypted'), false);
    assert.equal(isDatabaseEncrypted(dbPath), true);
  } finally {
    rmDir(dir);
  }
});

test('an encrypted corpus cannot be opened without the passphrase, or with the wrong one', () => {
  const dir = tmpdir();
  try {
    const dbPath = path.join(dir, 'sidekick.db');
    seedCorpus(dbPath, 'TOP-SECRET-4471');
    rekeyDatabase({ filename: dbPath, newPassphrase: 'right-key', backupTag: 'test' });

    assert.equal(canOpenWithPassphrase(dbPath, 'right-key'), true);
    assert.equal(canOpenWithPassphrase(dbPath, 'wrong-key'), false);
    assert.equal(canOpenWithPassphrase(dbPath, ''), false);

    // Constructing the repository without the key must fail rather than silently
    // producing an empty corpus.
    assert.throws(() => new ConversationRepository(dbPath), /not a database|encrypted|file is not/i);
  } finally {
    rmDir(dir);
  }
});

test('encryption is reversible — decrypting restores a working plaintext corpus', () => {
  const dir = tmpdir();
  try {
    const dbPath = path.join(dir, 'sidekick.db');
    const MARKER = 'REVERSIBLE-TEST-8080';
    const { conversationId } = seedCorpus(dbPath, MARKER);

    rekeyDatabase({ filename: dbPath, newPassphrase: 'pass1', backupTag: 'test' });
    assert.equal(isDatabaseEncrypted(dbPath), true);

    // Decrypt: rekey to an empty passphrase.
    rekeyDatabase({ filename: dbPath, currentPassphrase: 'pass1', newPassphrase: '', backupTag: 'test' });
    assert.equal(isDatabaseEncrypted(dbPath), false);

    const repo = new ConversationRepository(dbPath);
    assert.equal(repo.getConversation(conversationId).messages[0].content, MARKER);
    repo.close();
  } finally {
    rmDir(dir);
  }
});

test('the passphrase can be changed, and the old one stops working', () => {
  const dir = tmpdir();
  try {
    const dbPath = path.join(dir, 'sidekick.db');
    const { conversationId } = seedCorpus(dbPath, 'ROTATE-ME-1234');

    rekeyDatabase({ filename: dbPath, newPassphrase: 'first-pass', backupTag: 'test' });
    rekeyDatabase({ filename: dbPath, currentPassphrase: 'first-pass', newPassphrase: 'second-pass', backupTag: 'test' });

    assert.equal(canOpenWithPassphrase(dbPath, 'second-pass'), true);
    assert.equal(canOpenWithPassphrase(dbPath, 'first-pass'), false);

    const repo = new ConversationRepository(dbPath, { passphrase: 'second-pass' });
    assert.equal(repo.getConversation(conversationId).messages.length, 1);
    repo.close();
  } finally {
    rmDir(dir);
  }
});

test('rekey refuses to run with a wrong or missing current passphrase', () => {
  const dir = tmpdir();
  try {
    const dbPath = path.join(dir, 'sidekick.db');
    seedCorpus(dbPath, 'GUARD-TEST');
    rekeyDatabase({ filename: dbPath, newPassphrase: 'the-key', backupTag: 'test' });

    assert.throws(
      () => rekeyDatabase({ filename: dbPath, currentPassphrase: 'nope', newPassphrase: 'x', backupTag: 'test' }),
      /incorrect/i,
    );
    assert.throws(
      () => rekeyDatabase({ filename: dbPath, newPassphrase: 'x', backupTag: 'test' }),
      /passphrase is required/i,
    );

    // The corpus is still intact and still opens with the original passphrase.
    assert.equal(canOpenWithPassphrase(dbPath, 'the-key'), true);
  } finally {
    rmDir(dir);
  }
});

test('isDatabaseEncrypted handles missing, empty and in-memory databases', () => {
  const dir = tmpdir();
  try {
    assert.equal(isDatabaseEncrypted(path.join(dir, 'does-not-exist.db')), false);
    assert.equal(isDatabaseEncrypted(':memory:'), false);
    assert.equal(isDatabaseEncrypted(null), false);

    const empty = path.join(dir, 'empty.db');
    fs.writeFileSync(empty, '');
    assert.equal(isDatabaseEncrypted(empty), false, 'a 0-byte file is a fresh DB, not an encrypted one');
  } finally {
    rmDir(dir);
  }
});
