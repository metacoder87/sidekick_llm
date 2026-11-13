import { useCallback, useEffect, useState } from 'react';
import { DisclaimerSummary } from './LegalNotice';

// First-run guide. Shown when Ollama is unreachable or no usable model is installed —
// the two states where a new user would otherwise face an app that silently does
// nothing. Deliberately does NOT auto-download: models are multi-GB, and consuming
// someone's disk and bandwidth without asking is not acceptable (ROADMAP Stage 5).
export default function Onboarding({ sidekick, onDone }) {
  const [catalog, setCatalog] = useState(null);
  const [ollamaUp, setOllamaUp] = useState(null);
  const [engine, setEngine] = useState(null); // 'builtin' | 'ollama'
  const [pulling, setPulling] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [selectedChat, setSelectedChat] = useState('Qwen3-8B-Q4_K_M');

  const refresh = useCallback(async () => {
    if (!sidekick) return;
    const status = await sidekick.ollama.getStatus().catch(() => ({ available: false }));
    setOllamaUp(status.available);
    // The built-in engine needs no external server, so its gallery is always
    // shown; for Ollama we only show it once the server answers.
    setEngine(status.baseUrl === null ? 'builtin' : 'ollama');
    if (status.available || status.baseUrl === null) {
      setCatalog(await sidekick.models.catalog().catch(() => null));
    }
  }, [sidekick]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!sidekick?.events?.onModelPull) return undefined;
    return sidekick.events.onModelPull((payload) => setProgress(payload));
  }, [sidekick]);

  async function pull(model) {
    const key = model.id || model.name; // gallery entries use id, Ollama models use name
    setPulling(key);
    setError('');
    setProgress(null);
    try {
      const result = await sidekick.models.pull({ name: key });
      if (!result.ok) setError(result.reason || 'Download failed.');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setPulling(null);
      setProgress(null);
    }
  }

  async function deleteModel(model) {
    const key = model.id || model.name;
    try {
      const result = await sidekick.models.delete({ name: key });
      if (!result.ok) setError(result.reason || 'Delete failed.');
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function installStarterPair() {
    const chat = models.find((model) => (model.id || model.name) === selectedChat);
    const embedder = models.find((model) => model.role === 'embedding');
    if (!chat || !embedder) return;
    setError('');
    try {
      if (!embedder.installed) await pull(embedder);
      if (!chat.installed) await pull(chat);
      await sidekick.settings.set('embeddingModel', embedder.id || embedder.name);
      await sidekick.settings.set('activeModel', chat.id || chat.name);
      await sidekick.settings.set('backgroundModel', '');
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  const hardware = catalog?.hardware;
  const models = catalog?.models || [];
  const embedding = models.find((m) => m.role === 'embedding');
  const hasEmbedding = Boolean(embedding?.installed);
  const hasChat =
    models.some((m) => m.role !== 'embedding' && m.installed) ||
    (catalog?.installed || []).some((n) => !n.includes('embed'));
  const ready = hasEmbedding && hasChat;

  return (
    <div className="onboarding">
      <div className="onboarding__panel">
        <div className="onboarding__brand">⚡ Welcome to Sidekick</div>
        <p className="onboarding__lede">
          A private knowledge workspace that runs entirely on your machine. Nothing you write,
          upload or research leaves this computer.
        </p>

        {/* Step 1 — engine */}
        <div className={`onboarding__step ${ollamaUp !== false ? 'is-done' : 'is-active'}`}>
          <div className="onboarding__step-head">
            <span>{ollamaUp !== false ? '✅' : '①'}</span>
            <strong>{engine === 'builtin' ? 'Model engine ready' : 'Ollama running'}</strong>
          </div>
          {ollamaUp === false && engine !== 'builtin' ? (
            <div className="onboarding__body">
              <p>
                Sidekick uses <strong>Ollama</strong> to run models locally. It does not appear to
                be running. (You can switch to the built-in engine in Settings → Model & Engine.)
              </p>
              <ol>
                <li>
                  Install it from <code>ollama.com</code>
                </li>
                <li>Start it (it runs in the background)</li>
                <li>Press Re-check below</li>
              </ol>
              <button type="button" className="primary-button" onClick={refresh}>
                Re-check
              </button>
            </div>
          ) : ollamaUp !== false ? (
            <p className="onboarding__ok">
              {engine === 'builtin'
                ? 'Built-in engine — models run inside the app, no server or open port needed.'
                : 'Connected.'}
            </p>
          ) : (
            <p className="onboarding__ok">Checking…</p>
          )}
        </div>

        {/* Step 2 — models */}
        {ollamaUp !== false || engine === 'builtin' ? (
          <div className={`onboarding__step ${ready ? 'is-done' : 'is-active'}`}>
            <div className="onboarding__step-head">
              <span>{ready ? '✅' : '②'}</span>
              <strong>Install models</strong>
            </div>

            {hardware ? (
              <p className="onboarding__hardware">
                Detected {hardware.totalRamGB} GB RAM, {hardware.cpuCount} cores. Sizes below are
                downloads — pick what fits your disk and patience.
              </p>
            ) : null}

            {!hasEmbedding ? (
              <div className="onboarding__required">
                An embedding model is <strong>required</strong> — Experts and memory cannot work
                without one. It is small.
              </div>
            ) : null}

            {engine === 'builtin' ? (
              <div className="onboarding__required">
                <strong>Recommended starter profile</strong>
                <p>
                  Choose a chat model; Sidekick also installs Nomic Embed Text v1.5 for private
                  search. Downloads begin only after you press Install.
                </p>
                <label className="form-field">
                  <span>Chat model</span>
                  <select
                    value={selectedChat}
                    onChange={(event) => setSelectedChat(event.target.value)}
                  >
                    {models
                      .filter(
                        (model) =>
                          model.role === 'chat' &&
                          (model.recommended || model.id === 'Qwen2.5-7B-Instruct-Q4_K_M'),
                      )
                      .map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label} — {model.sizeGB} GB
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="primary-button"
                  disabled={Boolean(pulling)}
                  onClick={installStarterPair}
                >
                  Install selected model + embeddings
                </button>
                <p className="onboarding__footnote">
                  Sources: <a href="https://huggingface.co/Qwen/Qwen3-8B-GGUF">Qwen3 GGUF</a> and{' '}
                  <a href="https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF">
                    Nomic Embed GGUF
                  </a>
                  .
                </p>
              </div>
            ) : null}

            {error ? <div className="lock-error">{error}</div> : null}

            <div className="onboarding__models">
              {models.map((model) => (
                <div
                  key={model.id || model.name}
                  className={`onboarding__model ${model.installed ? 'is-installed' : ''} ${!model.fits ? 'is-tight' : ''}`}
                >
                  <div className="onboarding__model-main">
                    <div className="onboarding__model-title">
                      <strong>{model.id || model.name}</strong>
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
                    <div className="onboarding__model-actions">
                      {!model.installed ? (
                        <button
                          type="button"
                          className={
                            model.required || model.recommended
                              ? 'primary-button'
                              : 'secondary-button'
                          }
                          disabled={Boolean(pulling)}
                          onClick={() => pull(model)}
                        >
                          {pulling === (model.id || model.name) ? 'Downloading…' : 'Download'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={Boolean(pulling)}
                          onClick={() => deleteModel(model)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
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

        <DisclaimerSummary />

        <div className="onboarding__actions">
          <button type="button" className="ghost-button" onClick={onDone}>
            Skip for now
          </button>
          <button type="button" className="primary-button" disabled={!ready} onClick={onDone}>
            {ready ? "Let's go" : 'Install a model to continue'}
          </button>
        </div>

        <p className="onboarding__footnote">
          You can install any other local model yourself (built-in engine: drop a .gguf file into
          the models folder; Ollama: <code>{'ollama pull <model>'}</code>) — this list is just a
          starting point. Change engines and models any time in Settings.
        </p>
      </div>
    </div>
  );
}
