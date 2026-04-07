import { useState } from 'react';

export default function Composer({
  disabled,
  isStreaming,
  onSend,
  onCancel,
}) {
  const [draft, setDraft] = useState('');

  async function submit() {
    const nextDraft = draft.trim();
    if (!nextDraft || disabled) {
      return;
    }

    setDraft('');
    await onSend(nextDraft);
  }

  return (
    <footer className="composer">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Ask your local model something concrete."
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
        <p>Enter to send. Shift+Enter for a new line.</p>
        <div>
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
