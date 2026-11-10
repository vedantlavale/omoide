/**
 * Exa: semantic search and the fallback page reader.
 *
 * Exa's index is neural rather than keyword-based, so it catches paraphrases
 * TinyFish misses ("database hosting" ↔ "Postgres providers"). It also returns
 * page text inline, which makes it a good second fetch path when TinyFish is
 * down.
 */

import { getConfig } from '../../config';
import type { RawResult } from '../rank';
import { pickArray, pickString, type FetchedPage, type FetchOptions, type ProviderSearchArgs, type SearchProvider } from './types';

const SEARCH_URL = 'https://api.exa.ai/search';
const CONTENTS_URL = 'https://api.exa.ai/contents';

function key(): string {
  const k = getConfig().search.exa;
  if (!k) throw new Error('EXA_API_KEY is not set');
  return k;
}

function startDateFor(args: ProviderSearchArgs, now = new Date()): string | null {
  if (args.afterDate) return args.afterDate;
  const days = args.freshness === 'day' ? 1 : args.freshness === 'week' ? 7 : args.freshness === 'month' ? 31 : 0;
  if (!days) return null;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export const exa: SearchProvider = {
  name: 'exa',

  async search(args: ProviderSearchArgs): Promise<RawResult[]> {
    const body: Record<string, unknown> = {
      query: args.query,
      numResults: Math.min(args.num ?? 8, 10),
      type: 'auto',
      contents: { text: { maxCharacters: 6000 } },
    };
    const start = startDateFor(args);
    if (start) body.startPublishedDate = start;
    if (args.news) body.category = 'news';
    if (args.site) body.includeDomains = [args.site];

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'x-api-key': key(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) throw new Error(`exa search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();

    return pickArray(json)
      .map((raw): RawResult | null => {
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Record<string, unknown>;
        const url = pickString(r, ['url', 'id']);
        if (!url) return null;
        return {
          url,
          title: pickString(r, ['title']),
          snippet: pickString(r, ['summary', 'text', 'snippet', 'highlights']).slice(0, 3000),
          publishedAt: pickString(r, ['publishedDate', 'published_at', 'published']) || null,
          provider: 'exa',
        };
      })
      .filter((r): r is RawResult => Boolean(r));
  },

  async fetchPages(urls: string[], opts: FetchOptions = {}): Promise<FetchedPage[]> {
    if (!urls.length) return [];
    const res = await fetch(CONTENTS_URL, {
      method: 'POST',
      headers: { 'x-api-key': key(), 'content-type': 'application/json' },
      body: JSON.stringify({ urls: urls.slice(0, 10), text: { maxCharacters: 20_000 } }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    });
    if (!res.ok) throw new Error(`exa contents ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return pickArray(json)
      .map((raw): FetchedPage | null => {
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Record<string, unknown>;
        const url = pickString(r, ['url', 'id']);
        if (!url) return null;
        return {
          url,
          markdown: pickString(r, ['text', 'content']),
          title: pickString(r, ['title']) || null,
          error: pickString(r, ['error']) || undefined,
        };
      })
      .filter((p): p is FetchedPage => Boolean(p));
  },
};
