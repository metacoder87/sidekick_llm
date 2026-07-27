import { useEffect, useState } from 'react';

// Shown instead of the app when the corpus is encrypted and not yet opened this
// session. Nothing behind it is reachable — the main process refuses every other
// IPC call while locked, so this is a real gate rather than a visual one.
export default function LockScreen({ sidekick, status, onUnlocked }) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // If the passphrase is remembered on this device, try it before asking.
  useEffect(() => {
    let cancelled = false;
    async function tryRemembered() {
      if (!sidekick || !status?.remembered) return;
      setBusy(true);
      try {
        const result = await sidekick.security.unlock({ useRemembered: true });
        if (!cancelled && result.unlocked) onUnlocked(result);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    tryRemembered();
    return () => {
      cancelled = true;
    };
  }, [sidekick, status?.remembered]);

  async function submit(event) {
    event.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await sidekick.security.unlock({ passphrase });
      if (result.unlocked) {
        setPassphrase('');
        onUnlocked(result);
      } else {
        setError(result.reason || 'Could not unlock.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lock-screen">
      <form className="lock-panel" onSubmit={submit}>
        <div className="lock-panel__brand">🔒 Sidekick</div>
        <h1>Your corpus is encrypted</h1>
        <p>
          Enter your passphrase to open your conversations, Experts and memory. Everything stays on
          this machine.
        </p>

        <input
          type="password"
          value={passphrase}
          autoFocus
          placeholder="Passphrase"
          onChange={(event) => setPassphrase(event.target.value)}
          disabled={busy}
        />

        {error ? <div className="lock-error">{error}</div> : null}

        <button type="submit" className="primary-button" disabled={busy || !passphrase}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>

        <p className="lock-hint">
          There is no way to recover this passphrase. If it is lost, the corpus cannot be opened —
          restore from an export or an unencrypted backup instead.
        </p>
      </form>
    </div>
  );
}
