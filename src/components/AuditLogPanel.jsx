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
      <p className="modal-description">
        An append-only record of sensitive actions — exports, deletions, installs and
        settings changes. Each entry is hash-chained to the one before it, so an edited
        or removed entry is detectable. Secret values (API keys) are never recorded.
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
