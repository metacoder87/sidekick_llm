import { useState } from 'react';
import { formatTimestamp } from '../lib/format';
import CitationsList from './CitationsList';

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
        return <p key={idx} className="formatted-paragraph">{part.content}</p>;
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

function MessageBubble({ message }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message__meta">
        <span>{message.role === 'user' ? 'You' : 'Sidekick'}</span>
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
    </article>
  );
}

export default function ChatView({
  conversation,
  streamRequestId,
  activeSpecialist,
  onExportConversation,
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
          {activeSpecialist ? (
            <span className="specialist-active-badge">
              Active Expert: {activeSpecialist.name}
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
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>
    </section>
  );
}
