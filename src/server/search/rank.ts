/**
 * Result ranking.
 *
 * Two independent search indexes (TinyFish, Exa) are fused with Reciprocal Rank
 * Fusion: each result scores 1/(60+rank) per query it appeared in. RRF is
 * cheap, has no weights to tune, and is robust to providers scoring on
 * different scales. On top of that we apply a few explicit, explainable boosts:
 * the vendor's own pricing page beats a listicle, fresher beats older, and
 * content farms are demoted.
 */

import type { Freshness } from '../types';
import { canonicalizeUrl, domainMatchesEntity, isLowTrust, siteOf } from './canonical';

export interface RawResult {
  url: string;
  title: string;
  snippet: string;
  publishedAt?: string | null;
  provider: string;
}

export interface RankedResult {
  canonicalUrl: string;
  url: string;
  title: string;
  snippet: string;
  site: string;
  publishedAt: string | null;
  providers: string[];
  score: number;
}

const FRESHNESS_MS: Record<Exclude<Freshness, 'any'>, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 31 * 86_400_000,
  year: 366 * 86_400_000,
};

function freshnessWindow(f: Freshness): number {
  return f === 'any' ? Number.POSITIVE_INFINITY : FRESHNESS_MS[f];
}

export function rankResults(
  lists: RawResult[][],
  opts: {
    entities?: string[];
    freshness?: Freshness;
    queryText?: string;
    now?: number;
  } = {},
): RankedResult[] {
  const merged = new Map<string, RankedResult>();

  lists.forEach((list) => {
    list.forEach((r, index) => {
      const canonicalUrl = canonicalizeUrl(r.url);
      if (!canonicalUrl) return;
      const existing = merged.get(canonicalUrl);
      const rrf = 1 / (60 + index);
      if (existing) {
        existing.score += rrf;
        if (!existing.providers.includes(r.provider)) existing.providers.push(r.provider);
        if (r.snippet.length > existing.snippet.length) existing.snippet = r.snippet;
        if (!existing.publishedAt && r.publishedAt) existing.publishedAt = r.publishedAt;
      } else {
        merged.set(canonicalUrl, {
          canonicalUrl,
          url: r.url,
          title: r.title || siteOf(r.url),
          snippet: r.snippet ?? '',
          site: siteOf(canonicalUrl),
          publishedAt: r.publishedAt ?? null,
          providers: [r.provider],
          score: rrf,
        });
      }
    });
  });

  const now = opts.now ?? Date.now();
  const window = freshnessWindow(opts.freshness ?? 'any');
  const queryText = (opts.queryText ?? '').toLowerCase();
  const priceIntent = /price|pricing|cost|plan|tier|per month|\/mo|pcm/.test(queryText);
  const changeIntent = /change|new|launch|shipped|release|update|changelog|announce/.test(queryText);

  for (const r of merged.values()) {
    let multiplier = 1;

    for (const entity of opts.entities ?? []) {
      if (domainMatchesEntity(r.canonicalUrl, entity)) {
        multiplier *= 1.6;
        break;
      }
    }

    if (isLowTrust(r.canonicalUrl)) multiplier *= 0.35;

    if (r.publishedAt) {
      const age = now - new Date(r.publishedAt).getTime();
      if (Number.isFinite(age)) {
        if (age <= window) multiplier *= 1.25;
        else if (window !== Number.POSITIVE_INFINITY) multiplier *= 0.8;
        if (age < 0) multiplier *= 0.5; // bad metadata, not "fresh"
      }
    }

    const path = r.canonicalUrl.toLowerCase();
    if (priceIntent && /(pricing|plans|price)/.test(path)) multiplier *= 1.3;
    if (changeIntent && /(changelog|release-notes|releases|whats-new|blog)/.test(path)) multiplier *= 1.2;

    r.score *= multiplier;
  }

  return [...merged.values()].sort((a, b) => b.score - a.score);
}
