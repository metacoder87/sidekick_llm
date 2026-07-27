import { useEffect, useState } from 'react';

// Notes are where the user's own insight accumulates, as opposed to ingested
// documents. Each note is embedded into the Expert's vault on save, so writing a
// note immediately makes it retrievable knowledge.
export default function NotesPanel({ sidekick, hubId, onChanged }) {
  const [notes, setNotes] = useState([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function load() {
    if (!sidekick || !hubId) return;
    try {
      setNotes((await sidekick.notes.list(hubId)) || []);
    } catch (_e) {
      /* non-fatal */
    }
  }

  useEffect(() => {
    load();
  }, [sidekick, hubId]);

  function resetForm() {
    setEditingId(null);
    setTitle('');
    setBody('');
  }

  async function handleSave(event) {
    event.preventDefault();
    if (!body.trim() || !sidekick) return;
    setBusy(true);
    setStatus(editingId ? 'Updating note and re-indexing…' : 'Saving note and indexing…');
    try {
      const result = editingId
        ? await sidekick.notes.update({ id: editingId, title, body })
        : await sidekick.notes.create({ hubId, title, body, author: 'user' });

      // Report honestly: a saved-but-unindexed note is not retrievable knowledge.
      setStatus(
        result.indexed
          ? `✅ Note saved and indexed (${result.chunksCount} chunk${result.chunksCount === 1 ? '' : 's'}).`
          : `⚠️ Note saved, but not indexed: ${result.reason || 'embedding unavailable'}`,
      );
      resetForm();
      await load();
      if (onChanged) await onChanged();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id) {
    if (!sidekick) return;
    if (!window.confirm('Delete this note and remove it from the vault?')) return;
    await sidekick.notes.delete(id);
    if (editingId === id) resetForm();
    setStatus('Note deleted and removed from the vault.');
    await load();
    if (onChanged) await onChanged();
  }

  function startEdit(note) {
    setEditingId(note.id);
    setTitle(note.title);
    setBody(note.body);
  }

  return (
    <div className="notes-panel">
      <h3>Notes ({notes.length})</h3>
      <p className="modal-description">
        Your own synthesis — insights, conclusions, distilled findings. Every note is embedded into
        this Expert's vault, so it becomes retrievable knowledge just like an uploaded document.
      </p>

      {status ? <div className="status-notice-banner">{status}</div> : null}

      <form onSubmit={handleSave} className="notes-form">
        <input
          type="text"
          placeholder="Note title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          rows={4}
          placeholder="What did you learn? Conclusions, caveats, key facts…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="notes-form__actions">
          {editingId ? (
            <button type="button" className="secondary-button" onClick={resetForm} disabled={busy}>
              Cancel edit
            </button>
          ) : null}
          <button type="submit" className="primary-button" disabled={busy || !body.trim()}>
            {busy ? 'Saving…' : editingId ? 'Update note' : '📝 Save note'}
          </button>
        </div>
      </form>

      <div className="notes-list">
        {notes.length === 0 ? (
          <p className="memory-empty">No notes yet for this Expert.</p>
        ) : (
          notes.map((note) => (
            <div key={note.id} className="note-card">
              <div className="note-card__body">
                <strong>{note.title}</strong>
                <span className="note-card__meta">
                  {note.author === 'model' ? 'saved from a conversation' : 'your note'}
                </span>
                <p className="note-card__text">{note.body}</p>
              </div>
              <div className="note-card__actions">
                <button type="button" className="ghost-button" onClick={() => startEdit(note)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="ghost-button danger"
                  onClick={() => handleDelete(note.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
