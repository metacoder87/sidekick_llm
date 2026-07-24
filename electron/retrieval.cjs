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
        score: typeof match.score === 'number' ? match.score : 0,
      });
    }
  }
  flat.sort((a, b) => b.score - a.score);
  return flat.slice(0, limit);
}

// Count how many of the selected chunks each expert contributed, keyed by expertId.
function contributionByExpert(selected) {
  const counts = new Map();
  for (const item of selected || []) {
    counts.set(item.expertId, (counts.get(item.expertId) || 0) + 1);
  }
  return counts;
}

module.exports = { selectTopMatches, contributionByExpert };
