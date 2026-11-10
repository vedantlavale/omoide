/**
 * TinyFish: primary search + page fetch.
 *
 * Their endpoint is unusually useful for this app because the *fetch* API
 * supports conditional requests (ETag / Last-Modified), which is what makes
 * "has this page changed since 3 November?" cheap and exact.
 */

import { getConfig } from '../../config';
import type { RawResult } from '../rank';
import { pickArray, pickString, type FetchedPage, type FetchOptions, type ProviderSearchArgs, type SearchProvider } from './types';

const SEARCH_URL = 'https://api.search.tinyfish.ai';
const FETCH_URL = 'https://api.fetch.tinyfish.ai';

function key(): string {
  const k = getConfig().search.tinyfish;
  if (!k) throw new Error('TINYFISH_API_KEY is not set');
  return k;
}

function recencyMinutes(freshness: ProviderSearchArgs['freshness']): number | null {
  switch (freshness) {
    case 'day':
      return 60 * 24;
    case 'week':
      return 60 * 24 * 7;
    case 'month':
      return 60 * 24 * 31;
    default:
      return null;
  }
}

export const tinyfish: SearchProvider = {
  name: 'tinyfish',

  async search(args: ProviderSearchArgs): Promise<RawResult[]> {
    const params = new URLSearchParams({ query: args.query });
    if (args.afterDate) params.set('after_date', args.afterDate);
    if (args.news) params.set('domain_type', 'news');
    const recency = recencyMinutes(args.freshness);
    if (recency) params.set('recency_minutes', String(recency));
    if (args.site) params.set('include_domains', args.site);

    const res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
      headers: { 'X-API-Key': key(), accept: 'application/json' },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) throw new Error(`tinyfish search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();

    return pickArray(json)
      .map((raw): RawResult | null => {
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Record<string, unknown>;
        const url = pickString(r, ['url', 'link', 'href']);
        if (!url) return null;
        return {
          url,
          title: pickString(r, ['title', 'name', 'headline']),
          snippet: pickString(r, ['snippet', 'description', 'text', 'content', 'summary']).slice(0, 800),
          publishedAt: pickString(r, ['published_at', 'publishedAt', 'date', 'published_date']) || null,
          provider: 'tinyfish',
        };
      })
      .filter((r): r is RawResult => Boolean(r));
  },

  async fetchPages(urls: string[], opts: FetchOptions = {}): Promise<FetchedPage[]> {
    if (!urls.length) return [];
    const body: Record<string, unknown> = {
      urls: urls.slice(0, 10),
      format: 'markdown',
      include_etag_and_last_modified: true,
      ttl: opts.ttlSeconds ?? 21_600,
    };
    if (opts.ifNoneMatch) body.if_none_match = opts.ifNoneMatch;
    if (opts.ifModifiedSince) body.if_modified_since = opts.ifModifiedSince;

    const res = await fetch(FETCH_URL, {
      method: 'POST',
      headers: { 'X-API-Key': key(), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    });
    if (!res.ok) throw new Error(`tinyfish fetch ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();

    return pickArray(json)
      .map((raw): FetchedPage | null => {
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Record<string, unknown>;
        const url = pickString(r, ['url', 'requested_url', 'final_url']);
        if (!url) return null;
        const notModified = Boolean(r.not_modified ?? r.notModified ?? r.status === 304);
        const markdown = pickString(r, ['markdown', 'text', 'content', 'body']);
        return {
          url,
          markdown,
          title: pickString(r, ['title']) || null,
          etag: pickString(r, ['etag', 'ETag']) || null,
          lastModified: pickString(r, ['last_modified', 'lastModified']) || null,
          notModified,
          error: pickString(r, ['error']) || undefined,
        };
      })
      .filter((p): p is FetchedPage => Boolean(p));
  },
};
