import { useEffect, useMemo, useState } from 'react';

const ICON_MAP = {
  brain: '🧠',
  code: '💻',
  scale: '⚖️',
  chart: '📊',
  book: '📚',
};

// A browsable library of curated Expert templates. Each is a "recipe": a persona
// plus a seed research brief that runs on THIS machine when installed, so nothing
// third-party is redistributed (ROADMAP Stage 7).
export default function ExpertLibraryModal({ isOpen, onClose, sidekick, onInstalled }) {
  const [templates, setTemplates] = useState([]);
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const [installingId, setInstallingId] = useState(null);
  const [progress, setProgress] = useState('');
  const [status, setStatus] = useState('');

  async function load() {
    if (!sidekick) return;
    try {
      const catalog = await sidekick.specialist.catalog();
      setTemplates(catalog.templates || []);
    } catch (_e) {
      /* non-fatal */
    }
  }

  useEffect(() => {
    if (isOpen) {
      load();
      setStatus('');
      setProgress('');
    }
  }, [isOpen, sidekick]);

  // Seed research reports progress like any other Deep Research run.
  useEffect(() => {
    if (!sidekick?.events?.onResearchProgress) return undefined;
    return sidekick.events.onResearchProgress((payload) => {
      if (installingId) setProgress(payload.message || '');
    });
  }, [sidekick, installingId]);

  const categories = useMemo(
    () => ['All', ...[...new Set(templates.map((t) => t.category))].sort()],
    [templates],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return templates.filter((t) => {
      const inCategory = category === 'All' || t.category === category;
      const matches =
        !needle ||
        t.name.toLowerCase().includes(needle) ||
        t.description.toLowerCase().includes(needle) ||
        t.category.toLowerCase().includes(needle);
      return inCategory && matches;
    });
  }, [templates, category, query]);

  if (!isOpen) return null;

  async function install(template, runResearch) {
    if (!sidekick) return;
    setInstallingId(template.id);
    setStatus(
      runResearch
        ? `Installing ${template.name} and researching its domain — this can take a few minutes…`
        : `Installing ${template.name}…`,
    );
    setProgress('');
    try {
      const res = await sidekick.specialist.installFromCatalog({
        templateId: template.id,
        runResearch,
      });

      // Report honestly: an installed persona with an empty vault is useful but
      // ungrounded, and the user should know which they got.
      if (res.researched) {
        setStatus(`✅ ${res.hub.name} installed with ${res.chunksIndexed} knowledge chunks.`);
      } else if (runResearch) {
        setStatus(
          `⚠️ ${res.hub.name} installed, but its research did not complete: ${res.reason || 'unknown reason'}. The persona works; train it from its settings.`,
        );
      } else {
        setStatus(`✅ ${res.hub.name} installed (persona only — train it when ready).`);
      }

      await load();
      if (onInstalled) await onInstalled(res.hub);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setInstallingId(null);
      setProgress('');
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content library-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p>Curated starting points — installed locally, researched on your machine</p>
            <h2>📚 Expert Library</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        {status ? <div className="status-notice-banner">{status}</div> : null}
        {progress ? <div className="library-progress">{progress}</div> : null}

        <div className="library-controls">
          <input
            type="search"
            placeholder="Search Experts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="library-categories">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                className={`chip ${category === c ? 'chip--active' : ''}`}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="library-grid">
          {visible.length === 0 ? (
            <p className="memory-empty">No Experts match that search.</p>
          ) : (
            visible.map((template) => (
              <div key={template.id} className="library-card">
                <div className="library-card__head">
                  <span className="library-card__icon">{ICON_MAP[template.icon] || '🧠'}</span>
                  <div>
                    <strong>{template.name}</strong>
                    <span className="library-card__cat">{template.category}</span>
                  </div>
                  {template.alreadyInstalled ? (
                    <span className="active-pill">INSTALLED</span>
                  ) : null}
                </div>

                <p className="library-card__desc">{template.description}</p>

                <div className="library-card__actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!!installingId}
                    onClick={() => install(template, true)}
                    title="Create this Expert and research its domain now"
                  >
                    {installingId === template.id ? 'Installing…' : '+ Add & Research'}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!!installingId}
                    onClick={() => install(template, false)}
                    title="Create the persona now and train it later"
                  >
                    Persona only
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <p className="modal-description">
          Adding an Expert creates it in your library and runs its built-in research brief on your
          own machine — the knowledge is fetched and indexed locally, never shipped with the app.
          You can retrain, rename or extend any of them afterwards.
        </p>
      </div>
    </div>
  );
}
