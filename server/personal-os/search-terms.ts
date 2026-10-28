// Keyword scoring still used by the raw-history recall in agents.ts (which the memory redesign removes) and by
// consolidation's choice of related observations. Memory and archive retrieval uses retrieval-index.ts instead.
export function searchTerms(query: string) {
  const q = query.toLocaleLowerCase();
  const terms = new Set(q.match(/[a-z0-9_.-]{2,}|[㐀-鿿]{2,}/g) ?? []);
  // Snapshot original terms: this loop adds derived bigrams to the same Set.
  // eslint-disable-next-line unicorn/no-useless-spread
  for (const term of [...terms]) if (/[㐀-鿿]/.test(term)) for (let i = 0; i < term.length - 1; i++) terms.add(term.slice(i, i + 2));
  return [...terms];
}
export function relevance(query: string, value: string) {
  const s = value.toLocaleLowerCase();
  return searchTerms(query).reduce((sum, term) => sum + (s.includes(term) ? Math.min(8, term.length) : 0), 0);
}
