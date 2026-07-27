import { useState } from 'react';
import { formatTimestamp } from '../lib/format';
import CitationsList from './CitationsList';
import SourceCards from './SourceCards';

function FormattedContent({ text }) {
  if (!text) return null;

  // Split by code blocks ```lang ... ```
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        content: text.slice(lastIndex, match.index),
      });
    }

    parts.push({
      type: 'code',
      language: match[1] || 'code',
      content: match[2],
    });

    lastIndex = codeBlockRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({
      type: 'text',
      content: text.slice(lastIndex),
    });
  }

  return (
    <div className="formatted-content">
      {parts.map((part, idx) => {
        if (part.type === 'code') {
          return <CodeBlock key={idx} language={part.language} code={part.content} />;
        }
        return (
          <p key={idx} className="formatted-paragraph">
            {part.content}
          </p>
        );
      })}
    </div>
  );
}

function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="code-block-container">
      <div className="code-block-header">
        <span className="code-lang-tag">{language}</span>
        <button type="button" className="copy-code-btn" onClick={handleCopy}>
          {copied ? '✓ Copied' : 'Copy Code'}
        </button>
      </div>
      <pre className="code-block-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Turns an answer into durable, retrievable knowledge on one of the consulting
// Experts — the "create notes from what you found" loop.
function SaveAsNote({ message, experts, onSaveNote }) {
  const [target, setTarget] = useState(experts[0]?.id || '');
  const [state, setState] = useState('idle');

  if (experts.length === 0 || !onSaveNote) return null;

  async function save() {
    setState('saving');
    try {
      const result = await onSaveNote({ hubId: target || experts[0].id, content: message.content });
      setState(result && result.indexed === false ? 'partial' : 'saved');
    } catch (_e) {
      setState('error');
    }
  }

  return (
    <div className="save-note-row">
      {experts.length > 1 ? (
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={state === 'saving'}
        >
          {experts.map((expert) => (
            <option key={expert.id} value={expert.id}>
              {expert.name}
            </option>
          ))}
        </select>
      ) : null}
      <button type="button" className="ghost-button" onClick={save} disabled={state === 'saving'}>
        {state === 'saved'
          ? '✓ Saved as note'
          : state === 'partial'
            ? '⚠️ Saved, not indexed'
            : state === 'error'
              ? 'Save failed — retry'
              : state === 'saving'
                ? 'Saving…'
                : `📝 Save as note${experts.length === 1 ? ` to ${experts[0].name}` : ''}`}
      </button>
    </div>
  );
}

// In a roundtable, each message is a turn by a named Expert (or the moderator), so
// the speaker — not "Sidekick" — is what the user needs to see.
function speakerLabel(message) {
  if (message.role === 'user') return 'You';
  if (message.turnKind === 'moderator') return '⚖️ Moderator';
  if (message.expertName) {
    const round = message.round ? ` · round ${message.round}` : '';
    return `⚡ ${message.expertName}${round}`;
  }
  return 'Sidekick';
}

function MessageBubble({ message, experts = [], onSaveNote, onAddExpert }) {
  const isPass = message.turnKind === 'pass';
  return (
    <article
      className={`message ${message.role}${message.turnKind ? ` turn-${message.turnKind}` : ''}`}
    >
      <div className="message__meta">
        <span>{speakerLabel(message)}</span>
        <span>{formatTimestamp(message.createdAt)}</span>
      </div>
      <div className="message__body">
        {message.content ? (
          <FormattedContent text={message.content} />
        ) : message.status === 'streaming' ? (
          <span className="streaming-dots">Thinking...</span>
        ) : (
          ''
        )}
      </div>
      {message.role === 'assistant' && message.citations ? (
        <CitationsList citations={message.citations} />
      ) : null}
      {message.role === 'assistant' && message.specialistGrounding ? (
        <>
          <GroundingBadge grounding={message.specialistGrounding} />
          <SourceCards sources={message.specialistGrounding.sources} />
        </>
      ) : null}
      {message.role === 'assistant' && message.suggestedExperts && onAddExpert ? (
        <div className="expert-suggestions">
          💡 Also relevant:
          {message.suggestedExperts.map((expert) => (
            <button
              key={expert.id}
              type="button"
              className="ghost-button"
              onClick={() => onAddExpert(expert.id)}
              title={`Add ${expert.name} to the consulting panel and ask again`}
            >
              + {expert.name}
            </button>
          ))}
        </div>
      ) : null}
      {message.role === 'assistant' &&
      message.content &&
      message.status !== 'streaming' &&
      !isPass ? (
        <SaveAsNote message={message} experts={experts} onSaveNote={onSaveNote} />
      ) : null}
    </article>
  );
}

function GroundingBadge({ grounding }) {
  // Back-compat: older single-expert shape was { name, grounded, matches }.
  const experts =
    grounding.experts ||
    (grounding.name ? [{ name: grounding.name, matches: grounding.matches }] : []);
  const contributing = experts.filter((e) => (e.matches || 0) > 0);

  if (grounding.grounded) {
    return (
      <div className="grounding-badge grounding-badge--grounded">
        ⚡ Grounded in {grounding.matches} source{grounding.matches === 1 ? '' : 's'} from{' '}
        {contributing.map((e) => e.name).join(', ')}
      </div>
    );
  }

  const names = experts.map((e) => e.name).join(', ');
  return (
    <div className="grounding-badge grounding-badge--ungrounded">
      ⚠️ No matching vault knowledge from {names || 'the selected experts'} for this question — this
      answer is from the model, not cited sources.
    </div>
  );
}

export default function ChatView({
  conversation,
  streamRequestId,
  activeSpecialists = [],
  onExportConversation,
  onSaveNote,
  onAddExpert,
}) {
  if (!conversation) {
    return (
      <section className="chat-view empty">
        <div className="empty-state">
          <p>Start with a local prompt.</p>
          <h2>Chat history is stored on your machine and resumes where you left off.</h2>
        </div>
      </section>
    );
  }

  return (
    <section className="chat-view">
      <header className="chat-view__header">
        <div>
          <p>Conversation</p>
          <h2>{conversation.title}</h2>
        </div>
        <div className="chat-view__header-actions">
          {activeSpecialists.length > 0 ? (
            <span className="specialist-active-badge">
              {activeSpecialists.length === 1
                ? `Consulting: ${activeSpecialists[0].name}`
                : `Consulting ${activeSpecialists.length} experts: ${activeSpecialists.map((h) => h.name).join(', ')}`}
            </span>
          ) : null}
          {streamRequestId ? <span className="streaming-badge">Streaming</span> : null}
          <button
            type="button"
            className="secondary-button"
            onClick={() => onExportConversation(conversation.id)}
          >
            Export chat
          </button>
        </div>
      </header>

      <div className="chat-view__messages">
        {conversation.messages.length === 0 ? (
          <div className="empty-state empty-state--inline">
            <p>Fresh conversation</p>
            <h2>Your first message will name this thread automatically.</h2>
          </div>
        ) : null}
        {conversation.messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            experts={activeSpecialists}
            onSaveNote={onSaveNote}
            onAddExpert={onAddExpert}
          />
        ))}
      </div>
    </section>
  );
}
