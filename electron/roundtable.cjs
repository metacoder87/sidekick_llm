// Expert Roundtable: instead of one blended answer, each consulted Expert speaks in
// its own grounded voice and a moderator consolidates. See ROADMAP Stage 2.5.
//
// v1 scope: N rounds of Expert turns (round 1 = answer the user; rounds 2+ = respond
// to the other Experts) followed by a moderator synthesis. Experts may explicitly
// pass when they have nothing to add; when every Expert passes, the moderator wraps
// up early rather than burning the remaining rounds. The user can abort (stop, keep
// what exists) or request "answer now" (skip to the moderator).

const PASS_TOKEN = 'NO_FURTHER_COMMENT';

// How an Expert is told to behave on its turn. The "only speak if you add something"
// rule is what prevents rounds of "I agree with the previous expert" padding — the
// dominant quality risk in multi-agent deliberation.
function expertTurnInstruction({ round, totalRounds, isFinalRound, hasTranscript }) {
  if (round === 1 && !hasTranscript) {
    return [
      'You are one member of a panel answering the user directly.',
      'Answer in your own voice from your own expertise and vault knowledge.',
      'Cite the sources you were given. Do not speak for the other experts.',
    ].join(' ');
  }

  if (isFinalRound) {
    return [
      'This is the final round. State your closing position concisely.',
      'Note explicitly where you agree or disagree with the other experts and why.',
      `If you have nothing to add beyond what you already said, reply exactly ${PASS_TOKEN}.`,
    ].join(' ');
  }

  return [
    `This is round ${round} of ${totalRounds}. You have read the other experts' contributions.`,
    'Respond to them directly — build on, refine, or dispute their points, and say so plainly.',
    'You may change your position if their evidence warrants it.',
    `Only speak if you genuinely add, dispute, or refine something. Otherwise reply exactly ${PASS_TOKEN}.`,
  ].join(' ');
}

function isPass(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Tolerate a model wrapping the token in punctuation or a short sentence.
  return new RegExp(`^\\W*${PASS_TOKEN}\\W*$`, 'i').test(trimmed) ||
    (trimmed.length < 120 && new RegExp(PASS_TOKEN, 'i').test(trimmed));
}

// Renders the discussion so far for the next speaker.
function formatTranscript(turns) {
  if (turns.length === 0) return '';
  return turns
    .map((t) => `[Round ${t.round} — ${t.expertName}]: ${t.content}`)
    .join('\n\n');
}

class RoundtableOrchestrator {
  constructor({ repository, ollama, buildContext }) {
    this.repository = repository;
    this.ollama = ollama;
    // Injected so per-Expert grounding reuses the normal context pipeline (and so
    // the orchestrator is testable without a real ContextBuilder).
    this.buildContext = buildContext;
  }

  // Runs the discussion. Emits turns via callbacks as they are produced so the user
  // watches the deliberation instead of waiting for a final answer.
  //
  // control: { signal, shouldWrapUp() } — signal aborts entirely; shouldWrapUp lets
  // the user skip remaining rounds and jump to the moderator ("Answer now").
  async run({
    conversationId,
    content,
    hubs,
    rounds = 1,
    model,
    moderatorModel,
    expertModel,
    history = [],
    control = {},
    onTurnStart = () => {},
    onTurnDelta = () => {},
    onTurnComplete = () => {},
  }) {
    const totalRounds = Math.max(1, Math.min(6, Number(rounds) || 1));
    const signal = control.signal;
    const shouldWrapUp = control.shouldWrapUp || (() => false);
    const turns = [];
    let stoppedEarly = null;

    const aborted = () => Boolean(signal && signal.aborted);

    for (let round = 1; round <= totalRounds; round++) {
      if (aborted()) break;
      if (shouldWrapUp()) {
        stoppedEarly = 'user requested the summary';
        break;
      }

      let spokeThisRound = 0;

      for (const hub of hubs) {
        if (aborted()) break;
        if (shouldWrapUp()) {
          stoppedEarly = 'user requested the summary';
          break;
        }

        const isFinalRound = round === totalRounds && totalRounds > 1;
        const instruction = expertTurnInstruction({
          round,
          totalRounds,
          isFinalRound,
          hasTranscript: turns.length > 0,
        });

        // Ground this Expert on its own vault for the original question.
        const context = await this.buildContext({
          hubIds: [hub.id],
          content,
          conversationId,
        });

        const transcript = formatTranscript(turns);
        const others = hubs.filter((h) => h.id !== hub.id).map((h) => h.name);
        const turnPrompt = [
          // State identity explicitly. Without it, an Expert reading a transcript
          // that contains its own name refers to itself in the third person
          // ("in agreement with the Nutrition Expert") — observed in testing.
          `You are the ${hub.name}. Speak as yourself, in the first person.`,
          others.length ? `The other experts at the table are: ${others.join(', ')}.` : '',
          instruction,
          transcript ? `\nDiscussion so far:\n${transcript}` : '',
          `\nThe user asked: ${content}`,
        ]
          .filter(Boolean)
          .join('\n');

        const turnId = `${round}:${hub.id}`;
        onTurnStart({ turnId, round, totalRounds, expertId: hub.id, expertName: hub.name, kind: 'expert' });

        let text = '';
        try {
          text = await this.ollama.generateChat({
            model: expertModel || model,
            messages: [
              { role: 'system', content: context.systemContent },
              ...history,
              { role: 'user', content: turnPrompt },
            ],
            signal,
            onChunk: (_delta, full) => onTurnDelta({ turnId, content: full }),
          });
        } catch (error) {
          if (error && error.name === 'AbortError') break;
          // One Expert failing must not sink the discussion.
          onTurnComplete({
            turnId, round, expertId: hub.id, expertName: hub.name, kind: 'expert',
            content: `(${hub.name} could not respond: ${error.message})`, passed: true, grounding: null,
          });
          continue;
        }

        if (isPass(text)) {
          onTurnComplete({
            turnId, round, expertId: hub.id, expertName: hub.name, kind: 'expert',
            content: `${hub.name} had nothing further to add.`, passed: true, grounding: null,
          });
          continue;
        }

        spokeThisRound += 1;
        const turn = {
          turnId, round, expertId: hub.id, expertName: hub.name, kind: 'expert',
          content: text, passed: false, grounding: context.specialistGrounding || null,
        };
        turns.push(turn);
        onTurnComplete(turn);
      }

      // Every Expert passed — further rounds would only produce more silence.
      if (spokeThisRound === 0 && round < totalRounds) {
        stoppedEarly = 'all experts had nothing further to add';
        break;
      }
    }

    if (aborted()) {
      return { turns, moderator: null, aborted: true, stoppedEarly };
    }

    // Moderator synthesis — the answer the user actually reads.
    const moderator = await this.runModerator({
      conversationId, content, hubs, turns, model: moderatorModel || model,
      signal, onTurnStart, onTurnDelta, stoppedEarly,
    });

    return { turns, moderator, aborted: false, stoppedEarly };
  }

  async runModerator({ content, hubs, turns, model, signal, onTurnStart, onTurnDelta, stoppedEarly }) {
    const turnId = 'moderator';
    onTurnStart({ turnId, kind: 'moderator', expertName: 'Moderator' });

    const transcript = formatTranscript(turns);
    const system = [
      'You are the moderator of a panel of domain experts, reporting to the user.',
      'Consolidate the discussion into one coherent answer.',
      'State plainly: where the experts AGREED, where they DISAGREED and why, the facts with their sources, and the conclusions those facts support.',
      'Preserve source attributions. Do not invent sources, and do not smooth over a disagreement to make the answer tidier — the user needs the real state of the evidence.',
      'Separate what the sources establish from your own inference, and label the inference as such.',
    ].join(' ');

    const panel = hubs.map((h) => h.name).join(', ');
    const user = [
      `The user asked: ${content}`,
      `Panel: ${panel}`,
      stoppedEarly ? `(The discussion ended early — ${stoppedEarly}.)` : '',
      transcript ? `\nDiscussion:\n${transcript}` : '\n(No expert contributed a substantive turn.)',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const text = await this.ollama.generateChat({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        signal,
        onChunk: (_delta, full) => onTurnDelta({ turnId, content: full }),
      });
      return { turnId, kind: 'moderator', expertName: 'Moderator', content: text };
    } catch (error) {
      if (error && error.name === 'AbortError') return null;
      return {
        turnId, kind: 'moderator', expertName: 'Moderator',
        content: `The moderator could not summarize the discussion: ${error.message}`,
      };
    }
  }
}

module.exports = {
  RoundtableOrchestrator,
  expertTurnInstruction,
  formatTranscript,
  isPass,
  PASS_TOKEN,
};
