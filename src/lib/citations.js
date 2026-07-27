// Builds a deep link that lands the reader on the EXACT text a citation refers to,
// rather than just the document it came from (ROADMAP Stage 2 — precise verifiable
// citations). Pure so it can be unit-tested.

function words(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean);
}

// Chrome/Edge text fragments (`#:~:text=`) highlight and scroll to a quote. Long
// quotes match unreliably, so for anything sizeable we use the `start,end` form:
// the first few words and the last few words delimit the range.
export function buildTextFragment(quote) {
  const parts = words(quote);
  if (parts.length === 0) return '';

  if (parts.length <= 12) {
    return `#:~:text=${encodeURIComponent(parts.join(' '))}`;
  }

  const start = parts.slice(0, 6).join(' ');
  const end = parts.slice(-5).join(' ');
  return `#:~:text=${encodeURIComponent(start)},${encodeURIComponent(end)}`;
}

// Returns { href, label, precise } for a retrieved source chunk.
//  - web        → URL + text fragment (scrolls to and highlights the quote)
//  - local PDF  → file URL + #page=N (honored by Chrome/Adobe PDF viewers)
//  - otherwise  → the raw URL, or nothing linkable
export function buildSourceLink(source) {
  const url = (source && source.sourceUrl) || '';
  if (!url) {
    return { href: null, label: source?.location || null, precise: false };
  }

  const isFile = url.startsWith('file://');
  const isWeb = /^https?:\/\//i.test(url);

  if (isWeb) {
    const fragment = buildTextFragment(source.quote);
    return {
      href: fragment ? `${url}${fragment}` : url,
      label: source.location || 'web page',
      precise: Boolean(fragment),
    };
  }

  if (isFile) {
    const page = source.page;
    return {
      href: page ? `${url}#page=${page}` : url,
      label: source.location || (page ? `p. ${page}` : 'document'),
      precise: Boolean(page),
    };
  }

  return { href: url, label: source.location || null, precise: false };
}

// Short, readable host or filename for display on a card.
export function sourceDisplayName(source) {
  const url = (source && source.sourceUrl) || '';
  if (/^https?:\/\//i.test(url)) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_error) {
      return url;
    }
  }
  if (url.startsWith('file://')) {
    const decoded = decodeURIComponent(url.replace(/^file:\/\//, ''));
    return decoded.split('/').pop() || decoded;
  }
  return source?.sourceTitle || 'source';
}
