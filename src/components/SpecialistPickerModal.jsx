import { useEffect, useState } from 'react';

const ICON_MAP = {
  brain: '🧠',
  code: '💻',
  scale: '⚖️',
  chart: '📊',
  book: '📚',
};

export default function SpecialistPickerModal({
  isOpen,
  onClose,
  sidekick,
  activeSpecialistIds = [],
  onSelectSpecialist,
  onOpenCreateModal,
  onOpenEditModal,
  onOpenLibrary,
}) {
  const isSelected = (id) => activeSpecialistIds.includes(id);
  const noneSelected = activeSpecialistIds.length === 0;
  const [hubs, setHubs] = useState([]);
  const [packStatus, setPackStatus] = useState('');

  // Installing a pack creates a new Expert locally. If the pack's vectors came from
  // a different embedding model they cannot be retrieved until re-indexed — say so
  // plainly rather than handing the user a silently dead vault.
  async function handleImportPack() {
    if (!sidekick) return;
    setPackStatus('Installing Expert Pack…');
    try {
      const res = await sidekick.specialist.importPack();
      if (res.cancelled) {
        setPackStatus('');
        return;
      }
      setPackStatus(
        res.retrievable
          ? `✅ Installed "${res.hub.name}" — ${res.chunksImported} chunks, ${res.notesImported} notes.`
          : `⚠️ Installed "${res.hub.name}" (${res.chunksImported} chunks), but it was built with ${res.packEmbeddingModels.join(', ') || 'another model'} and your embedding model is ${res.currentEmbeddingModel}. Open it and choose "Re-index Knowledge Vault" to make it searchable.`,
      );
      await loadHubs();
    } catch (err) {
      setPackStatus(`Error: ${err.message}`);
    }
  }

  async function loadHubs() {
    if (!sidekick) return;
    try {
      const list = await sidekick.specialist.list();
      setHubs(list || []);
    } catch (error) {
      console.warn('Could not load Experts:', error.message);
      setHubs([]);
    }
  }

  useEffect(() => {
    if (isOpen) {
      loadHubs();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  async function handleDeleteHub(e, hubId) {
    e.stopPropagation();
    if (!sidekick) return;
    const accepted = window.confirm('Delete this Specialist Hub and all cached knowledge?');
    if (!accepted) return;

    await sidekick.specialist.delete(hubId);
    if (isSelected(hubId)) {
      onSelectSpecialist(hubId); // toggles it out of the panel
    }
    await loadHubs();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content specialist-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p>Domain Expertise & Specialist Vaults</p>
            <h2>⚡ AI Experts On Hand</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        <p className="modal-description">
          Select one or more AI Specialists to consult. Each selected expert's dedicated vault is
          searched and its domain instructions applied — build a whole panel to consult at once.
          Click to toggle; changes apply immediately.
        </p>

        <div className="specialist-grid">
          <div
            className={`specialist-grid-card ${noneSelected ? 'active' : ''}`}
            onClick={() => onSelectSpecialist(null)}
          >
            <span className="specialist-grid-card__icon">🤖</span>
            <div className="specialist-grid-card__body">
              <strong>General Assistant</strong>
              <small>No experts — default local LLM reasoning</small>
            </div>
            {noneSelected ? <span className="active-pill">ACTIVE</span> : null}
          </div>

          {hubs.map((hub) => (
            <div
              key={hub.id}
              className={`specialist-grid-card ${isSelected(hub.id) ? 'active' : ''}`}
              onClick={() => onSelectSpecialist(hub.id)}
            >
              <span className="specialist-grid-card__icon">{ICON_MAP[hub.icon] || '🧠'}</span>
              <div className="specialist-grid-card__body">
                <strong>{hub.name}</strong>
                <small>
                  {hub.chunkCount || 0} chunks
                  {typeof hub.retrievableChunkCount === 'number' &&
                  hub.retrievableChunkCount < hub.chunkCount
                    ? ` · ⚠️ ${hub.retrievableChunkCount} retrievable`
                    : ''}
                </small>
              </div>
              <div className="specialist-grid-card__actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenEditModal(hub);
                  }}
                  title="Manage Knowledge Vault & Ingestion"
                >
                  ⚙️
                </button>
                <button
                  type="button"
                  className="ghost-button danger"
                  onClick={(e) => handleDeleteHub(e, hub.id)}
                  title="Delete Specialist"
                >
                  ✕
                </button>
              </div>
              {isSelected(hub.id) ? <span className="active-pill">CONSULTING</span> : null}
            </div>
          ))}
        </div>

        {packStatus ? <div className="status-notice-banner">{packStatus}</div> : null}

        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              onClose();
              onOpenCreateModal();
            }}
          >
            + Create New AI Specialist Hub
          </button>
          <button
            type="button"
            className="cta-button"
            onClick={() => {
              onClose();
              onOpenLibrary();
            }}
            title="Browse curated Experts and add them in one click"
          >
            📚 Browse Expert Library
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={handleImportPack}
            title="Install an Expert shared as a pack file"
          >
            📦 Install from file
          </button>
          <button type="button" className="primary-button" onClick={onClose}>
            Done
            {activeSpecialistIds.length > 0 ? ` (${activeSpecialistIds.length} consulting)` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
