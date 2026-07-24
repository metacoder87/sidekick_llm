import { useEffect, useState } from 'react';

// Turn a worker/IPC result into an honest status line. Never claims success for a
// failed or zero-result operation (ROADMAP §5 Phase 3 — no silent success, no
// `res.message || '✅'` lie).
function describeResult(res) {
  if (!res) return 'Done.';
  if (res.success === false) {
    if (res.cancelled) return '';
    return `⚠️ ${res.reason || res.message || 'Operation did not complete.'}`;
  }
  if (typeof res.chunksCount === 'number') {
    return `✅ Indexed ${res.chunksCount} chunks${res.chunksFailed ? ` (${res.chunksFailed} failed to embed)` : ''}.`;
  }
  if (typeof res.totalChunks === 'number') {
    return `✅ Deep research indexed ${res.totalChunks} chunks${res.totalFailed ? ` (${res.totalFailed} failed to embed)` : ''}.`;
  }
  if (typeof res.reindexed === 'number') {
    return `✅ Re-indexed ${res.reindexed} chunks${res.failed ? ` (${res.failed} failed)` : ''}.`;
  }
  return res.message || 'Done.';
}

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
  const [completed, setCompleted] = useState(false);
  const [stats, setStats] = useState({
    chunkCount: hubToEdit?.chunkCount || 0,
    retrievableChunkCount: hubToEdit?.retrievableChunkCount ?? hubToEdit?.chunkCount ?? 0,
  });

  // Pull fresh counts for a hub after any vault-changing operation and reflect them
  // in both this modal and the parent.
  async function refreshHubStats(hubId) {
    if (!sidekick || !hubId) return;
    const updated = await sidekick.specialist.get(hubId).catch(() => null);
    if (updated) {
      setStats({
        chunkCount: updated.chunkCount || 0,
        retrievableChunkCount: updated.retrievableChunkCount ?? updated.chunkCount ?? 0,
      });
      onHubSaved(updated);
    }
  }

  async function handleReindex() {
    if (!sidekick || !hubToEdit?.id) return;
    setLoading(true);
    setStatusMessage('Re-indexing knowledge vault with the current embedding model...');
    try {
      const res = await sidekick.specialist.reindex(hubToEdit.id);
      setStatusMessage(describeResult(res));
      await refreshHubStats(hubToEdit.id);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  const staleCount = Math.max(0, stats.chunkCount - stats.retrievableChunkCount);

  useEffect(() => {
    if (sidekick?.events?.onResearchProgress) {
      const removeProgress = sidekick.events.onResearchProgress((payload) => {
        if (!hubToEdit || payload.hubId === hubToEdit.id) {
          setStatusMessage(payload.message || 'Processing research...');
        }
      });
      return () => removeProgress();
    }
  }, [sidekick, hubToEdit]);

  if (!isOpen) return null;

  async function handleSaveAndTrain(e) {
    e.preventDefault();
    if (!name.trim() || !sidekick) return;
    setLoading(true);
    setStatusMessage('Saving Specialist Hub settings...');

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

      // If initial research topic is entered, run deep research now
      if (researchTopic.trim()) {
        setStatusMessage(`Running initial Web Deep Research on "${researchTopic.trim()}"...`);
        try {
          const res = await sidekick.research.start({
            hubId: savedHub.id,
            topic: researchTopic.trim(),
          });
          setStatusMessage(describeResult(res));
          if (res.success !== false) setCompleted(true);
          await refreshHubStats(savedHub.id);
        } catch (resErr) {
          setStatusMessage(`Research Warning: ${resErr.message}`);
        }
      } else {
        onClose();
      }
    } catch (err) {
      setStatusMessage(`Error saving hub: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleIngestFile() {
    const hubId = hubToEdit?.id;
    if (!sidekick) return;

    if (!hubId) {
      if (!name.trim()) {
        setStatusMessage('Please enter a Specialist Name first.');
        return;
      }
      setLoading(true);
      try {
        const createdHub = await sidekick.specialist.create({
          name,
          description,
          systemPrompt,
          icon,
        });
        onHubSaved(createdHub);
        const res = await sidekick.research.ingestFile({ hubId: createdHub.id });
        if (!res.cancelled) {
          setStatusMessage(describeResult(res));
          if (res.success) setCompleted(true);
          await refreshHubStats(createdHub.id);
        }
      } catch (err) {
        setStatusMessage(`Error: ${err.message}`);
      } finally {
        setLoading(false);
      }
      return;
    }

    setStatusMessage('Selecting document file...');
    try {
      const res = await sidekick.research.ingestFile({ hubId });
      if (!res.cancelled) {
        setStatusMessage(describeResult(res));
        if (res.success) setCompleted(true);
        await refreshHubStats(hubId);
      }
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    }
  }

  async function handleRunResearchNow(e) {
    e.preventDefault();
    if (!researchTopic.trim() || !sidekick) return;

    let targetHubId = hubToEdit?.id;
    if (!targetHubId) {
      if (!name.trim()) {
        setStatusMessage('Please enter a Specialist Name first.');
        return;
      }
      setLoading(true);
      try {
        const createdHub = await sidekick.specialist.create({
          name,
          description,
          systemPrompt,
          icon,
        });
        targetHubId = createdHub.id;
        onHubSaved(createdHub);
      } catch (err) {
        setStatusMessage(`Error: ${err.message}`);
        setLoading(false);
        return;
      }
    }

    setStatusMessage(`Starting web deep research for "${researchTopic}"...`);
    setLoading(true);

    try {
      const res = await sidekick.research.start({
        hubId: targetHubId,
        topic: researchTopic.trim(),
      });
      setStatusMessage(describeResult(res));
      if (res.success !== false) {
        setCompleted(true);
        setResearchTopic('');
      }
      await refreshHubStats(targetHubId);
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
            <h2>{isEditing ? `Manage Hub: ${hubToEdit.name}` : '⚡ Create & Train AI Expert'}</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        {statusMessage ? <div className="status-notice-banner">{statusMessage}</div> : null}

        <form onSubmit={handleSaveAndTrain} className="profile-form">
          <div className="form-grid">
            <label className="form-field">
              <span>Specialist Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. React 19 Expert, Tax Law Advisor"
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
            <span>Expert Persona & Instructions</span>
            <textarea
              rows={3}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. You are a world-class React 19 engineer. Provide authoritative, production-grade solutions."
            />
          </label>

          <div className="specialist-vault-section">
            <h3>Knowledge Vault Training & Ingestion</h3>
            <p className="modal-description">
              Provide a research topic or upload documents (PDF, TXT, MD) to train this AI Expert's RAG knowledge vault. {isEditing && stats.chunkCount ? `(${stats.retrievableChunkCount} of ${stats.chunkCount} chunks retrievable with the current embedding model)` : ''}
            </p>

            {isEditing && staleCount > 0 ? (
              <div className="vault-warning">
                <p>
                  ⚠️ {staleCount} chunk{staleCount === 1 ? '' : 's'} were embedded with a
                  different (or no) model and are not currently retrievable. Re-index to
                  repair them — no re-upload needed.
                </p>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleReindex}
                  disabled={loading}
                >
                  🔧 Re-index Knowledge Vault
                </button>
              </div>
            ) : null}

            <div className="vault-actions-grid">
              <div className="research-inline-form">
                <input
                  type="text"
                  placeholder="Enter topic or URLs for Web Deep Research..."
                  value={researchTopic}
                  onChange={(e) => setResearchTopic(e.target.value)}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleRunResearchNow}
                  disabled={loading || !researchTopic.trim()}
                >
                  Run Deep Research
                </button>
              </div>

              <button
                type="button"
                className="secondary-button vault-upload-btn"
                onClick={handleIngestFile}
                disabled={loading}
              >
                📄 Upload & Index PDF / Text Document
              </button>
            </div>
          </div>

          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              {completed ? 'Done / Close' : 'Cancel'}
            </button>
            <button type="submit" className="primary-button" disabled={loading || !name.trim()}>
              {loading ? 'Processing...' : isEditing ? 'Save Changes' : '⚡ Save & Train Expert'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
