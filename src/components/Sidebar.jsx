import ConversationList from './ConversationList';

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
  onOpenSettings,
  onOpenSpecialistPicker,
  activeSpecialistHub,
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <div>
          <p>Sidekick LLM</p>
          <h1>Offline Workspace</h1>
        </div>
        <button type="button" className="primary-button" onClick={onNewConversation}>
          + New Chat
        </button>
      </div>

      <div className="sidebar__actions-row">
        <button type="button" className="secondary-button expert-picker-trigger" onClick={onOpenSpecialistPicker}>
          ⚡ Experts {activeSpecialistHub ? `(${activeSpecialistHub.name})` : ''}
        </button>
        <button type="button" className="secondary-button" onClick={onOpenSettings} title="Settings & Memory Vault">
          ⚙️ Settings
        </button>
      </div>

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

      <div className="sidebar__footer-actions">
        <button type="button" className="ghost-button" onClick={onExportAll}>
          Export History
        </button>
      </div>
    </aside>
  );
}
