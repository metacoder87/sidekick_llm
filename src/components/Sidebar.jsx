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
      <div className="sidebar__header-bar">
        <div className="sidebar__brand">
          <p>Sidekick LLM</p>
        </div>
        <div className="sidebar__top-actions">
          <button
            type="button"
            className="icon-button primary-icon-button"
            onClick={onNewConversation}
            title="Start New Chat"
          >
            ➕
          </button>
          <button
            type="button"
            className={`icon-button ${activeSpecialistHub ? 'active-expert-icon' : ''}`}
            onClick={onOpenSpecialistPicker}
            title={activeSpecialistHub ? `Active Expert: ${activeSpecialistHub.name}` : 'AI Experts on Hand'}
          >
            ⚡
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onOpenSettings}
            title="Settings & Memory Vault"
          >
            ⚙️
          </button>
        </div>
      </div>

      <label className="search-field">
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="🔍 Search history..."
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
        <button type="button" className="ghost-button" onClick={onExportAll} title="Export history to JSON">
          Export History
        </button>
      </div>
    </aside>
  );
}
