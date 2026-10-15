/**
 * A search that feeds an AI follow-up and nothing else.
 * It does not change the result list on the page and it is not indexed.
 */
import { getProvidersForPrivacy } from '@/lib/providers/registry';
import { applyHardConstraints } from '@/lib/queryEngine';
import { parseQuery } from '@/lib/queryParser';
import { sortByQueryRelevance } from '@/lib/resultRank';
import type { SearchResult } from '@/lib/providers/types';

export async function runSideSearch(opts: {
  query: string;
  disabledProviders: string[];
  privacyMode: boolean;
  languages: string[];
  signal?: AbortSignal;
}): Promise<SearchResult[]> {
  const query = opts.query.trim();
  if (!query) return [];

  let providers = getProvidersForPrivacy('web', opts.privacyMode);
  if (opts.disabledProviders.length > 0) {
    providers = providers.filter((p) => !opts.disabledProviders.includes(p.id));
  }
  const parsed = parseQuery(query);
  const settled = await Promise.allSettled(
    providers.map((provider) => provider.search({
      query,
      signal: opts.signal,
      languages: opts.languages,
      parsed,
    })),
  );

  const merged: SearchResult[] = [];
  for (const item of settled) {
    if (item.status === 'fulfilled') merged.push(...item.value.results);
  }

  const byUrl = new Map<string, SearchResult>();
  for (const result of merged) {
    const key = result.url || result.id;
    const prev = byUrl.get(key);
    if (!prev || (result.score ?? 0) > (prev.score ?? 0)) byUrl.set(key, result);
  }

  const constrained = applyHardConstraints([...byUrl.values()], parsed);
  return sortByQueryRelevance(constrained, query).slice(0, 8);
}
