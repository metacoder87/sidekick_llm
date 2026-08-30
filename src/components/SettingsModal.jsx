import { useCallback, useEffect, useState } from 'react';
import AuditLogPanel from './AuditLogPanel';
import LegalNotice from './LegalNotice';
import LicenseSettings from './LicenseSettings';

export default function SettingsModal({
  isOpen,
  onClose,
  sidekick,
  models,
  activeModel,
  onModelChange,
  ollamaStatus,
  webSearchEnabled,
  onToggleWebSearch,
  onProfileUpdated,
}) {
  const [activeTab, setActiveTab] = useState('profile');

  // Profile state
  const [name, setName] = useState('User');
  const [role, setRole] = useState('Software Developer');
  const [tone, setTone] = useState('Balanced & Helpful');
  const [stack, setStack] = useState('JavaScript / Node.js');
  const [instructions, setInstructions] = useState(
    'Provide clean code, clear explanations, and best practices.',
  );

  // Memory state
  const [memories, setMemories] = useState([]);
  const [newFact, setNewFact] = useState('');
  const [memoryCategory, setMemoryCategory] = useState('user-defined');
  const [memorySearch, setMemorySearch] = useState('');
  const [editingMemoryId, setEditingMemoryId] = useState(null);
  const [editingMemoryText, setEditingMemoryText] = useState('');

  // Web Search Settings state
  const [searchProvider, setSearchProvider] = useState('duckduckgo');
  const [searxngUrl, setSearxngUrl] = useState('');
  const [tavilyApiKey, setTavilyApiKey] = useState('');
  const [braveApiKey, setBraveApiKey] = useState('');

  // Optional fast model for background/utility work ('' = same as chat model).
  const [backgroundModel, setBackgroundModel] = useState('');

  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  const loadMemories = useCallback(async () => {
    if (!sidekick) return;
    try {
      const list = await sidekick.memory.list();
      setMemories(list || []);
    } catch (error) {
      console.warn('Could not load memories:', error.message);
      setMemories([]);
    }
  }, [sidekick]);

  useEffect(() => {
    if (isOpen && sidekick) {
      // Load Profile
      sidekick.profile
        .get()
        .then((profile) => {
          if (profile) {
            setName(profile.name || 'User');
            setRole(profile.role || 'Software Developer');
            setTone(profile.tone || 'Balanced & Helpful');
            setStack(profile.stack || 'JavaScript / Node.js');
            setInstructions(
              profile.instructions || 'Provide clean code, clear explanations, and best practices.',
            );
          }
        })
        .catch(() => {});

      // Load Settings
      sidekick.settings
        .get()
        .then((allSettings) => {
          if (allSettings) {
            setSearchProvider(allSettings.searchProvider || 'duckduckgo');
            setSearxngUrl(allSettings.searxngUrl || '');
            setTavilyApiKey(allSettings.tavilyApiKey || '');
            setBraveApiKey(allSettings.braveApiKey || '');
            setBackgroundModel(allSettings.backgroundModel || '');
          }
        })
        .catch(() => {});

      // Load Memories
      loadMemories();
    }
  }, [isOpen, sidekick, loadMemories]);

  if (!isOpen) return null;

  async function handleSaveProfile(e) {
    e.preventDefault();
    if (!sidekick) return;
    setSaving(true);
    try {
      const updated = await sidekick.profile.set({
        name,
        role,
        tone,
        stack,
        instructions,
      });
      if (onProfileUpdated) onProfileUpdated(updated);
      setStatusMessage('Profile preferences saved!');
      setTimeout(() => setStatusMessage(''), 3000);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveWebSearch(e) {
    e.preventDefault();
    if (!sidekick) return;
    setSaving(true);
    try {
      await sidekick.settings.set('searchProvider', searchProvider);
      await sidekick.settings.set('searxngUrl', searxngUrl);
      await sidekick.settings.set('tavilyApiKey', tavilyApiKey);
      await sidekick.settings.set('braveApiKey', braveApiKey);
      setStatusMessage('Web search engine preferences saved!');
      setTimeout(() => setStatusMessage(''), 3000);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleAddMemory(e) {
    e.preventDefault();
    if (!newFact.trim() || !sidekick) return;
    await sidekick.memory.add({
      fact: newFact.trim(),
      category: memoryCategory,
    });
    setNewFact('');
    await loadMemories();
  }

  async function handleSaveMemoryEdit() {
    if (!sidekick || !editingMemoryId || !editingMemoryText.trim()) return;
    await sidekick.memory.update({ id: editingMemoryId, fact: editingMemoryText.trim() });
    setEditingMemoryId(null);
    await loadMemories();
  }

  async function handleDeleteMemory(id) {
    if (!sidekick) return;
    await sidekick.memory.delete(id);
    await loadMemories();
  }

  const filteredMemories = memories.filter(
    (m) =>
      m.fact.toLowerCase().includes(memorySearch.toLowerCase()) ||
      m.category.toLowerCase().includes(memorySearch.toLowerCase()),
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content settings-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p>System Preferences & Workspace</p>
            <h2>⚙️ Settings & Memory Vault</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        {statusMessage ? <div className="status-notice-banner">{statusMessage}</div> : null}

        <div className="settings-tabs">
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'profile' ? 'active' : ''}`}
            onClick={() => setActiveTab('profile')}
          >
            👤 User Profile
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'memory' ? 'active' : ''}`}
            onClick={() => setActiveTab('memory')}
          >
            🧠 Memory Vault ({memories.length})
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'model' ? 'active' : ''}`}
            onClick={() => setActiveTab('model')}
          >
            🤖 Local Model & Ollama
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            🌐 Web Search Engine
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'audit' ? 'active' : ''}`}
            onClick={() => setActiveTab('audit')}
          >
            🔒 Security & Audit
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'legal' ? 'active' : ''}`}
            onClick={() => setActiveTab('legal')}
          >
            ⚖️ Legal & Limits
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'license' ? 'active' : ''}`}
            onClick={() => setActiveTab('license')}
          >
            🔑 License & Billing
          </button>
        </div>

        <div className="settings-tab-body">
          {activeTab === 'profile' && (
            <form onSubmit={handleSaveProfile} className="profile-form">
              <div className="form-grid">
                <label className="form-field">
                  <span>Your Name</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </label>
                <label className="form-field">
                  <span>Your Role / Occupation</span>
                  <input
                    type="text"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    required
                  />
                </label>
              </div>

              <div className="form-grid">
                <label className="form-field">
                  <span>Primary Tech Stack</span>
                  <input type="text" value={stack} onChange={(e) => setStack(e.target.value)} />
                </label>
                <label className="form-field">
                  <span>Preferred Response Tone</span>
                  <select value={tone} onChange={(e) => setTone(e.target.value)}>
                    <option value="Balanced & Helpful">Balanced & Helpful</option>
                    <option value="Concise & Direct">Concise & Direct (No fluff)</option>
                    <option value="Academic & In-Depth">Academic & In-Depth</option>
                    <option value="Strict Code & Architecture">Strict Code & Architecture</option>
                  </select>
                </label>
              </div>

              <label className="form-field">
                <span>Global System Instructions & Guidelines</span>
                <textarea
                  rows={4}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </label>

              <div className="modal-actions">
                <button type="submit" className="primary-button" disabled={saving}>
                  {saving ? 'Saving...' : 'Save Profile'}
                </button>
              </div>
            </form>
          )}

          {activeTab === 'memory' && (
            <div className="memory-tab-content">
              <p className="modal-description">
                Facts stored here are automatically injected into model context across all chats to
                personalize responses.
              </p>

              <form onSubmit={handleAddMemory} className="memory-add-form">
                <input
                  type="text"
                  placeholder="Add a fact (e.g. 'I use Windows 11 with PowerShell')"
                  value={newFact}
                  onChange={(e) => setNewFact(e.target.value)}
                />
                <select value={memoryCategory} onChange={(e) => setMemoryCategory(e.target.value)}>
                  <option value="user-defined">User Preference</option>
                  <option value="tech-stack">Tech Stack</option>
                  <option value="hardware">Hardware / OS</option>
                  <option value="project-rule">Project Rule</option>
                </select>
                <button type="submit" className="primary-button" disabled={!newFact.trim()}>
                  Add Fact
                </button>
              </form>

              <div className="memory-search-bar">
                <input
                  type="text"
                  placeholder="Filter memories..."
                  value={memorySearch}
                  onChange={(e) => setMemorySearch(e.target.value)}
                />
              </div>

              <div className="memory-list">
                {filteredMemories.length === 0 ? (
                  <p className="memory-empty">No stored memories match your search.</p>
                ) : (
                  filteredMemories.map((mem) => (
                    <div key={mem.id} className="memory-card">
                      <div className="memory-card__content">
                        {editingMemoryId === mem.id ? (
                          <input
                            type="text"
                            className="memory-edit-input"
                            value={editingMemoryText}
                            autoFocus
                            onChange={(e) => setEditingMemoryText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveMemoryEdit();
                              if (e.key === 'Escape') setEditingMemoryId(null);
                            }}
                          />
                        ) : (
                          <strong>{mem.fact}</strong>
                        )}
                        <span className="memory-category-tag">{mem.category}</span>
                        {mem.reinforcedCount > 1 ? (
                          <span
                            className="memory-category-tag"
                            title="How often you've stated this"
                          >
                            ×{mem.reinforcedCount}
                          </span>
                        ) : null}
                      </div>
                      {editingMemoryId === mem.id ? (
                        <>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={handleSaveMemoryEdit}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setEditingMemoryId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => {
                            setEditingMemoryId(mem.id);
                            setEditingMemoryText(mem.fact);
                          }}
                        >
                          Edit
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost-button danger"
                        onClick={() => handleDeleteMemory(mem.id)}
                      >
                        Delete
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {activeTab === 'model' && (
            <div className="model-tab-content">
              <div className="form-field">
                <span>Ollama Service Connection</span>
                <div className={`status-pill ${ollamaStatus.available ? 'online' : 'offline'}`}>
                  <span className="status-pill__dot" />
                  <div>
                    <strong>{ollamaStatus.available ? 'Ollama Online' : 'Ollama Offline'}</strong>
                    <span>{ollamaStatus.baseUrl}</span>
                  </div>
                </div>
              </div>

              <label className="form-field">
                <span>Active Local Model</span>
                <select value={activeModel} onChange={(e) => onModelChange(e.target.value)}>
                  {models.map((model) => (
                    <option key={model.name} value={model.name}>
                      {model.name} {model.size ? `(${Math.round(model.size / 1e9)}GB)` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label className="form-field">
                <span>Background / Utility Model</span>
                <select
                  value={backgroundModel}
                  onChange={async (e) => {
                    const value = e.target.value;
                    setBackgroundModel(value);
                    if (sidekick) await sidekick.settings.set('backgroundModel', value);
                  }}
                >
                  <option value="">Same as chat model</option>
                  {models.map((model) => (
                    <option key={model.name} value={model.name}>
                      {model.name} {model.size ? `(${Math.round(model.size / 1e9)}GB)` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <p className="modal-description">
                Available models are retrieved directly from your local Ollama instance (`ollama
                list`). The background model handles summaries, fact extraction, and research query
                generation — pick a small, fast model here to keep chat responsive while you
                converse with a larger one.
              </p>
            </div>
          )}

          {activeTab === 'search' && (
            <form onSubmit={handleSaveWebSearch} className="profile-form">
              <div className="form-grid">
                <label className="form-field">
                  <span>Web Search Grounding</span>
                  <button
                    type="button"
                    className={`secondary-button ${webSearchEnabled ? 'primary-button' : ''}`}
                    onClick={() => onToggleWebSearch(!webSearchEnabled)}
                  >
                    Search Grounding: {webSearchEnabled ? 'ENABLED (ON)' : 'DISABLED (OFF)'}
                  </button>
                </label>

                <label className="form-field">
                  <span>Search Provider</span>
                  <select
                    value={searchProvider}
                    onChange={(e) => setSearchProvider(e.target.value)}
                  >
                    <option value="duckduckgo">DuckDuckGo (Free / No Key Needed)</option>
                    <option value="searxng">SearXNG (Self-Hosted Instance)</option>
                    <option value="tavily">Tavily Search API</option>
                    <option value="brave">Brave Search API</option>
                  </select>
                </label>
              </div>

              {searchProvider === 'searxng' && (
                <label className="form-field">
                  <span>SearXNG Server Base URL</span>
                  <input
                    type="url"
                    value={searxngUrl}
                    onChange={(e) => setSearxngUrl(e.target.value)}
                    placeholder="e.g. http://localhost:8080"
                  />
                </label>
              )}

              {searchProvider === 'tavily' && (
                <label className="form-field">
                  <span>Tavily API Key</span>
                  <input
                    type="password"
                    value={tavilyApiKey}
                    onChange={(e) => setTavilyApiKey(e.target.value)}
                    placeholder="tvly-..."
                  />
                </label>
              )}

              {searchProvider === 'brave' && (
                <label className="form-field">
                  <span>Brave Search API Key</span>
                  <input
                    type="password"
                    value={braveApiKey}
                    onChange={(e) => setBraveApiKey(e.target.value)}
                    placeholder="BSA..."
                  />
                </label>
              )}

              <div className="modal-actions">
                <button type="submit" className="primary-button" disabled={saving}>
                  {saving ? 'Saving...' : 'Save Web Search Options'}
                </button>
              </div>
            </form>
          )}

          {activeTab === 'audit' && <AuditLogPanel sidekick={sidekick} />}

          {activeTab === 'legal' && <LegalNotice />}

          {activeTab === 'license' && <LicenseSettings sidekick={sidekick} />}
        </div>
      </div>
    </div>
  );
}
