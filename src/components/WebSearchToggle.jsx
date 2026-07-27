export default function WebSearchToggle({ enabled, onToggle, disabled }) {
  return (
    <button
      type="button"
      className={`search-toggle-button ${enabled ? 'active' : ''}`}
      onClick={() => onToggle(!enabled)}
      disabled={disabled}
      title={
        enabled
          ? 'Web Search Grounding ON (Real-time internet search active)'
          : 'Web Search Grounding OFF (Offline mode)'
      }
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <span>Web Search {enabled ? 'ON' : 'OFF'}</span>
    </button>
  );
}
