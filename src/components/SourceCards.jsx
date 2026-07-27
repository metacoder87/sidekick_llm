import { useState } from 'react';
import { buildSourceLink, sourceDisplayName } from '../lib/citations';

// Renders the exact chunks that were given to the model, with expert, document,
// precise location, and a deep link that lands on the quoted text. These cards are
// built from the retrieved chunks — never parsed out of the model's prose — so what
// you see is verifiably what the answer was grounded in (ROADMAP invariant #1).
export default function SourceCards({ sources }) {
  const [expandedId, setExpandedId] = useState(null);

  if (!sources || sources.length === 0) {
    return null;
  }

  return (
    <div className="source-cards">
      <div className="source-cards__header">
        📎 Cited sources ({sources.length}) — click a quote to expand, or the location to open
      </div>

      {sources.map((source) => {
        const link = buildSourceLink(source);
        const isOpen = expandedId === source.id;
        const quote = source.quote || '';
        const preview = quote.length > 180 && !isOpen ? `${quote.slice(0, 180)}…` : quote;

        return (
          <div key={source.id} className="source-card">
            <div className="source-card__top">
              <span className="source-card__badge">[{source.id}]</span>
              <span className="source-card__expert">⚡ {source.expertName}</span>
              <span className="source-card__doc" title={source.sourceTitle}>
                {sourceDisplayName(source)}
              </span>
              {link.href ? (
                <a
                  className={`source-card__loc ${link.precise ? 'is-precise' : ''}`}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={
                    link.precise
                      ? 'Open the source at this exact passage'
                      : 'Open the source (exact position unavailable)'
                  }
                >
                  {link.label || 'open'} ↗
                </a>
              ) : source.location ? (
                <span className="source-card__loc">{source.location}</span>
              ) : null}
            </div>

            <blockquote
              className="source-card__quote"
              onClick={() => setExpandedId(isOpen ? null : source.id)}
            >
              “{preview}”
            </blockquote>
          </div>
        );
      })}
    </div>
  );
}
