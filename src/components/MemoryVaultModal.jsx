import { useEffect, useState } from 'react';

export default function MemoryVaultModal({ isOpen, onClose, sidekick }) {
  const [memories, setMemories] = useState([]);
  const [newFact, setNewFact] = useState('');
  const [category, setCategory] = useState('user-defined');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadMemories() {
    if (!sidekick) return;
    setLoading(true);
    try {
      const list = await sidekick.memory.list();
      setMemories(list || []);
    } catch (_e) {
      // Ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isOpen) {
      loadMemories();
    }
  }, [isOpen]);

  async function handleAddMemory(e) {
    e.preventDefault();
    if (!newFact.trim() || !sidekick) return;

    await sidekick.memory.add({
      fact: newFact.trim(),
      category: category.trim() || 'user-defined',
    });

    setNewFact('');
    await loadMemories();
  }

  async function handleDeleteMemory(id) {
    if (!sidekick) return;
    await sidekick.memory.delete(id);
    await loadMemories();
  }

  if (!isOpen) return null;

  const filtered = memories.filter(
    (m) =>
      m.fact.toLowerCase().includes(search.toLowerCase()) ||
      m.category.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p>Sidekick Memory Vault</p>
            <h2>Contextual Long-Term Memory</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        <p className="modal-description">
          Memories and facts stored here are automatically retrieved into model prompts across all your conversations to personalize responses.
        </p>

        <form onSubmit={handleAddMemory} className="memory-add-form">
          <input
            type="text"
            placeholder="Add a new fact (e.g. 'I work with Python and FastAPI')"
            value={newFact}
            onChange={(e) => setNewFact(e.target.value)}
          />
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="user-defined">User Preference</option>
            <option value="tech-stack">Tech Stack</option>
            <option value="hardware">Hardware / OS</option>
            <option value="project-rule">Project Rule</option>
          </select>
          <button type="submit" className="primary-button" disabled={!newFact.trim()}>
            Add Fact
          </button>
        </form>

        <div className="memory-search-bar">
          <input
            type="text"
            placeholder="Filter memories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="memory-list">
          {loading ? (
            <p className="memory-empty">Loading memory vault...</p>
          ) : filtered.length === 0 ? (
            <p className="memory-empty">No stored memories found in database.</p>
          ) : (
            filtered.map((mem) => (
              <div key={mem.id} className="memory-card">
                <div className="memory-card__content">
                  <strong>{mem.fact}</strong>
                  <span className="memory-category-tag">{mem.category}</span>
                </div>
                <button
                  type="button"
                  className="ghost-button danger"
                  onClick={() => handleDeleteMemory(mem.id)}
                  title="Delete memory"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
