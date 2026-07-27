import { useEffect, useState } from 'react';

// First-run guide. Shown when Ollama is unreachable or no usable model is installed —
// the two states where a new user would otherwise face an app that silently does
// nothing. Deliberately does NOT auto-download: models are multi-GB, and consuming
// someone's disk and bandwidth without asking is not acceptable (ROADMAP Stage 5).
export default function Onboarding({ sidekick, onDone }) {
  const [catalog, setCatalog] = useState(null);
  const [ollamaUp, setOllamaUp] = useState(null);
  const [pulling, setPulling] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');

  async function refresh() {
    if (!sidekick) return;
    const status = await sidekick.ollama.getStatus().catch(() => ({ available: false }));
    setOllamaUp(status.available);
    if (status.available) {
      setCatalog(await sidekick.models.catalog().catch(() => null));
    }
  }

  useEffect(() => {
    refresh();
  }, [sidekick]);

  useEffect(() => {
    if (!sidekick?.events?.onModelPull) return undefined;
    return sidekick.events.onModelPull((payload) => setProgress(payload));
  }, [sidekick]);

  async function pull(model) {
    setPulling(model.name);
    setError('');
    setProgress(null);
    try {
      const result = await sidekick.models.pull({ name: model.name });
      if (!result.ok) setError(result.reason || 'Download failed.');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setPulling(null);
      setProgress(null);
    }
  }

  const hardware = catalog?.hardware;
  const models = catalog?.models || [];
  const embedding = models.find((m) => m.role === 'embedding');
  const hasEmbedding = Boolean(embedding?.installed);
  const hasChat = models.some((m) => m.role !== 'embedding' && m.installed) ||
    (catalog?.installed || []).some((n) => !n.includes('embed'));
  const ready = hasEmbedding && hasChat;

  return (
    <div className="onboarding">
      <div className="onboarding__panel">
        <div className="onboarding__brand">⚡ Welcome to Sidekick</div>
        <p className="onboarding__lede">
          A private knowledge workspace that runs entirely on your machine. Nothing you
          write, upload or research leaves this computer.
        </p>

        {/* Step 1 — Ollama */}
        <div className={`onboarding__step ${ollamaUp ? 'is-done' : 'is-active'}`}>
          <div className="onboarding__step-head">
            <span>{ollamaUp ? '✅' : '①'}</span>
            <strong>Ollama running</strong>
          </div>
          {ollamaUp === false ? (
            <div className="onboarding__body">
              <p>
                Sidekick uses <strong>Ollama</strong> to run models locally. It does not
                appear to be running.
              </p>
              <ol>
                <li>Install it from <code>ollama.com</code></li>
                <li>Start it (it runs in the background)</li>
                <li>Press Re-check below</li>
              </ol>
              <button type="button" className="primary-button" onClick={refresh}>
                Re-check
              </button>
            </div>
          ) : ollamaUp ? (
            <p className="onboarding__ok">Connected.</p>
          ) : (
            <p className="onboarding__ok">Checking…</p>
          )}
        </div>

        {/* Step 2 — models */}
        {ollamaUp ? (
          <div className={`onboarding__step ${ready ? 'is-done' : 'is-active'}`}>
            <div className="onboarding__step-head">
              <span>{ready ? '✅' : '②'}</span>
              <strong>Install models</strong>
            </div>

            {hardware ? (
              <p className="onboarding__hardware">
                Detected {hardware.totalRamGB} GB RAM, {hardware.cpuCount} cores. Sizes below
                are downloads — pick what fits your disk and patience.
              </p>
            ) : null}

            {!hasEmbedding ? (
              <div className="onboarding__required">
                An embedding model is <strong>required</strong> — Experts and memory cannot
                work without one. It is small.
              </div>
            ) : null}

            {error ? <div className="lock-error">{error}</div> : null}

            <div className="onboarding__models">
              {models.map((model) => (
                <div
                  key={model.name}
                  className={`onboarding__model ${model.installed ? 'is-installed' : ''} ${!model.fits ? 'is-tight' : ''}`}
                >
                  <div className="onboarding__model-main">
                    <div className="onboarding__model-title">
                      <strong>{model.name}</strong>
                      <span className="library-card__cat">{model.label}</span>
                      {model.recommended && !model.installed ? (
                        <span className="active-pill">RECOMMENDED</span>
                      ) : null}
                      {model.installed ? <span className="active-pill">INSTALLED</span> : null}
                    </div>
                    <p>{model.description}</p>
                    <p className="onboarding__why">{model.why}</p>
                    {!model.fits ? (
                      <p className="onboarding__warn">
                        Needs about {model.minRamGB} GB RAM — likely too slow on this machine.
                      </p>
                    ) : null}
                  </div>
                  <div className="onboarding__model-side">
                    <span className="onboarding__size">{model.sizeGB} GB</span>
                    {model.installed ? null : (
                      <button
                        type="button"
                        className={model.required || model.recommended ? 'primary-button' : 'secondary-button'}
                        disabled={Boolean(pulling)}
                        onClick={() => pull(model)}
                      >
                        {pulling === model.name ? 'Downloading…' : 'Download'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {pulling && progress ? (
              <div className="onboarding__progress">
                <div className="onboarding__progress-label">
                  {pulling}: {progress.status}
                  {progress.percent !== null ? ` — ${progress.percent}%` : ''}
                </div>
                <div className="onboarding__bar">
                  <div style={{ width: `${progress.percent ?? 0}%` }} />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="onboarding__actions">
          <button type="button" className="ghost-button" onClick={onDone}>
            Skip for now
          </button>
          <button type="button" className="primary-button" disabled={!ready} onClick={onDone}>
            {ready ? "Let's go" : 'Install a model to continue'}
          </button>
        </div>

        <p className="onboarding__footnote">
          You can pull any other Ollama model yourself — this list is just a starting point.
          Change models any time in Settings.
        </p>
      </div>
    </div>
  );
}
