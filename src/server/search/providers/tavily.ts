/**
 * Tavily: optional third-tier fallback. Only used when it is configured *and*
 * the other two providers failed or returned nothing.
 */

import { getConfig } from '../../config';
import type { RawResult } from '../rank';
import { pickArray, pickString, type ProviderSearchArgs, type SearchProvider } from './types';

const SEARCH_URL = 'https://api.tavily.com/search';

export const tavily: SearchProvider = {
  name: 'tavily',

  async search(args: ProviderSearchArgs): Promise<RawResult[]> {
    const k = getConfig().search.tavily;
    if (!k) return [];

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: args.query,
        max_results: Math.min(args.num ?? 6, 10),
        search_depth: 'basic',
        topic: args.news ? 'news' : 'general',
        ...(args.afterDate ? { start_date: args.afterDate } : {}),
      }),
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();

    return pickArray(json)
      .map((raw): RawResult | null => {
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Record<string, unknown>;
        const url = pickString(r, ['url']);
        if (!url) return null;
        return {
          url,
          title: pickString(r, ['title']),
          snippet: pickString(r, ['content', 'raw_content']).slice(0, 1500),
          publishedAt: pickString(r, ['published_date', 'publishedDate']) || null,
          provider: 'tavily',
        };
      })
      .filter((r): r is RawResult => Boolean(r));
  },
};
