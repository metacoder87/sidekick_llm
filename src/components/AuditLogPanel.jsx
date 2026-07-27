import { useEffect, useState } from 'react';

const ACTION_LABELS = {
  'app.open': 'App opened',
  'integrity.failed': 'Database integrity check FAILED',
  'corpus.export': 'Corpus exported',
  'corpus.import': 'Corpus imported',
  'expertPack.export': 'Expert Pack exported',
  'expertPack.import': 'Expert Pack installed',
  'expert.delete': 'Expert deleted',
  'conversation.delete': 'Conversation deleted',
  'note.delete': 'Note deleted',
  'memory.delete': 'Memory deleted',
  'settings.set': 'Setting changed',
  'audit.export': 'Audit log exported',
};

// Sensitive actions worth visually flagging in a long list.
const SERIOUS = new Set([
  'integrity.failed',
  'corpus.export',
  'expert.delete',
  'conversation.delete',
  'expertPack.export',
]);

// Encryption controls. Deliberately blunt about the one irreversible risk: a lost
// passphrase means a lost corpus, and no amount of UI politeness changes that.
function EncryptionControls({ sidekick }) {
  const [sec, setSec] = useState(null);
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [autoLock, setAutoLock] = useState('0');

  async function refresh() {
    if (!sidekick?.security) return;
    setSec(await sidekick.security.status().catch(() => null));
    const settings = await sidekick.settings.get().catch(() => null);
    if (settings?.autoLockMinutes) setAutoLock(String(settings.autoLockMinutes));
  }

  useEffect(() => {
    refresh();
  }, [sidekick]);

  if (!sidekick?.security) return null;

  async function enable() {
    if (pass !== confirm) return setMsg('The two passphrases do not match.');
    setBusy(true);
    setMsg('Encrypting your corpus — a backup is taken first…');
    try {
      const res = await sidekick.security.enable({ passphrase: pass, remember });
      setMsg(
        res.ok
          ? `✅ Corpus encrypted. Unencrypted backup kept at ${res.backupPath} — move or delete it once you have verified everything works.`
          : `⚠️ ${res.reason}`,
      );
      if (res.ok) {
        setPass('');
        setConfirm('');
        setAcknowledged(false);
      }
      await refresh();
    } catch (err) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setMsg('Decrypting your corpus…');
    try {
      const res = await sidekick.security.disable({ passphrase: pass });
      setMsg(res.ok ? `✅ Encryption removed. Backup at ${res.backupPath}` : `⚠️ ${res.reason}`);
      if (res.ok) setPass('');
      await refresh();
    } catch (err) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function change() {
    if (pass !== confirm) return setMsg('The two new passphrases do not match.');
    setBusy(true);
    setMsg('Changing passphrase…');
    try {
      const res = await sidekick.security.changePassphrase({
        currentPassphrase: document.getElementById('current-pass')?.value || '',
        newPassphrase: pass,
        remember,
      });
      setMsg(res.ok ? '✅ Passphrase changed.' : `⚠️ ${res.reason}`);
      if (res.ok) {
        setPass('');
        setConfirm('');
      }
      await refresh();
    } catch (err) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="encryption-controls">
      <h3>Encryption at rest</h3>
      {msg ? <div className="status-notice-banner">{msg}</div> : null}

      {sec?.encrypted ? (
        <>
          <div className="audit-verify audit-verify--ok">
            🔒 This corpus is encrypted. It cannot be opened without your passphrase.
          </div>

          <div className="lock-row">
            <label className="form-field lock-row__field">
              <span>Auto-lock after inactivity</span>
              <select
                value={autoLock}
                disabled={busy}
                onChange={async (event) => {
                  const value = event.target.value;
                  setAutoLock(value);
                  await sidekick.settings.set('autoLockMinutes', value);
                }}
              >
                <option value="0">Never</option>
                <option value="5">5 minutes</option>
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
              </select>
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={async () => {
                await sidekick.security.lock();
                window.location.reload();
              }}
              title="Close the corpus now and require the passphrase again"
            >
              🔒 Lock now
            </button>
          </div>
          <p className="modal-description">
            Sidekick also locks when the computer sleeps or the workstation is locked. Inactivity is
            measured system-wide, so working in another app will not lock you out.
          </p>

          <label className="form-field">
            <span>Current passphrase</span>
            <input
              id="current-pass"
              type="password"
              placeholder="Current passphrase"
              disabled={busy}
            />
          </label>
          <label className="form-field">
            <span>New passphrase (leave blank to only remove encryption)</span>
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="form-field">
            <span>Confirm new passphrase</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
            />
          </label>

          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={change}
              disabled={busy || !pass}
            >
              Change passphrase
            </button>
            <button
              type="button"
              className="ghost-button danger"
              onClick={disable}
              disabled={busy || !pass}
            >
              Remove encryption
            </button>
          </div>
          <p className="modal-description">
            To remove encryption, enter your current passphrase in the “New passphrase” field and
            press Remove encryption.
          </p>
        </>
      ) : (
        <>
          <p className="modal-description">
            Encrypts the entire database — conversations, Experts, notes and memory — with AES-256.
            Without the passphrase the file cannot be read, even by copying it to another machine.
          </p>

          <div className="encryption-warning">
            <strong>⚠️ There is no recovery.</strong> If you lose this passphrase your corpus is
            unrecoverable — there is no reset, and I cannot help you get back in. Store it in a
            password manager, and export your corpus first.
          </div>

          <label className="form-field">
            <span>Passphrase (minimum 8 characters)</span>
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="form-field">
            <span>Confirm passphrase</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
            />
          </label>

          {sec?.keychainAvailable ? (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>Remember on this device (stored in the OS keychain, not in a file)</span>
            </label>
          ) : null}

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>
              I have stored this passphrase somewhere safe and understand it cannot be recovered.
            </span>
          </label>

          <div className="modal-actions">
            <button
              type="button"
              className="primary-button"
              onClick={enable}
              disabled={busy || !acknowledged || pass.length < 8 || pass !== confirm}
            >
              {busy ? 'Encrypting…' : '🔒 Encrypt my corpus'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function AuditLogPanel({ sidekick }) {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [verification, setVerification] = useState(null);
  const [status, setStatus] = useState('');

  async function load() {
    if (!sidekick) return;
    try {
      const [listed, verified] = await Promise.all([
        sidekick.system.auditList({ limit: 200 }),
        sidekick.system.auditVerify(),
      ]);
      setEntries(listed.entries || []);
      setTotal(listed.total || 0);
      setVerification(verified);
    } catch (_e) {
      /* non-fatal */
    }
  }

  useEffect(() => {
    load();
  }, [sidekick]);

  async function handleExport() {
    if (!sidekick) return;
    setStatus('Exporting audit log…');
    try {
      const res = await sidekick.system.auditExport();
      setStatus(res.cancelled ? '' : `✅ Exported to ${res.filePath}`);
      await load();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }

  return (
    <div className="audit-panel">
      <EncryptionControls sidekick={sidekick} />

      <h3 className="audit-heading">Audit log</h3>
      <p className="modal-description">
        An append-only record of sensitive actions — exports, deletions, installs and settings
        changes. Each entry is hash-chained to the one before it, so an edited or removed entry is
        detectable. Secret values (API keys) are never recorded.
      </p>

      {verification ? (
        <div
          className={`audit-verify ${verification.ok ? 'audit-verify--ok' : 'audit-verify--broken'}`}
        >
          {verification.ok
            ? `✅ Chain verified — ${verification.entries} entries intact.`
            : `⚠️ Chain verification FAILED at entry #${verification.brokenAt}. Entries from that point may have been altered or removed.`}
        </div>
      ) : null}

      {status ? <div className="status-notice-banner">{status}</div> : null}

      <div className="audit-actions">
        <button type="button" className="secondary-button" onClick={load}>
          Refresh
        </button>
        <button type="button" className="secondary-button" onClick={handleExport}>
          Export audit log
        </button>
        <span className="audit-count">
          {total} {total === 1 ? 'entry' : 'entries'}
          {total > entries.length ? ` (showing latest ${entries.length})` : ''}
        </span>
      </div>

      <div className="audit-list">
        {entries.length === 0 ? (
          <p className="memory-empty">No audited actions yet.</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.seq}
              className={`audit-row ${SERIOUS.has(entry.action) ? 'audit-row--serious' : ''}`}
            >
              <span className="audit-row__seq">#{entry.seq}</span>
              <span className="audit-row__at">{new Date(entry.at).toLocaleString()}</span>
              <span className="audit-row__action">
                {ACTION_LABELS[entry.action] || entry.action}
              </span>
              {entry.detail ? (
                <span className="audit-row__detail" title={entry.detail}>
                  {entry.detail}
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
