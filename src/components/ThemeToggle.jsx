export default function ThemeToggle({ theme, onToggle }) {
  const isCyberpunk = theme === 'cyberpunk';

  return (
    <button
      type="button"
      className={`theme-toggle-btn ${isCyberpunk ? 'mode-cyberpunk' : 'mode-professional'}`}
      onClick={() => onToggle(isCyberpunk ? 'professional' : 'cyberpunk')}
      title={
        isCyberpunk
          ? 'Switch to Suit & Tie Professional Light Mode'
          : 'Switch to Cyberpunk Neon Dark Mode'
      }
    >
      {isCyberpunk ? (
        <span className="white-square-icon" />
      ) : (
        <span className="black-hole-circle" />
      )}
    </button>
  );
}
