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
          >
            <button
              type="button"
              className="conversation-card__body"
              onClick={() => onSelect(conversation.id)}
            >
              {isEditing ? (
                <input
                  autoFocus
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
                <strong>{conversation.title}</strong>
              )}
              <span>{conversation.snippet || formatTimestamp(conversation.lastMessageAt || conversation.updatedAt)}</span>
            </button>

            <div className="conversation-card__actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => startRename(conversation)}
                aria-label={`Rename ${conversation.title}`}
              >
                Rename
              </button>
              <button
                type="button"
                className="ghost-button danger"
                onClick={() => onDelete(conversation.id)}
                aria-label={`Delete ${conversation.title}`}
              >
                Delete
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
