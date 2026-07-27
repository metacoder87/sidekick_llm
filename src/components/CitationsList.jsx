export default function CitationsList({ citations }) {
  if (!citations || citations.length === 0) {
    return null;
  }

  return (
    <div className="citations-container">
      <div className="citations-header">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span>Grounded Web Sources ({citations.length})</span>
      </div>

      <div className="citations-grid">
        {citations.map((cite) => (
          <a
            key={cite.id}
            href={cite.url}
            target="_blank"
            rel="noopener noreferrer"
            className="citation-card"
            title={`${cite.title}\n${cite.url}`}
          >
            <div className="citation-badge">[{cite.id}]</div>
            <div className="citation-content">
              <span className="citation-domain">{cite.domain}</span>
              <strong className="citation-title">{cite.title}</strong>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
