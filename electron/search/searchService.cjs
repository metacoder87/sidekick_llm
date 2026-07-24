const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(encoded) {
  if (!encoded) return '';
  return encoded
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function searchDuckDuckGo(query, maxResults = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed with HTTP ${response.status}`);
  }

  const html = await response.text();
  const results = [];

  // Match result blocks in DuckDuckGo HTML
  const regex = /<a class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(html)) !== null && results.length < maxResults) {
    let rawUrl = match[1];
    const title = decodeHtmlEntities(cleanText(match[2]));
    const snippet = decodeHtmlEntities(cleanText(match[3]));

    // DuckDuckGo redirects through //duckduckgo.com/l/?uddg=...
    if (rawUrl.includes('uddg=')) {
      try {
        const parsed = new URL(rawUrl, 'https://duckduckgo.com');
        rawUrl = parsed.searchParams.get('uddg') || rawUrl;
      } catch (_e) {
        // Keep rawUrl
      }
    }

    if (rawUrl && title && !rawUrl.startsWith('/')) {
      results.push({
        title,
        url: rawUrl,
        snippet,
      });
    }
  }

  // Fallback regex if snippet structure differs slightly
  if (results.length === 0) {
    const linkRegex = /<a class="result__url"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(html)) !== null && results.length < maxResults) {
      let rawUrl = linkMatch[1];
      if (rawUrl.includes('uddg=')) {
        try {
          const parsed = new URL(rawUrl, 'https://duckduckgo.com');
          rawUrl = parsed.searchParams.get('uddg') || rawUrl;
        } catch (_e) {
          // Keep rawUrl
        }
      }
      if (rawUrl && !rawUrl.startsWith('/')) {
        results.push({
          title: cleanText(linkMatch[2]) || rawUrl,
          url: rawUrl,
          snippet: 'Result from DuckDuckGo search',
        });
      }
    }
  }

  return results;
}

// Wikipedia's search API is a stable JSON endpoint (no HTML scraping to break),
// which makes it a reliable last-resort fallback when the configured provider
// returns nothing or is rate-limiting.
async function searchWikipedia(query, maxResults = 5) {
  if (!query || !query.trim()) return [];
  const endpoint = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
  try {
    const response = await fetch(endpoint, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.query?.search || []).slice(0, maxResults).map((item) => ({
      title: item.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: decodeHtmlEntities(cleanText(item.snippet || '')),
    }));
  } catch (_e) {
    return [];
  }
}

async function searchSearXNG(query, baseUrl, maxResults = 5) {
  if (!baseUrl) {
    throw new Error('SearXNG URL is not configured.');
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const response = await fetch(endpoint, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`SearXNG returned status ${response.status}`);
  }

  const data = await response.json();
  const rawResults = data.results || [];
  return rawResults.slice(0, maxResults).map((r) => ({
    title: r.title || 'Untitled',
    url: r.url,
    snippet: r.content || r.snippet || '',
  }));
}

async function searchTavily(query, apiKey, maxResults = 5) {
  if (!apiKey) {
    throw new Error('Tavily API Key is not configured.');
  }

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily search returned status ${response.status}`);
  }

  const data = await response.json();
  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content || r.snippet || '',
  }));
}

async function searchBrave(query, apiKey, maxResults = 5) {
  if (!apiKey) {
    throw new Error('Brave Search API Key is not configured.');
  }

  const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const response = await fetch(endpoint, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey,
      'User-Agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search returned status ${response.status}`);
  }

  const data = await response.json();
  const webResults = data.web?.results || [];
  return webResults.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description || '',
  }));
}

// Runs the configured provider, then falls back so a single provider hiccup
// (rate-limit, markup change, missing key) never zeroes out a run. Never throws:
// returns [] only when every provider genuinely found nothing.
async function performWebSearch({ query, provider = 'duckduckgo', options = {} }) {
  if (!query || !query.trim()) {
    return [];
  }

  const cleanQuery = query.trim();
  const max = options.maxResults || 5;

  const runProvider = async (name) => {
    try {
      switch (name) {
        case 'searxng':
          return await searchSearXNG(cleanQuery, options.searxngUrl, max);
        case 'tavily':
          return await searchTavily(cleanQuery, options.tavilyApiKey, max);
        case 'brave':
          return await searchBrave(cleanQuery, options.braveApiKey, max);
        case 'duckduckgo':
        default:
          return await searchDuckDuckGo(cleanQuery, max);
      }
    } catch (_e) {
      return [];
    }
  };

  // 1. The user's configured provider.
  let results = await runProvider(provider.toLowerCase());

  // 2. DuckDuckGo as a keyless fallback (skip if it was already the primary).
  if (results.length === 0 && provider.toLowerCase() !== 'duckduckgo') {
    results = await runProvider('duckduckgo');
  }

  // 3. Wikipedia as a stable last resort so research always has something to work
  //    with rather than failing outright.
  if (results.length === 0) {
    results = await searchWikipedia(cleanQuery, max);
  }

  return results;
}

module.exports = {
  performWebSearch,
  searchDuckDuckGo,
  searchWikipedia,
  searchSearXNG,
  searchTavily,
  searchBrave,
};
