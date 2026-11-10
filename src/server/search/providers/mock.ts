/**
 * Deterministic offline provider. Selected only when MOCK=1.
 * Same interface as the real providers, so every layer above it is unchanged.
 */

import { canonicalizeUrl } from '../canonical';
import { tokenize } from '../extract';
import { MOCK_DOCS } from '../mock-data';
import type { RawResult } from '../rank';
import type { FetchedPage, FetchOptions, ProviderSearchArgs, SearchProvider } from './types';

/**
 * Fixture retrieval. It is deliberately simple, but it mirrors the shape of a
 * real index: title matches dominate, domain synonyms expand the query
 * ("CRM" should find HubSpot), and results below half the top score are noise.
 */
const SYNONYMS: Record<string, string[]> = {
  crm: ['crm', 'hubspot', 'salesforce', 'pipedrive', 'zoho', 'close', 'sales'],
  postgres: ['postgres', 'postgresql', 'neon', 'supabase', 'rds', 'render', 'railway'],
  hosting: ['hosting', 'postgres', 'neon', 'supabase', 'rds', 'render', 'railway'],
  nextjs: ['nextjs', 'next', 'vercel', 'react'],
};

function expanded(query: string): Set<string> {
  const q = new Set(tokenize(query));
  for (const token of [...q]) {
    const singular = token.endsWith('s') ? token.slice(0, -1) : token;
    for (const extra of [...(SYNONYMS[token] ?? []), ...(SYNONYMS[singular] ?? [])]) q.add(extra);
  }
  return q;
}

/** Words that appear on every vendor page and therefore identify nothing. */
const GENERIC = new Set([
  'pricing','price','plan','plans','cost','compare','comparison','change','changed','latest','version',
  'news','update','small','app','team','tools','best','much','many','about','their','enterprise','seat',
  'user','users','month','monthly','free','paid','per',
]);

function score(query: string, doc: (typeof MOCK_DOCS)[number]): number {
  const q = expanded(query);
  const meaningful = [...q].filter((t) => !GENERIC.has(t));
  const tokens = meaningful.length ? new Set(meaningful) : q;
  const title = tokenize(doc.title);
  const text = tokenize(doc.content);
  let hits = 0;
  for (const t of title) if (tokens.has(t)) hits += 3;
  for (const t of text) if (tokens.has(t)) hits += 1;
  return hits;
}

export const mockProvider: SearchProvider = {
  name: 'mock',

  async search(args: ProviderSearchArgs): Promise<RawResult[]> {
    let docs = [...MOCK_DOCS];
    if (args.site) docs = docs.filter((d) => d.url.includes(args.site!));
    if (args.afterDate) docs = docs.filter((d) => d.publishedAt >= args.afterDate!);

    const scored = docs
      .map((d) => ({ doc: d, score: score(args.query, d) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    const top = scored[0]?.score ?? 0;
    const relevant = scored.filter((s) => s.score >= Math.max(2, top * 0.5));

    const chosen = relevant.length
      ? relevant.slice(0, args.num ?? 6)
      : scored.slice(0, 3);
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
