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
  activeSpecialistId,
  onSelectSpecialist,
  onOpenCreateModal,
  onOpenEditModal,
}) {
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
    if (activeSpecialistId === hubId) {
      onSelectSpecialist(null);
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
          Select an active AI Specialist to restrict context search to its dedicated vector vault and apply domain expert instructions.
        </p>

        <div className="specialist-grid">
          <div
            className={`specialist-grid-card ${!activeSpecialistId ? 'active' : ''}`}
            onClick={() => {
              onSelectSpecialist(null);
              onClose();
            }}
          >
            <span className="specialist-grid-card__icon">🤖</span>
            <div className="specialist-grid-card__body">
              <strong>General Assistant</strong>
              <small>Default local LLM reasoning</small>
            </div>
            {!activeSpecialistId ? <span className="active-pill">ACTIVE</span> : null}
          </div>

          {hubs.map((hub) => (
            <div
              key={hub.id}
              className={`specialist-grid-card ${activeSpecialistId === hub.id ? 'active' : ''}`}
              onClick={() => {
                onSelectSpecialist(hub.id);
                onClose();
              }}
            >
              <span className="specialist-grid-card__icon">{ICON_MAP[hub.icon] || '🧠'}</span>
              <div className="specialist-grid-card__body">
                <strong>{hub.name}</strong>
                <small>{hub.chunkCount || 0} vector chunks</small>
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
              {activeSpecialistId === hub.id ? <span className="active-pill">ACTIVE</span> : null}
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              onClose();
              onOpenCreateModal();
            }}
          >
            + Create New AI Specialist Hub
          </button>
        </div>
      </div>
    </div>
  );
}
