import { useCallback, useEffect, useState } from 'react';

const ICON_MAP = {
  brain: '🧠',
  code: '💻',
  scale: '⚖️',
  chart: '📊',
  book: '📚',
};

export default function SpecialistGallery({
  sidekick,
  activeSpecialistId,
  onSelectSpecialist,
  onOpenCreateModal,
  onOpenEditModal,
}) {
  const [hubs, setHubs] = useState([]);

  const loadHubs = useCallback(async () => {
    if (!sidekick) return;
    try {
      const list = await sidekick.specialist.list();
      setHubs(list || []);
    } catch (_e) {
      // Ignore
    }
  }, [sidekick]);

  useEffect(() => {
    loadHubs();
  }, [loadHubs]);

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
    <div className="specialist-gallery">
      <div className="specialist-gallery__header">
        <div>
          <span>AI Experts On Hand</span>
          <strong>Specialist Hubs ({hubs.length})</strong>
        </div>
        <button
          type="button"
          className="ghost-button"
          onClick={onOpenCreateModal}
          title="Create New AI Specialist Hub"
        >
          + New Expert
        </button>
      </div>

      <div className="specialist-gallery__list">
        <button
          type="button"
          className={`specialist-card ${!activeSpecialistId ? 'active' : ''}`}
          onClick={() => onSelectSpecialist(null)}
        >
          <span className="specialist-card__icon">🤖</span>
          <div className="specialist-card__body">
            <strong>General Assistant</strong>
            <small>Default local LLM reasoning</small>
          </div>
        </button>

        {hubs.map((hub) => (
          <div
            key={hub.id}
            className={`specialist-card ${activeSpecialistId === hub.id ? 'active' : ''}`}
            onClick={() => onSelectSpecialist(hub.id)}
          >
            <span className="specialist-card__icon">{ICON_MAP[hub.icon] || '🧠'}</span>
            <div className="specialist-card__body">
              <strong>{hub.name}</strong>
              <small>{hub.chunkCount || 0} vector chunks</small>
            </div>
            <div className="specialist-card__actions">
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
          </div>
        ))}
      </div>
    </div>
  );
}
