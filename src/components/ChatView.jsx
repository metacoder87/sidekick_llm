import { formatTimestamp } from '../lib/format';

function MessageBubble({ message }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message__meta">
        <span>{message.role === 'user' ? 'You' : 'Sidekick'}</span>
        <span>{formatTimestamp(message.createdAt)}</span>
      </div>
      <div className="message__body">{message.content || (message.status === 'streaming' ? '...' : '')}</div>
    </article>
  );
}

export default function ChatView({
  conversation,
  streamRequestId,
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
