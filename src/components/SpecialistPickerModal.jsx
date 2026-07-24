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
}) {
  const isSelected = (id) => activeSpecialistIds.includes(id);
  const noneSelected = activeSpecialistIds.length === 0;
  const [hubs, setHubs] = useState([]);

  async function loadHubs() {
    if (!sidekick) return;
    try {
      const list = await sidekick.specialist.list();
      setHubs(list || []);
    } catch (_e) {}
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
          Select one or more AI Specialists to consult. Each selected expert's dedicated vault is searched and its domain instructions applied — build a whole panel to consult at once. Click to toggle; changes apply immediately.
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
                  {typeof hub.retrievableChunkCount === 'number' && hub.retrievableChunkCount < hub.chunkCount
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
          <button type="button" className="primary-button" onClick={onClose}>
            Done{activeSpecialistIds.length > 0 ? ` (${activeSpecialistIds.length} consulting)` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
