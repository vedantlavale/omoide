/**
 * Deterministic offline provider. Selected only when MOCK=1.
 * Same interface as the real providers, so every layer above it is unchanged.
 */

import { canonicalizeUrl } from '../canonical';
import { tokenize } from '../extract';
import { MOCK_DOCS } from '../mock-data';
import type { RawResult } from '../rank';
import type { FetchedPage, FetchOptions, ProviderSearchArgs, SearchProvider } from './types';

function score(query: string, doc: (typeof MOCK_DOCS)[number]): number {
  const q = new Set(tokenize(query));
  const text = tokenize(`${doc.title} ${doc.content}`);
  let hits = 0;
  for (const t of text) if (q.has(t)) hits++;
  return hits;
}

export const mockProvider: SearchProvider = {
  name: 'mock',

  async search(args: ProviderSearchArgs): Promise<RawResult[]> {
    let docs = [...MOCK_DOCS];
    if (args.site) docs = docs.filter((d) => d.url.includes(args.site!));
    const scored = docs
      .map((d) => ({ doc: d, score: score(args.query, d) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, args.num ?? 6);

    const chosen = scored.length ? scored : docs.slice(0, 3).map((doc) => ({ doc, score: 1 }));
    return chosen.map(({ doc }) => ({
      url: doc.url,
      title: doc.title,
      snippet: doc.content.replace(/\s+/g, ' ').slice(0, 400),
      publishedAt: doc.publishedAt,
      provider: 'mock',
    }));
  },

  async fetchPages(urls: string[], _opts: FetchOptions = {}): Promise<FetchedPage[]> {
    return urls.map((url) => {
      const canonical = canonicalizeUrl(url);
      const doc = MOCK_DOCS.find((d) => canonicalizeUrl(d.url) === canonical);
      if (!doc) return { url, markdown: '', error: 'not found in fixtures' };
      return {
        url: doc.url,
        markdown: doc.content,
        title: doc.title,
        etag: `mock-${doc.publishedAt}`,
        lastModified: doc.publishedAt,
      };
    });
  },
};
