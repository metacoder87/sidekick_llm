import { useState } from 'react';

export default function SpecialistModal({
  isOpen,
  onClose,
  sidekick,
  hubToEdit,
  onHubSaved,
}) {
  const isEditing = !!hubToEdit;
  const [name, setName] = useState(hubToEdit?.name || '');
  const [description, setDescription] = useState(hubToEdit?.description || '');
  const [systemPrompt, setSystemPrompt] = useState(hubToEdit?.systemPrompt || '');
  const [icon, setIcon] = useState(hubToEdit?.icon || 'brain');
  const [researchTopic, setResearchTopic] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  async function handleSave(e) {
    e.preventDefault();
    if (!name.trim() || !sidekick) return;
    setLoading(true);
    try {
      let savedHub;
      if (isEditing) {
        savedHub = await sidekick.specialist.update({
          id: hubToEdit.id,
          name,
          description,
          systemPrompt,
          icon,
        });
      } else {
        savedHub = await sidekick.specialist.create({
          name,
          description,
          systemPrompt,
          icon,
        });
      }
      onHubSaved(savedHub);
      onClose();
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleIngestFile() {
    if (!hubToEdit?.id || !sidekick) return;
    setStatusMessage('Selecting document file...');
    try {
      const res = await sidekick.research.ingestFile({ hubId: hubToEdit.id });
      if (res.success) {
        setStatusMessage(res.message || 'File ingested successfully!');
        const updated = await sidekick.specialist.get(hubToEdit.id);
        if (updated) onHubSaved(updated);
      } else if (!res.cancelled) {
        setStatusMessage('Failed to ingest document.');
      }
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    }
  }

  async function handleStartResearch(e) {
    e.preventDefault();
    if (!hubToEdit?.id || !researchTopic.trim() || !sidekick) return;
    setStatusMessage(`Starting web deep research for "${researchTopic}"...`);
    setLoading(true);

    try {
      const res = await sidekick.research.start({
        hubId: hubToEdit.id,
        topic: researchTopic.trim(),
      });
      setStatusMessage(res.message || 'Deep research complete!');
      setResearchTopic('');
      const updated = await sidekick.specialist.get(hubToEdit.id);
      if (updated) onHubSaved(updated);
    } catch (err) {
      setStatusMessage(`Research Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p>Specialist Knowledge Hub</p>
            <h2>{isEditing ? `Manage Hub: ${hubToEdit.name}` : 'Create AI Expert Hub'}</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        {statusMessage ? <div className="status-notice-banner">{statusMessage}</div> : null}

        <form onSubmit={handleSave} className="profile-form">
          <div className="form-grid">
            <label className="form-field">
              <span>Specialist Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. React 19 Expert, Legal Advisor"
                required
              />
            </label>
            <label className="form-field">
              <span>Icon Badge</span>
              <select value={icon} onChange={(e) => setIcon(e.target.value)}>
                <option value="brain">🧠 Brain</option>
                <option value="code">💻 Code / Stack</option>
                <option value="scale">⚖️ Legal / Tax</option>
                <option value="chart">📊 Data Analytics</option>
                <option value="book">📚 Research Docs</option>
              </select>
            </label>
          </div>

          <label className="form-field">
            <span>Description</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Expert in React Server Components, Hooks, and Next.js 15"
            />
          </label>

          <label className="form-field">
            <span>Expert System Persona & Rules</span>
            <textarea
              rows={3}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. You are a world-class React 19 architect. Provide expert, production-grade solutions."
            />
          </label>

          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={loading || !name.trim()}>
              {loading ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Specialist'}
            </button>
          </div>
        </form>

        {isEditing ? (
          <div className="specialist-vault-section">
            <h3>Knowledge Vault Ingestion</h3>
            <p className="modal-description">
              Upload PDFs/Docs or run automated Web Deep Research to populate this Specialist's vector vault. ({hubToEdit.chunkCount || 0} chunks cached)
            </p>

            <div className="vault-actions-grid">
              <button
                type="button"
                className="secondary-button vault-upload-btn"
                onClick={handleIngestFile}
                disabled={loading}
              >
                📄 Upload & Index PDF / Text Document
              </button>

              <form onSubmit={handleStartResearch} className="research-inline-form">
                <input
                  type="text"
                  placeholder="Enter topic or URLs for Web Deep Research..."
                  value={researchTopic}
                  onChange={(e) => setResearchTopic(e.target.value)}
                />
                <button
                  type="submit"
                  className="primary-button"
                  disabled={loading || !researchTopic.trim()}
                >
                  Run Deep Research
                </button>
              </form>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
