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
  onImportAll,
  onOpenSettings,
  onOpenSpecialistPicker,
  activeSpecialistHubs = [],
}) {
  const panelCount = activeSpecialistHubs.length;
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
            className={`icon-button ${panelCount > 0 ? 'active-expert-icon' : ''}`}
            onClick={onOpenSpecialistPicker}
            title={
              panelCount > 0
                ? `Consulting ${panelCount} expert${panelCount === 1 ? '' : 's'}: ${activeSpecialistHubs.map((h) => h.name).join(', ')}`
                : 'AI Experts on Hand'
            }
          >
            ⚡{panelCount > 0 ? <span className="icon-badge">{panelCount}</span> : null}
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
        <button
          type="button"
          className="ghost-button"
          onClick={onExportAll}
          title="Back up your full corpus — conversations, memory, and Experts — to a JSON file"
        >
          Export Corpus
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={onImportAll}
          title="Restore a previously exported corpus (merges without overwriting)"
        >
          Import Corpus
        </button>
      </div>
    </aside>
  );
}
