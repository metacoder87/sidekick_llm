import { useEffect, useState } from 'react';

export default function UserProfileModal({ isOpen, onClose, sidekick, onProfileUpdated }) {
  const [name, setName] = useState('User');
  const [role, setRole] = useState('Software Developer');
  const [tone, setTone] = useState('Balanced & Helpful');
  const [stack, setStack] = useState('JavaScript / Node.js');
  const [instructions, setInstructions] = useState('Provide clean code, clear explanations, and best practices.');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen && sidekick) {
      sidekick.profile.get().then((profile) => {
        if (profile) {
          setName(profile.name || 'User');
          setRole(profile.role || 'Software Developer');
          setTone(profile.tone || 'Balanced & Helpful');
          setStack(profile.stack || 'JavaScript / Node.js');
          setInstructions(profile.instructions || 'Provide clean code, clear explanations, and best practices.');
        }
      }).catch(() => {});
    }
  }, [isOpen, sidekick]);

  if (!isOpen) return null;

  async function handleSave(e) {
    e.preventDefault();
    if (!sidekick) return;
    setSaving(true);
    try {
      const updated = await sidekick.profile.set({
        name,
        role,
        tone,
        stack,
        instructions,
      });
      if (onProfileUpdated) onProfileUpdated(updated);
      onClose();
    } catch (err) {
      console.error('Failed to save profile:', err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p>User Profile & Custom Guidelines</p>
            <h2>Personalize Your AI Sidekick</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        <p className="modal-description">
          Configure your personal identity, technical context, and global prompt rules. These preferences are automatically injected into model prompts across all your conversations.
        </p>

        <form onSubmit={handleSave} className="profile-form">
          <div className="form-grid">
            <label className="form-field">
              <span>Your Name</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="form-field">
              <span>Your Role / Occupation</span>
              <input type="text" value={role} onChange={(e) => setRole(e.target.value)} required />
            </label>
          </div>

          <div className="form-grid">
            <label className="form-field">
              <span>Primary Tech Stack</span>
              <input type="text" value={stack} onChange={(e) => setStack(e.target.value)} placeholder="e.g. React, Python, Docker" />
            </label>
            <label className="form-field">
              <span>Preferred Response Tone</span>
              <select value={tone} onChange={(e) => setTone(e.target.value)}>
                <option value="Balanced & Helpful">Balanced & Helpful</option>
                <option value="Concise & Direct">Concise & Direct (No fluff)</option>
                <option value="Academic & In-Depth">Academic & In-Depth</option>
                <option value="Strict Code & Architecture">Strict Code & Architecture</option>
              </select>
            </label>
          </div>

          <label className="form-field">
            <span>Global System Instructions & Guidelines</span>
            <textarea
              rows={4}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Always use TypeScript strict mode. Prefer modular functions over classes."
            />
          </label>

          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? 'Saving...' : 'Save Profile'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
