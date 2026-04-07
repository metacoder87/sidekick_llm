import ConversationList from './ConversationList';
import ModelSelect from './ModelSelect';
import StatusPill from './StatusPill';

export default function Sidebar({
  conversations,
  activeConversationId,
  searchQuery,
  onSearchQueryChange,
  onNewConversation,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  onExportAll,
  models,
  activeModel,
  onModelChange,
  ollamaStatus,
  disableModelSelection,
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <div>
          <p>Sidekick</p>
          <h1>Local reasoning, saved cleanly.</h1>
        </div>
        <button type="button" className="primary-button" onClick={onNewConversation}>
          New chat
        </button>
      </div>

      <StatusPill status={ollamaStatus} />

      <ModelSelect
        models={models}
        activeModel={activeModel}
        onChange={onModelChange}
        disabled={disableModelSelection}
      />

      <label className="search-field">
        <span>Search history</span>
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="Find by title or message"
        />
      </label>

      <ConversationList
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelect={onSelectConversation}
        onRename={onRenameConversation}
        onDelete={onDeleteConversation}
      />

      <button type="button" className="secondary-button" onClick={onExportAll}>
        Export all history
      </button>
    </aside>
  );
}
