import { useState } from 'react';
import WebSearchToggle from './WebSearchToggle';

export default function Composer({
  disabled,
  isStreaming,
  webSearchEnabled,
  onToggleWebSearch,
  onSend,
  onCancel,
  // Roundtable controls — only meaningful when Experts are consulted.
  expertCount = 0,
  panelMode = 'synthesized',
  onPanelModeChange,
  rounds = 1,
  onRoundsChange,
  onAnswerNow,
  isRoundtableRunning = false,
}) {
  const [draft, setDraft] = useState('');

  async function submit() {
    const nextDraft = draft.trim();
    if (!nextDraft || disabled) {
      return;
    }

    // Clear optimistically, but restore the draft if the send fails — losing what
    // the user typed is far worse than a stale textarea.
    setDraft('');
    try {
      await onSend(nextDraft);
    } catch (_error) {
      setDraft(nextDraft);
    }
  }

  const roundtable = panelMode === 'roundtable';

  return (
    <footer className="composer">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={
          roundtable && expertCount > 1
            ? `Ask the table — ${expertCount} Experts will discuss it.`
            : 'Ask your local model something concrete.'
        }
        disabled={disabled}
        rows={4}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />

      <div className="composer__actions">
        <div className="composer__toolbar">
          <WebSearchToggle
            enabled={webSearchEnabled}
            onToggle={onToggleWebSearch}
            disabled={disabled}
          />

          {expertCount > 0 ? (
            <>
              <button
                type="button"
                className={`secondary-button ${roundtable ? 'primary-button' : ''}`}
                onClick={() => onPanelModeChange(roundtable ? 'synthesized' : 'roundtable')}
                title={
                  roundtable
                    ? 'Each Expert speaks in turn, then a moderator consolidates'
                    : 'One blended answer from all consulted Experts'
                }
              >
                {roundtable ? '🗣️ Round Table' : '💬 Synthesized'}
              </button>

              {roundtable ? (
                <label
                  className="rounds-field"
                  title="How many times each Expert speaks before the moderator wraps up"
                >
                  <span>Rounds</span>
                  <select
                    value={String(rounds)}
                    onChange={(event) => onRoundsChange(Number(event.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </>
          ) : null}

          <p>Enter to send. Shift+Enter for a new line.</p>
        </div>
        <div>
          {isRoundtableRunning ? (
            <button
              type="button"
              className="secondary-button"
              onClick={onAnswerNow}
              title="Stop going around the table and have the moderator answer now"
            >
              ⏭️ Answer now
            </button>
          ) : null}
          {isStreaming ? (
            <button type="button" className="secondary-button" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          <button type="button" className="primary-button" onClick={submit} disabled={disabled}>
            Send
          </button>
        </div>
      </div>
    </footer>
  );
}
