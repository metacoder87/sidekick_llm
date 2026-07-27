// Different questions need different retrieval strategies. Top-k similarity answers
// "what does the contract say about liability?" but fails on:
//   * aggregation  — "what does this Expert say about X overall?" (top-k ≠ a survey)
//   * multi-hop    — "does this lab result relate to the medication I was prescribed?"
//   * contradiction— "is there anything here that conflicts with what I was told?"
//                    (a contradiction is semantically SIMILAR to what it contradicts,
//                     so plain similarity buries it among agreeing passages)
//
// This module classifies the question and expands it into the set of retrieval
// queries that strategy needs. Classification is heuristic (fast, deterministic,
// testable); expansion optionally uses the background model.

// Stems use \w* rather than a closing \b so inflections match ("summarizing",
// "relates", "comparing"). Over-matching is cheap here — a wrongly-detected
// multihop just adds a sub-query — while under-matching silently loses the
// strategy, so these lean permissive by design.
const AGGREGATE_PATTERNS = [
  /\b(overall|in general|everything|all of|the gist)\b/i,
  /\b(summar|synthesi|overview|recap)\w*/i,
  /\bwhat does .* say about\b/i,
  /\bkey (points|takeaways|themes|findings)\b/i,
];

const MULTIHOP_PATTERNS = [
  /\b(relat|connect|interact|compar)\w*/i,
  /\b(versus|vs\.?)\b/i,
  /\b(both|together|combined)\b.*\band\b/i,
  /\bdoes .*\band\b.*\?/i,
];

// NOTE: no trailing \b on the verb stems — "contradicts", "conflicting" and
// "disagreement" must all match, and \b after the stem would reject the suffix.
const CONTRADICTION_PATTERNS = [
  /\b(contradict|conflict|inconsisten|disagree|discrepanc|dispute)\w*/i,
  /\bdoesn'?t (match|line up|agree)\b/i,
  /\bsecond opinion\b/i,
  /\b(is|are) (this|that|it|the\w*) \w*\s?(correct|right|accurate|true)\b/i,
  /\bwrong\b/i,
];

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

// Returns { type, aggregate, multihop, contradiction } — flags are not exclusive;
// `type` is the dominant strategy to drive control flow.
function classifyQuery(query) {
  const text = (query || '').trim();
  const aggregate = matchesAny(AGGREGATE_PATTERNS, text);
  const multihop = matchesAny(MULTIHOP_PATTERNS, text);
  const contradiction = matchesAny(CONTRADICTION_PATTERNS, text);

  let type = 'simple';
  if (aggregate) type = 'aggregate';
  else if (multihop) type = 'multihop';
  else if (contradiction) type = 'contradiction';

  return { type, aggregate, multihop, contradiction };
}

// Builds the list of queries to retrieve for. Always includes the original question
// so we never do worse than the simple path.
//  - multihop      → LLM splits into sub-questions, each retrieved separately
//  - contradiction → add probes phrased to surface OPPOSING evidence, which plain
//                    similarity to the original question would rank below agreement
async function planRetrievalQueries({ query, classification, ollama, model }) {
  const queries = [query];
  const cls = classification || classifyQuery(query);

  if (cls.multihop && model && ollama && typeof ollama.generateChatSync === 'function') {
    try {
      const out = await ollama.generateChatSync({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Split the user question into its independent factual sub-questions. Output ONLY a JSON array of 2-3 short question strings. No prose.',
          },
          { role: 'user', content: query },
        ],
      });
      const match = out && out.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          for (const sub of parsed) {
            if (typeof sub === 'string' && sub.trim() && sub.trim() !== query) {
              queries.push(sub.trim());
            }
          }
        }
      }
    } catch (_error) {
      // Fall through — the original query alone still retrieves.
    }
  }

  if (cls.contradiction) {
    // Retrieve for explicit disagreement/limitation framings. Cheap, no LLM needed,
    // and it pulls in the passages a "does this conflict?" question actually needs.
    queries.push(`evidence against ${query}`);
    queries.push(`limitations exceptions or contraindications relevant to ${query}`);
  }

  // De-duplicate while preserving order, and cap the fan-out.
  const seen = new Set();
  return queries
    .filter((q) => {
      const key = q.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

// Merge match lists retrieved for several queries, keeping each chunk once at its
// best observed score.
function unionMatches(matchLists) {
  const best = new Map();
  for (const list of matchLists || []) {
    for (const match of list || []) {
      const key =
        match.chunkId || `${match.sourceTitle || ''}:${(match.chunkText || '').slice(0, 60)}`;
      const existing = best.get(key);
      if (!existing || (match.score || 0) > (existing.score || 0)) {
        best.set(key, match);
      }
    }
  }
  return [...best.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
}

module.exports = { classifyQuery, planRetrievalQueries, unionMatches };
