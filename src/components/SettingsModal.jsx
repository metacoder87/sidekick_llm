import { useCallback, useEffect, useState } from 'react';
import AuditLogPanel from './AuditLogPanel';
import LegalNotice from './LegalNotice';
import LicenseSettings from './LicenseSettings';

// Nomic Embed Text is shipped under different names by the two engines:
// Ollama calls it "nomic-embed-text" (tagged ":latest"), while the built-in
// GGUF catalog calls the same 768-d vector space "nomic-embed-text-v1.5".
// Keep genuinely different embedding models distinct — only alias this family.
const EMBEDDING_MODEL_FAMILIES = [['nomic-embed-text', 'nomic-embed-text-v1.5']];

function embeddingModelNames(model) {
  const raw = String(model || '')
    .trim()
    .replace(/:latest$/, '');
  const names = new Set([raw]);
  for (const family of EMBEDDING_MODEL_FAMILIES) {
    if (family.includes(raw)) family.forEach((name) => names.add(name));
  }
  return names;
}

function sameEmbeddingModel(first, second) {
  const secondNames = embeddingModelNames(second);
  return [...embeddingModelNames(first)].some((name) => secondNames.has(name));
}

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
  onModelsRefresh,
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
  const [embeddingModel, setEmbeddingModel] = useState('nomic-embed-text-v1.5');

  // Engine state (built-in node-llama-cpp vs. Ollama) + GPU offload.
  const [llmProvider, setLlmProvider] = useState('builtin');
  const [useGPU, setUseGPU] = useState('auto');
  const [nGpuLayers, setNGpuLayers] = useState('');
  const [catalog, setCatalog] = useState(null);
  const [galleryPulling, setGalleryPulling] = useState(null);
  const [galleryProgress, setGalleryProgress] = useState(null);
  const [galleryError, setGalleryError] = useState('');

  // Embedding-model availability guard. When the configured embedding model is not
  // installed for the active engine, retrieval cannot work — surface a prominent
  // download CTA and (when it changes) offer to re-index existing vaults.
  const [embeddingModelWarning, setEmbeddingModelWarning] = useState(null);
  const [previousEmbeddingModel, setPreviousEmbeddingModel] = useState('');
  const [reindexAllProgress, setReindexAllProgress] = useState(null);

  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  // Determine whether the configured embedding model is installed for the active
  // engine. Built-in: match against locally-discovered GGUFs. Ollama: match against
  // Ollama's tag list (catalog marks both as .installed).
  const checkEmbeddingModelAvailability = useCallback(
    (cat = catalog) => {
      if (!sidekick || !cat) return;
      const key = embeddingModel || 'nomic-embed-text-v1.5';
      const galleryEntry = (cat.models || []).find(
        (m) => sameEmbeddingModel(m.id || m.name, key) || sameEmbeddingModel(m.name, key),
      );
      const installed = galleryEntry?.installed || false;
      if (!installed) {
        setEmbeddingModelWarning({
          model: key,
          engine: llmProvider,
          reason: `Embedding model "${key}" is not downloaded for the ${llmProvider} engine. Vault search and citations will not work until it is installed.`,
        });
      } else {
        setEmbeddingModelWarning(null);
      }
    },
    [sidekick, catalog, embeddingModel, llmProvider],
  );

  const refreshCatalog = useCallback(async () => {
    if (!sidekick) return null;
    const cat = await sidekick.models.catalog().catch(() => null);
    setCatalog(cat);
    return cat;
  }, [sidekick]);

  // Recompute the warning whenever the gallery or engine changes. This is kept
  // out of refreshCatalog: catalog state used to be a dependency of the loader
  // itself, so every fetch scheduled another fetch and the tab never settled.
  useEffect(() => {
    if (catalog) checkEmbeddingModelAvailability(catalog);
  }, [catalog, checkEmbeddingModelAvailability]);

  useEffect(() => {
    if (!isOpen || !sidekick?.events?.onModelPull) return undefined;
    return sidekick.events.onModelPull((payload) => {
      if (payload?.percent !== null && payload?.percent !== undefined) setGalleryProgress(payload);
      // Re-check availability once a download completes.
      if (payload?.status === 'success' || payload?.status === 'done') {
        refreshCatalog();
      }
    });
  }, [isOpen, sidekick, refreshCatalog]);

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
            const savedEmbedding = allSettings.embeddingModel || 'nomic-embed-text-v1.5';
            setEmbeddingModel(savedEmbedding);
            setPreviousEmbeddingModel(savedEmbedding);
            setLlmProvider(allSettings.llmProvider || 'builtin');
            setUseGPU(allSettings.useGPU || 'auto');
            setNGpuLayers(allSettings.nGpuLayers || '');
          }
        })
        .catch(() => {});

      // Load Memories
      loadMemories();

      // Load the model gallery of the active engine.
      refreshCatalog();
    }
  }, [isOpen, sidekick, loadMemories, refreshCatalog]);

  async function handleSaveEngine(e) {
    e.preventDefault();
    if (!sidekick) return;
    setSaving(true);
    setGalleryError('');
    try {
      await sidekick.settings.set('llmProvider', llmProvider);
      await sidekick.settings.set('useGPU', useGPU);
      await sidekick.settings.set('nGpuLayers', nGpuLayers);
      // The rest of the app lists models from the newly active engine; without
      // this refresh the Active Model dropdown keeps showing the old engine's
      // models after switching to Ollama (or back).
      await onModelsRefresh?.();
      // getActive may fall back to the other engine when this one has no chat
      // model, so align against whatever engine actually ended up active.
      const savedSettings = await sidekick.settings.get().catch(() => null);
      const activeEngine = savedSettings?.llmProvider === 'ollama' ? 'ollama' : 'builtin';
      await alignEngineScopedSettings(activeEngine);
      if (activeEngine !== llmProvider) {
        setLlmProvider(activeEngine);
        setStatusMessage(
          `No usable model on that engine — staying on the ${activeEngine === 'ollama' ? 'Ollama' : 'built-in'} engine.`,
        );
      } else {
        setStatusMessage('Engine settings saved — they apply to the next message.');
      }
      setTimeout(() => setStatusMessage(''), 3000);
      await refreshCatalog();
    } catch (err) {
      setGalleryError(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  // Background and embedding settings are engine-specific. After a switch, keep
  // them pointing at models the newly active engine actually has instead of
  // silently failing on the next summary or retrieval call.
  async function alignEngineScopedSettings(engine) {
    if (!sidekick) return;
    const allModels = await sidekick.models.listAll().catch(() => models);
    const engineModels = (allModels || []).filter(
      (model) => (model.engine || 'builtin') === engine,
    );

    const backgroundAvailable = engineModels.some(
      (model) => model.name === backgroundModel && model.role !== 'embedding',
    );
    if (backgroundModel && !backgroundAvailable) {
      setBackgroundModel('');
      await sidekick.settings.set('backgroundModel', '').catch(() => {});
    }

    const embeddingAvailable = engineModels.some(
      (model) =>
        model.role === 'embedding' &&
        (model.name === embeddingModel || model.name.replace(/:latest$/, '') === embeddingModel),
    );
    if (!embeddingAvailable) {
      // Only auto-switch between names that share one vector space (Nomic's
      // Ollama and GGUF names). A genuinely different embedder must stay an
      // explicit user choice, because changing it requires re-indexing.
      const replacement = engineModels.find(
        (model) => model.role === 'embedding' && sameEmbeddingModel(model.name, embeddingModel),
      );
      if (replacement) {
        setEmbeddingModel(replacement.name);
        setPreviousEmbeddingModel(replacement.name);
        await sidekick.settings.set('embeddingModel', replacement.name).catch(() => {});
      }
    }
  }

  // The model list contains both engines. Selecting a model from the other
  // engine switches the engine as part of the same action, so the dropdown and
  // the provider can never point at different engines.
  async function handleActiveModelChange(modelName, engine) {
    if (!sidekick || !onModelChange) return;
    setGalleryError('');
    try {
      const result = await onModelChange(modelName, engine);
      if (result?.engine && result.engine !== llmProvider) {
        setLlmProvider(result.engine);
        setStatusMessage(
          `Switched to the ${result.engine === 'ollama' ? 'Ollama' : 'built-in'} engine.`,
        );
        setTimeout(() => setStatusMessage(''), 3000);
        await alignEngineScopedSettings(result.engine);
        await refreshCatalog();
      }
    } catch (err) {
      setGalleryError(err.message);
    }
  }

  // Group models by engine so the picker makes it obvious where each model
  // lives. Ollama models stay selectable even while the built-in engine is
  // active — choosing one switches engines.
  function renderModelOptions(filter) {
    const groups = ['builtin', 'ollama']
      .map((engine) => ({
        engine,
        models: models.filter((model) => (model.engine || 'builtin') === engine && filter(model)),
      }))
      .filter((group) => group.models.length > 0);

    if (groups.length === 0) return null;
    return groups.map((group) => (
      <optgroup
        key={group.engine}
        label={group.engine === 'ollama' ? 'Ollama' : 'Built-in engine (GGUF)'}
      >
        {group.models.map((model) => (
          <option
            key={`${group.engine}:${model.name}`}
            value={model.name}
            data-engine={group.engine}
          >
            {model.name} {model.size ? `(${Math.round(model.size / 1e9)}GB)` : ''}
          </option>
        ))}
      </optgroup>
    ));
  }

  async function handleDownloadModel(model) {
    const key = model.id || model.name;
    if (!sidekick) return;
    setGalleryPulling(key);
    setGalleryError('');
    setGalleryProgress(null);
    try {
      const result = await sidekick.models.pull({ name: key });
      if (!result.ok) setGalleryError(result.reason || 'Download failed.');
      await refreshCatalog();
      await onModelsRefresh?.();
    } catch (err) {
      setGalleryError(err.message);
    } finally {
      setGalleryPulling(null);
      setGalleryProgress(null);
    }
  }

  async function handleDeleteModel(model) {
    const key = model.id || model.name;
    if (!sidekick) return;
    setGalleryError('');
    try {
      const result = await sidekick.models.delete({ name: key });
      if (!result.ok) setGalleryError(result.reason || 'Delete failed.');
      await refreshCatalog();
      await onModelsRefresh?.();
    } catch (err) {
      setGalleryError(err.message);
    }
  }

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
            🤖 Model & Engine
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
              {/* Engine selection */}
              <form onSubmit={handleSaveEngine}>
                <div className="form-field">
                  <span>Model Engine</span>
                  <select value={llmProvider} onChange={(e) => setLlmProvider(e.target.value)}>
                    <option value="builtin">
                      Built-in (runs inside Sidekick — no server, no open port)
                    </option>
                    <option value="ollama">Ollama (external, on a local port)</option>
                  </select>
                </div>

                <div
                  className={`status-pill ${ollamaStatus.available ? 'online' : 'offline'}`}
                  title={ollamaStatus.error || ''}
                >
                  <span className="status-pill__dot" />
                  <div>
                    <strong>
                      {ollamaStatus.available
                        ? llmProvider === 'builtin'
                          ? 'Built-in engine ready'
                          : 'Ollama Online'
                        : llmProvider === 'builtin'
                          ? 'No models downloaded yet — see gallery below'
                          : 'Ollama Offline'}
                    </strong>
                    <span>
                      {ollamaStatus.baseUrl || ollamaStatus.error || 'models run locally'}
                    </span>
                  </div>
                </div>

                <div className="form-grid">
                  <label className="form-field">
                    <span>GPU (built-in engine)</span>
                    <select value={useGPU} onChange={(e) => setUseGPU(e.target.value)}>
                      <option value="auto">Auto — use as much VRAM as fits</option>
                      <option value="true">Always on (full offload)</option>
                      <option value="false">Off (CPU only)</option>
                    </select>
                  </label>
                  <label className="form-field">
                    <span>GPU Layers (override, blank = auto)</span>
                    <input
                      type="number"
                      min={-1}
                      placeholder="auto"
                      value={nGpuLayers}
                      onChange={(e) => setNGpuLayers(e.target.value)}
                    />
                  </label>
                </div>

                <div className="modal-actions">
                  <button type="submit" className="secondary-button" disabled={saving}>
                    {saving ? 'Saving…' : 'Save Engine Settings'}
                  </button>
                </div>
              </form>

              {/* Active models */}
              <div className="form-field">
                <span>Active Local Model</span>
                <div className="model-select-wrapper">
                  <select
                    value={activeModel}
                    onChange={(e) =>
                      handleActiveModelChange(
                        e.target.value,
                        e.target.selectedOptions[0]?.dataset?.engine,
                      )
                    }
                  >
                    {models.filter((model) => model.role !== 'embedding').length === 0 ? (
                      <option value="">No local models yet — download one below</option>
                    ) : (
                      renderModelOptions((model) => model.role !== 'embedding')
                    )}
                  </select>
                  {activeModel && (
                    <button
                      type="button"
                      className="secondary-button danger model-delete-button"
                      onClick={() => {
                        if (!sidekick) return;
                        sidekick.models.delete({ name: activeModel }).catch((err) => {
                          setStatusMessage(`Error deleting model: ${err.message}`);
                        });
                      }}
                    >
                      🗑️ Delete
                    </button>
                  )}
                </div>
              </div>

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
                  {models
                    .filter(
                      (model) =>
                        model.role !== 'embedding' && (model.engine || 'builtin') === llmProvider,
                    )
                    .map((model) => (
                      <option key={model.name} value={model.name}>
                        {model.name} {model.size ? `(${Math.round(model.size / 1e9)}GB)` : ''}
                      </option>
                    ))}
                </select>
              </label>

              <label className="form-field">
                <span>Embedding Model</span>
                <select
                  value={embeddingModel}
                  onChange={async (e) => {
                    const value = e.target.value;
                    setEmbeddingModel(value);
                    if (sidekick) {
                      await sidekick.settings.set('embeddingModel', value);
                      // When the embedding model changes, existing vault chunks were
                      // embedded with a different vector space and must be re-indexed.
                      // Aliases of the same model (nomic-embed-text vs.
                      // nomic-embed-text-v1.5) share a vector space and need no reindex.
                      if (value && !sameEmbeddingModel(value, previousEmbeddingModel)) {
                        setPreviousEmbeddingModel(value);
                        setEmbeddingModelWarning({
                          model: value,
                          engine: llmProvider,
                          reason: `Embedding model changed to "${value}". Existing vaults were embedded with "${previousEmbeddingModel}" and are not retrievable until re-indexed.`,
                        });
                      } else {
                        await checkEmbeddingModelAvailability();
                      }
                    }
                  }}
                >
                  {models.filter(
                    (model) =>
                      model.role === 'embedding' && (model.engine || 'builtin') === llmProvider,
                  ).length === 0 ? (
                    <option value="">Download an embedding model from the gallery</option>
                  ) : (
                    models
                      .filter(
                        (model) =>
                          model.role === 'embedding' && (model.engine || 'builtin') === llmProvider,
                      )
                      .map((model) => (
                        <option key={model.name} value={model.name}>
                          {model.name} {model.size ? `(${Math.round(model.size / 1e9)}GB)` : ''}
                        </option>
                      ))
                  )}
                  {embeddingModel &&
                  !models.some(
                    (model) =>
                      model.role === 'embedding' &&
                      (model.engine || 'builtin') === llmProvider &&
                      sameEmbeddingModel(model.name, embeddingModel),
                  ) ? (
                    <option value={embeddingModel}>
                      {embeddingModel} (not installed for this engine)
                    </option>
                  ) : null}
                </select>
                <small>
                  Changing this requires re-indexing Experts, notes, and memory before retrieval
                  uses new vectors.
                </small>
                {embeddingModelWarning && embeddingModelWarning.model === embeddingModel ? (
                  <div className="vault-warning">
                    <p>{embeddingModelWarning.reason}</p>
                    {embeddingModelWarning.engine === 'builtin' && (
                      <>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => {
                            const entry = (catalog?.models || []).find((m) =>
                              sameEmbeddingModel(m.id || m.name, embeddingModel),
                            );
                            if (entry) handleDownloadModel(entry);
                          }}
                          disabled={Boolean(galleryPulling)}
                        >
                          {galleryPulling === embeddingModel
                            ? 'Downloading…'
                            : 'Download Embedding Model'}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={async () => {
                            setReindexAllProgress({ status: 'running' });
                            try {
                              const result = await sidekick.specialist.reindexAll();
                              setReindexAllProgress({
                                status: result.success ? 'done' : 'error',
                                totalReindexed: result.totalReindexed,
                                totalFailed: result.totalFailed,
                                hubs: result.hubs,
                                failures: result.failures,
                              });
                              if (result.success) {
                                await checkEmbeddingModelAvailability();
                              }
                            } catch (err) {
                              setReindexAllProgress({
                                status: 'error',
                                reason: err.message,
                              });
                            }
                          }}
                          disabled={Boolean(reindexAllProgress)}
                        >
                          {reindexAllProgress
                            ? 'Re-indexing All Experts…'
                            : 'Re-index All Expert Vaults'}
                        </button>
                        {reindexAllProgress && reindexAllProgress.status === 'done' && (
                          <p className="modal-description">
                            ✅ Re-indexed {reindexAllProgress.totalReindexed} chunks across{' '}
                            {reindexAllProgress.hubs} Expert(s).
                          </p>
                        )}
                        {reindexAllProgress && reindexAllProgress.status === 'error' && (
                          <p className="modal-description" style={{ color: '#ef4444' }}>
                            ⚠️ Re-index failed:{' '}
                            {reindexAllProgress.reason ||
                              `re-indexed ${reindexAllProgress.totalReindexed}, ${reindexAllProgress.totalFailed} failed`}
                          </p>
                        )}
                        {reindexAllProgress &&
                          reindexAllProgress.failures &&
                          reindexAllProgress.failures.length > 0 && (
                            <p
                              className="modal-description"
                              style={{ color: '#ef4444', fontSize: '0.76rem' }}
                            >
                              Failed:{' '}
                              {reindexAllProgress.failures
                                .map((f) => `${f.hubName}: ${f.reason}`)
                                .join('; ')}
                            </p>
                          )}
                      </>
                    )}
                  </div>
                ) : null}
              </label>

              {/* Model gallery */}
              <div className="form-field">
                <span>Model Gallery</span>
                {catalog?.hardware ? (
                  <p className="modal-description">
                    This machine: {catalog.hardware.totalRamGB} GB RAM, {catalog.hardware.cpuCount}{' '}
                    cores.
                  </p>
                ) : null}
                {galleryError ? <div className="lock-error">{galleryError}</div> : null}

                {models.some((model) => model.engine === 'ollama') && llmProvider !== 'ollama' ? (
                  <p className="modal-description">
                    Ollama also has {models.filter((model) => model.engine === 'ollama').length}{' '}
                    downloaded model(s). They appear in the Active Local Model list above — choosing
                    one switches Sidekick to the Ollama engine.
                  </p>
                ) : null}

                {(catalog?.models || []).map((model) => {
                  const key = model.id || model.name;
                  return (
                    <div
                      key={key}
                      className={`onboarding__model ${model.installed ? 'is-installed' : ''} ${!model.fits ? 'is-tight' : ''}`}
                    >
                      <div className="onboarding__model-main">
                        <div className="onboarding__model-title">
                          <strong>{key}</strong>
                          <span className="library-card__cat">{model.label}</span>
                          {model.recommended && !model.installed ? (
                            <span className="active-pill">RECOMMENDED</span>
                          ) : null}
                          {model.installed ? <span className="active-pill">INSTALLED</span> : null}
                        </div>
                        <p>{model.description}</p>
                        {!model.fits ? (
                          <p className="onboarding__warn">
                            Needs about {model.minRamGB} GB RAM — likely too slow on this machine.
                          </p>
                        ) : null}
                      </div>
                      <div className="onboarding__model-side">
                        <span className="onboarding__size">{model.sizeGB} GB</span>
                        <div className="onboarding__model-actions">
                          {!model.installed ? (
                            <button
                              type="button"
                              className={
                                model.required || model.recommended
                                  ? 'primary-button'
                                  : 'secondary-button'
                              }
                              disabled={Boolean(galleryPulling)}
                              onClick={() => handleDownloadModel(model)}
                            >
                              {galleryPulling === key ? 'Downloading…' : 'Download'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="secondary-button danger"
                              disabled={Boolean(galleryPulling)}
                              onClick={() => handleDeleteModel(model)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {galleryPulling && galleryProgress ? (
                  <div className="onboarding__progress">
                    <div className="onboarding__progress-label">
                      {galleryPulling}: {galleryProgress.status}
                      {galleryProgress.percent !== null && galleryProgress.percent !== undefined
                        ? ` — ${galleryProgress.percent}%`
                        : ''}
                    </div>
                    <div className="onboarding__bar">
                      <div style={{ width: `${galleryProgress.percent ?? 0}%` }} />
                    </div>
                  </div>
                ) : null}
              </div>

              <p className="modal-description">
                Built-in engine: models are GGUF files downloaded from HuggingFace into the app's
                models folder — afterwards Sidekick runs them itself, with zero external services
                and no open port. GPU offload is chosen automatically from available VRAM (or
                overridden above). Ollama: models come from your local Ollama install instead. The
                background model handles summaries, fact extraction, and research query generation —
                pick a small, fast model to keep chat responsive.
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
