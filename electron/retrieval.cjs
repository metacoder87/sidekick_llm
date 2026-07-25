// Retrieval helpers shared by the message pipeline. Pure and side-effect-free so
// the ranking logic is unit-testable without a database or Ollama.

// Given per-expert match groups, flatten and globally rank by similarity score,
// returning the single best `limit` chunks across ALL consulted vaults. This stops
// a large panel (N experts × top-k each) from flooding the prompt with weak chunks:
// the strongest knowledge wins regardless of which expert produced it (ROADMAP
// Stage 2 — reranking / federated retrieval v2).
//
// groups: [{ expert: { id, name }, matches: [{ sourceTitle, chunkText, score, ... }] }]
// returns: [{ expertId, expertName, sourceTitle, chunkText, score }] length ≤ limit
function selectTopMatches(groups, limit = 6) {
  const flat = [];
  for (const group of groups || []) {
    const expert = group.expert || {};
    for (const match of group.matches || []) {
      flat.push({
        expertId: expert.id,
        expertName: expert.name,
        sourceTitle: match.sourceTitle,
        chunkText: match.chunkText,
        // Citation provenance travels with the chunk so source cards stay precise.
        sourceUrl: match.sourceUrl || '',
        location: match.location ?? null,
        page: match.page ?? null,
        charStart: match.charStart ?? null,
        charEnd: match.charEnd ?? null,
        sourceType: match.sourceType ?? null,
        score: typeof match.score === 'number' ? match.score : 0,
      });
    }
  }
  flat.sort((a, b) => b.score - a.score);
  return flat.slice(0, limit);
}

// Reciprocal Rank Fusion of a vector ranking and a lexical (BM25) ranking for one
// vault. RRF is the standard way to combine rankings whose scores aren't comparable
// (cosine similarity vs. BM25): each list contributes 1/(k + rank), so a chunk that
// ranks decently in BOTH beats one that ranks highly in only one. This is what makes
// hybrid retrieval better than either half — embeddings catch paraphrase, BM25
// catches exact terms (clause numbers, drug names, symbols).
//
// Returns fused matches carrying the vector `score` when known (so downstream
// reranking/threshold logic still works), ordered best-first.
const RRF_K = 60;

function fuseHybrid(vectorMatches = [], keywordMatches = [], limit = 8) {
  const byId = new Map();
  const fused = new Map();

  const keyFor = (m, index, prefix) => m.chunkId || `${prefix}:${m.sourceTitle || ''}:${index}`;

  vectorMatches.forEach((match, index) => {
    const key = keyFor(match, index, 'v');
    byId.set(key, match);
    fused.set(key, (fused.get(key) || 0) + 1 / (RRF_K + index + 1));
  });

  keywordMatches.forEach((match, index) => {
    const key = keyFor(match, index, 'k');
    if (!byId.has(key)) byId.set(key, match);
    fused.set(key, (fused.get(key) || 0) + 1 / (RRF_K + index + 1));
  });

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, rrf]) => {
      const match = byId.get(key);
      return {
        ...match,
        rrf,
        // Keep a usable similarity score for the cross-vault reranker: prefer the
        // real cosine score; fall back to the RRF weight for keyword-only hits.
        score: typeof match.score === 'number' ? match.score : rrf,
      };
    });
}

// Count how many of the selected chunks each expert contributed, keyed by expertId.
function contributionByExpert(selected) {
  const counts = new Map();
  for (const item of selected || []) {
    counts.set(item.expertId, (counts.get(item.expertId) || 0) + 1);
  }
  return counts;
}

module.exports = { selectTopMatches, contributionByExpert, fuseHybrid };
