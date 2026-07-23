import { useState } from 'react';

import { formatTimestamp } from '../lib/format';

export default function ConversationList({
  conversations,
  activeConversationId,
  onSelect,
  onRename,
  onDelete,
}) {
  const [editingId, setEditingId] = useState(null);
  const [draftTitle, setDraftTitle] = useState('');

  function startRename(conversation) {
    setEditingId(conversation.id);
    setDraftTitle(conversation.title);
  }

  async function submitRename(conversationId) {
    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      setEditingId(null);
      setDraftTitle('');
      return;
    }

    await onRename(conversationId, nextTitle);
    setEditingId(null);
    setDraftTitle('');
  }

  return (
    <div className="conversation-list">
      {conversations.length === 0 ? (
        <div className="conversation-list__empty">
          Conversations you save locally will appear here.
        </div>
      ) : null}

      {conversations.map((conversation) => {
        const isActive = conversation.id === activeConversationId;
        const isEditing = conversation.id === editingId;

        return (
          <article
            key={conversation.id}
            className={`conversation-card ${isActive ? 'active' : ''}`}
            onClick={() => onSelect(conversation.id)}
          >
            <div className="conversation-card__content">
              {isEditing ? (
                <input
                  autoFocus
                  className="conversation-rename-input"
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={() => submitRename(conversation.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      submitRename(conversation.id);
                    }
                    if (event.key === 'Escape') {
                      setEditingId(null);
                      setDraftTitle('');
                    }
                  }}
                />
              ) : (
                <strong className="conversation-title" title={conversation.title}>
                  {conversation.title}
                </strong>
              )}
            </div>

            <div className="conversation-card__hover-meta">
              <span className="conversation-time">
                {formatTimestamp(conversation.lastMessageAt || conversation.updatedAt)}
              </span>
              <div className="conversation-card__actions">
                <button
                  type="button"
                  className="icon-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(conversation);
                  }}
                  title="Edit title"
                  aria-label={`Rename ${conversation.title}`}
                >
                  ✏️
                </button>
                <button
                  type="button"
                  className="icon-action-btn danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(conversation.id);
                  }}
                  title="Delete conversation"
                  aria-label={`Delete ${conversation.title}`}
                >
                  🗑️
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
