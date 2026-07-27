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
function expertTurnInstruction({ round, totalRounds, isFinalRound }) {
  // Round 1 is INDEPENDENT: an Expert must not see the others' opening answers.
  // Showing them anchors every later speaker on the first one, and by round 2 the
  // whole panel is restating a single view — observed with 5 Experts x 4 rounds.
  if (round === 1) {
    return [
      'You are one member of a panel. You have NOT yet heard the other experts.',
      'Answer the user directly and independently, from your own expertise and vault knowledge.',
      'Do not speculate about what the others will say, and do not hedge toward a consensus.',
      'Cite the sources you were given.',
    ].join(' ');
  }

  const antiRestate = [
    'Do NOT restate, summarise or re-endorse points already made — the user has already read them, and repetition wastes their time.',
    'Agreement alone is not a contribution.',
    `If you have nothing to add beyond what has already been said, reply with exactly ${PASS_TOKEN} and nothing else. Passing is a respected, useful answer.`,
  ].join(' ');

  if (isFinalRound) {
    return [
      'This is the final round. Give only your CLOSING POSITION, in at most three sentences.',
      'If you disagree with another expert, name them and state the substantive reason.',
      'If your view changed during the discussion, say what changed it.',
      antiRestate,
    ].join(' ');
  }

  return [
    `This is round ${round} of ${totalRounds}. You have now read the other experts.`,
    'Add only what is NEW: a point nobody raised, a correction, a caveat they missed, evidence that cuts against them, or a specific disagreement.',
    'Challenge weak reasoning directly, by name. Independent thinking is what the user is paying for.',
    'You may change your position if their evidence warrants it — say so explicitly if you do.',
    antiRestate,
  ].join(' ');
}

// Token-set overlap on content words. Used to catch a turn that merely restates
// what has already been said, which instructions alone do not reliably prevent on
// smaller local models.
function textSimilarity(a, b) {
  const tokens = (text) =>
    new Set(
      (text || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 3),
    );

  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / new Set([...left, ...right]).size;
}

// Is this turn effectively a repeat of something already said?
//
// Deliberately NOT applied in round 1: two experts independently reaching the same
// conclusion is real information (consensus), and suppressing it would hide a
// genuine signal. From round 2 onward, restating is noise.
function isRedundant(text, priorTurns, threshold = 0.5) {
  return (priorTurns || []).some((turn) => textSimilarity(text, turn.content) >= threshold);
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
        });

        // Ground this Expert on its own vault for the original question.
        const context = await this.buildContext({
          hubIds: [hub.id],
          content,
          conversationId,
        });

        // Round 1 speakers get NO transcript — see expertTurnInstruction. This is
        // what keeps five Experts from collapsing onto the first one's answer.
        const transcript = round === 1 ? '' : formatTranscript(turns);
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

        // An explicit pass, or a turn that merely restates what has already been
        // said, both become a visible pass. The redundancy check is the enforcement
        // behind the "do not restate" instruction, which smaller models ignore.
        const redundant = round > 1 && isRedundant(text, turns);
        if (isPass(text) || redundant) {
          onTurnComplete({
            turnId, round, expertId: hub.id, expertName: hub.name, kind: 'expert',
            content: redundant
              ? `${hub.name} had nothing to add beyond what was already said.`
              : `${hub.name} had nothing further to add.`,
            passed: true, grounding: null,
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
  isRedundant,
  textSimilarity,
  PASS_TOKEN,
};
