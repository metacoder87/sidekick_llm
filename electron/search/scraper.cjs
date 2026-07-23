const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function extractMainText(html) {
  if (!html) return '';

  // Remove script, style, noscript, header, nav, footer, svg tags
  let cleaned = html.replace(/<(script|style|noscript|header|nav|footer|svg|iframe)[\s\S]*?<\/\1>/gi, ' ');

  // Replace block elements with linebreaks
  cleaned = cleaned.replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n');

  // Strip remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  // Decode common entities
  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Normalize whitespace and collapse excess newlines
  const lines = cleaned
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length > 25); // Ignore navigation remnants / tiny fragments

  return lines.join('\n\n');
}

async function scrapePage(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return null;
    }

    const html = await response.text();
    const text = extractMainText(html);
    return text.slice(0, 2000); // Truncate per page to fit context window
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function scrapeTopResults(results, maxPages = 3) {
  const scraped = [];
  const targetResults = results.slice(0, maxPages);

  const fetchPromises = targetResults.map(async (res) => {
    const text = await scrapePage(res.url);
    return {
      title: res.title,
      url: res.url,
      snippet: res.snippet,
      content: text || res.snippet || '',
    };
  });

  const settled = await Promise.allSettled(fetchPromises);
  for (const item of settled) {
    if (item.status === 'fulfilled' && item.value) {
      scraped.push(item.value);
    }
  }

  return scraped;
}

module.exports = {
  extractMainText,
  scrapePage,
  scrapeTopResults,
};
