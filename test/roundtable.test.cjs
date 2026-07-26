const test = require('node:test');
const assert = require('node:assert/strict');

const { RoundtableOrchestrator, isPass, PASS_TOKEN } = require('../electron/roundtable.cjs');

const HUBS = [
  { id: 'nut', name: 'Nutrition Expert' },
  { id: 'tra', name: 'Training Expert' },
];

// Context stub: pretends each Expert has grounded knowledge.
const buildContext = async ({ hubIds }) => ({
  systemContent: `system for ${hubIds[0]}`,
  specialistGrounding: { grounded: true, matches: 1, sources: [{ id: 1, quote: 'q' }] },
});

// Ollama stub whose reply is decided by a function of the call index.
function stubOllama(replies) {
  const calls = [];
  return {
    calls,
    generateChat: async ({ messages, model }) => {
      const reply = typeof replies === 'function' ? replies(calls.length, messages) : replies[calls.length];
      calls.push({ model, messages });
      return reply ?? 'ok';
    },
  };
}

test('roundtable runs one round per Expert then a moderator synthesis', async () => {
  const ollama = stubOllama((i) => (i < 2 ? `expert answer ${i}` : 'moderator synthesis'));
  const rt = new RoundtableOrchestrator({ repository: {}, ollama, buildContext });

  const started = [];
  const completed = [];
  const result = await rt.run({
    conversationId: 'c1',
    content: 'How do I build muscle?',
    hubs: HUBS,
    rounds: 1,
    model: 'chat',
    onTurnStart: (t) => started.push(t),
    onTurnComplete: (t) => completed.push(t),
  });

  // Two Expert turns, then the moderator.
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].expertName, 'Nutrition Expert');
  assert.equal(result.turns[1].expertName, 'Training Expert');
  assert.ok(result.moderator.content.includes('moderator synthesis'));
  assert.equal(started.length, 3, 'two experts + moderator announce their turns');
  assert.equal(started[2].kind, 'moderator');

  // Each Expert turn carries its own grounding for per-turn citations.
  assert.equal(result.turns[0].grounding.grounded, true);

  // 3 generations total for 2 experts x 1 round + moderator.
  assert.equal(ollama.calls.length, 3);
});

test('roundtable gives each Expert the transcript so far in later rounds', async () => {
  const ollama = stubOllama((i) => (i < 4 ? `point ${i}` : 'summary'));
  const rt = new RoundtableOrchestrator({ repository: {}, ollama, buildContext });

  await rt.run({ conversationId: 'c1', content: 'Q', hubs: HUBS, rounds: 2, model: 'chat' });

  // 2 experts x 2 rounds + moderator = 5 calls.
  assert.equal(ollama.calls.length, 5);

  // The first speaker of round 1 sees no transcript; round 2 speakers do.
  const firstTurnPrompt = ollama.calls[0].messages.at(-1).content;
  assert.ok(!firstTurnPrompt.includes('Discussion so far'));

  const roundTwoPrompt = ollama.calls[2].messages.at(-1).content;
  assert.match(roundTwoPrompt, /Discussion so far/);
  assert.match(roundTwoPrompt, /point 0/, 'sees what the other experts already said');
  assert.match(roundTwoPrompt, /round 2 of 2|final round/i);
});

test('an Expert may pass, and a pass is reported rather than padded', async () => {
  const ollama = stubOllama((i) => (i === 0 ? 'a real point' : i === 1 ? PASS_TOKEN : 'summary'));
  const rt = new RoundtableOrchestrator({ repository: {}, ollama, buildContext });

  const completed = [];
  const result = await rt.run({
    conversationId: 'c1', content: 'Q', hubs: HUBS, rounds: 1, model: 'chat',
    onTurnComplete: (t) => completed.push(t),
  });

  // The passing Expert produces no transcript turn...
  assert.equal(result.turns.length, 1);
  // ...but the user is still told it passed.
  const passNotice = completed.find((t) => t.passed);
  assert.ok(passNotice);
  assert.match(passNotice.content, /nothing further to add/i);
});

test('when every Expert passes, the moderator wraps up early instead of burning rounds', async () => {
  // All Experts pass in round 1; rounds=4 would otherwise mean 8 expert calls.
  const ollama = stubOllama((i) => (i < 2 ? PASS_TOKEN : 'summary'));
  const rt = new RoundtableOrchestrator({ repository: {}, ollama, buildContext });

  const result = await rt.run({ conversationId: 'c1', content: 'Q', hubs: HUBS, rounds: 4, model: 'chat' });

  assert.equal(result.stoppedEarly, 'all experts had nothing further to add');
  // 2 passes + moderator only — rounds 2..4 were skipped.
  assert.equal(ollama.calls.length, 3);
  assert.ok(result.moderator);
});

test('"answer now" skips remaining rounds and goes straight to the moderator', async () => {
  const ollama = stubOllama(() => 'text');
  const rt = new RoundtableOrchestrator({ repository: {}, ollama, buildContext });

  let wrapUp = false;
  const result = await rt.run({
    conversationId: 'c1', content: 'Q', hubs: HUBS, rounds: 4, model: 'chat',
    control: { shouldWrapUp: () => wrapUp },
    // Request the summary once the first Expert has spoken.
    onTurnComplete: () => { wrapUp = true; },
  });

  assert.equal(result.stoppedEarly, 'user requested the summary');
  assert.equal(result.turns.length, 1, 'only the turn already in flight completed');
  assert.ok(result.moderator, 'the moderator still delivers an answer');
});

test('abort stops the discussion and skips the moderator, keeping produced turns', async () => {
  const controller = new AbortController();
  const ollama = stubOllama(() => 'text');
  const rt = new RoundtableOrchestrator({ repository: {}, ollama, buildContext });

  const result = await rt.run({
    conversationId: 'c1', content: 'Q', hubs: HUBS, rounds: 3, model: 'chat',
    control: { signal: controller.signal },
    onTurnComplete: () => controller.abort(),
  });

  assert.equal(result.aborted, true);
  assert.equal(result.moderator, null, 'abort means stop, not summarize');
  assert.equal(result.turns.length, 1, 'work already produced is kept');
});

test('one Expert failing does not sink the discussion', async () => {
  const ollama = {
    generateChat: async ({ messages }) => {
      const prompt = messages.at(-1).content;
      if (prompt.includes('Discussion so far')) return 'summary';
      if (ollama._first) return 'second expert fine';
      ollama._first = true;
      throw new Error('model exploded');
    },
  };
  const rt = new RoundtableOrchestrator({ repository: {}, ollama, buildContext });

  const completed = [];
  const result = await rt.run({
    conversationId: 'c1', content: 'Q', hubs: HUBS, rounds: 1, model: 'chat',
    onTurnComplete: (t) => completed.push(t),
  });

  assert.ok(completed.some((t) => /could not respond/i.test(t.content)));
  assert.ok(result.moderator, 'the panel still produces an answer');
});

test('roundtable routes Expert turns and the moderator to their configured models', async () => {
  const ollama = stubOllama(() => 'text');
  const rt = new RoundtableOrchestrator({ repository: {}, ollama, buildContext });

  await rt.run({
    conversationId: 'c1', content: 'Q', hubs: [HUBS[0]], rounds: 1,
    model: 'fallback', expertModel: 'fast-model', moderatorModel: 'big-model',
  });

  assert.equal(ollama.calls[0].model, 'fast-model', 'expert turns use the expert model');
  assert.equal(ollama.calls[1].model, 'big-model', 'the answer the user reads uses the chat model');
});

test('isPass recognises explicit passes without swallowing real answers', () => {
  assert.equal(isPass(PASS_TOKEN), true);
  assert.equal(isPass(`  ${PASS_TOKEN}.  `), true);
  assert.equal(isPass(''), true);
  assert.equal(isPass('I agree, and would add that protein timing matters less than total intake across the day.'), false);
  // A long answer that merely mentions the token is not a pass.
  const long = `Some experts say ${PASS_TOKEN} is a useful convention, but here is my substantive view: ${'x'.repeat(200)}`;
  assert.equal(isPass(long), false);
});
