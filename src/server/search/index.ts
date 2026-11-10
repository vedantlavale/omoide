/**
 * webSearch() — the agent's single tool.
 *
 * The model sees a small, flat schema. Behind it: fan-out across two indexes,
 * fusion, dedupe, page fetch, passage selection, persistence, and a citation
 * registry that keeps ids stable for the whole turn.
 *
 * Everything here is also called by the orchestrator *before* the model runs,
 * which is why it is a plain function and not a tool-shaped special case.
 */

import { createHash } from 'node:crypto';
import { getConfig } from '../config';
import type { EvidenceSource, TimeContext } from '../types';
import { cacheGet, cacheKey, cacheSet, ttlFor } from './cache';
import { isOpen, recordFailure, recordSuccess } from './breaker';
import { canonicalizeUrl, siteOf } from './canonical';
import { selectPassages } from './extract';
import { takeToken } from './limiter';
import { rankResults, type RawResult } from './rank';
import { exa } from './providers/exa';
import { mockProvider } from './providers/mock';
import { tavily } from './providers/tavily';
import { tinyfish } from './providers/tinyfish';
import type { FetchedPage, SearchProvider } from './providers/types';
import type { Freshness } from '../types';
import { getDb } from '../db/client';

export interface WebSearchParams {
  queries: string[];
  freshness?: Freshness;
  after_date?: string | null;
  news?: boolean;
  site?: string | null;
}

export interface WebSearchMeta {
  queries: string[];
  providers: string[];
  cacheHits: number;
  fetched: number;
  snippetOnly: number;
  errors: string[];
}

export interface WebSearchResult {
  sources: EvidenceSource[];
  meta: WebSearchMeta;
}

const MAX_SOURCES = 5;

export function primaryProviders(): SearchProvider[] {
  const c = getConfig();
  if (c.mock) return [mockProvider];
  const out: SearchProvider[] = [];
  if (c.search.tinyfish) out.push(tinyfish);
  if (c.search.exa) out.push(exa);
  return out;
}

export function fetchProvider(): SearchProvider | null {
  const c = getConfig();
  if (c.mock) return mockProvider;
  if (c.search.tinyfish) return tinyfish;
  if (c.search.exa) return exa;
  return null;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** Stable citation ids for a single turn. Same URL always gets the same id. */
export class SourceRegistry {
  private byCanonical = new Map<string, EvidenceSource>();
  private nextId = 1;

  add(input: Omit<EvidenceSource, 'id' | 'canonicalUrl'> & { canonicalUrl: string }): EvidenceSource {
    const existing = this.byCanonical.get(input.canonicalUrl);
    if (existing) {
      // Merge new passages, keep the id stable.
      for (const p of input.passages) if (!existing.passages.includes(p)) existing.passages.push(p);
      return existing;
    }
    const source: EvidenceSource = { ...input, id: `S${this.nextId++}` };
    this.byCanonical.set(input.canonicalUrl, source);
    return source;
  }

  all(): EvidenceSource[] {
    return [...this.byCanonical.values()].sort(
      (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
    );
  }

  get(id: string): EvidenceSource | undefined {
    return this.all().find((s) => s.id === id);
  }
}

async function searchOne(
  provider: SearchProvider,
  query: string,
  params: WebSearchParams,
  meta: WebSearchMeta,
): Promise<RawResult[]> {
  const cacheParams = {
    freshness: params.freshness ?? 'any',
    after: params.after_date ?? null,
    news: Boolean(params.news),
    site: params.site ?? null,
  };
  const key = cacheKey(provider.name, query, cacheParams);
  const cached = await cacheGet<RawResult[]>(key);
  if (cached) {
    meta.cacheHits++;
    return cached;
  }

  if (isOpen(provider.name)) return [];
  try {
    await takeToken(provider.name);
    const results = await provider.search({
      query,
      freshness: params.freshness ?? 'any',
      afterDate: params.after_date ?? null,
      news: params.news,
      site: params.site,
    });
    recordSuccess(provider.name);
    if (!meta.providers.includes(provider.name)) meta.providers.push(provider.name);
    await cacheSet(key, provider.name, results, ttlFor(params.freshness ?? 'any', Boolean(params.news)));
    return results;
  } catch (err) {
    recordFailure(provider.name);
    meta.errors.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function fetchPages(urls: string[], timeoutMs: number): Promise<Map<string, FetchedPage>> {
  const out = new Map<string, FetchedPage>();
  const provider = fetchProvider();
  if (!provider?.fetchPages || !urls.length) return out;

  try {
    const pages = await provider.fetchPages(urls, { timeoutMs, ttlSeconds: 21_600 });
    for (const p of pages) {
      const canonical = canonicalizeUrl(p.url);
      if (canonical) out.set(canonical, p);
    }
  } catch {
    // Fall back to the other reader before giving up on page text.
    const alternate = provider.name === 'tinyfish' && getConfig().search.exa ? exa : null;
    if (alternate?.fetchPages) {
      try {
        const pages = await alternate.fetchPages(urls, { timeoutMs });
        for (const p of pages) {
          const canonical = canonicalizeUrl(p.url);
          if (canonical) out.set(canonical, p);
        }
      } catch {
        /* snippet-only it is */
      }
    }
  }
  return out;
}

async function persistSource(source: EvidenceSource, markdown: string | null): Promise<void> {
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO sources (canonical_url, url, title, site, published_at, last_fetched_at, content_hash, etag, last_modified, snapshot)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9)
       ON CONFLICT (canonical_url) DO UPDATE SET
         title = EXCLUDED.title,
         last_fetched_at = EXCLUDED.last_fetched_at,
         content_hash = EXCLUDED.content_hash,
         etag = COALESCE(EXCLUDED.etag, sources.etag),
         last_modified = COALESCE(EXCLUDED.last_modified, sources.last_modified),
         snapshot = COALESCE(EXCLUDED.snapshot, sources.snapshot)`,
      [
        source.canonicalUrl,
        source.url,
        source.title,
        source.site,
        source.publishedAt ?? null,
        source.contentHash ?? null,
        source.etag ?? null,
        source.lastModified ?? null,
        markdown ? markdown.slice(0, 50_000) : null,
      ],
    );
  } catch {
    /* persistence must not break an answer */
  }
}

export async function webSearch(
  params: WebSearchParams,
  ctx: { registry: SourceRegistry; time: TimeContext; maxSources?: number },
): Promise<WebSearchResult> {
  const meta: WebSearchMeta = {
    queries: [],
    providers: [],
    cacheHits: 0,
    fetched: 0,
    snippetOnly: 0,
    errors: [],
  };

  const queries = [...new Set((params.queries ?? []).map((q) => q.trim()).filter(Boolean))].slice(0, 4);
  meta.queries = queries;
  if (!queries.length) return { sources: [], meta };

  const providers = primaryProviders();
  if (!providers.length) {
    meta.errors.push('no search provider configured');
    return { sources: [], meta };
  }

  const settled = await Promise.allSettled(
    providers.flatMap((p) => queries.map((q) => searchOne(p, q, params, meta))),
  );

  let lists = settled
    .filter((s): s is PromiseFulfilledResult<RawResult[]> => s.status === 'fulfilled')
    .map((s) => s.value);
  let all = lists.flat();

  // Tavily only when the primary indexes came back empty.
  if (!all.length && getConfig().search.tavily) {
    const fallback = await Promise.allSettled(
      queries.map((q) => searchOne(tavily, q, params, meta)),
    );
    lists = fallback
      .filter((s): s is PromiseFulfilledResult<RawResult[]> => s.status === 'fulfilled')
      .map((s) => s.value);
    all = lists.flat();
  }

  if (!all.length) return { sources: [], meta };

  const ranked = rankResults(lists, {
    freshness: params.freshness ?? 'any',
    queryText: queries.join(' '),
    entities: [],
    now: ctx.time.now.getTime(),
  }).slice(0, ctx.maxSources ?? MAX_SOURCES);

  if (!ranked.length) return { sources: [], meta };

  const pages = await fetchPages(
    ranked.map((r) => r.url),
    8000,
  );
  meta.fetched = pages.size;

  const queryText = queries.join(' ');
  const sources: EvidenceSource[] = [];

  for (const result of ranked) {
    const page = pages.get(result.canonicalUrl);
    const markdown = page?.markdown?.trim() ? page.markdown : null;
    const snippetOnly = !markdown;
    if (snippetOnly) meta.snippetOnly++;

    const body = markdown ?? result.snippet;
    const passages = selectPassages(body, queryText);
    if (!passages.length && !result.snippet) continue;

    const partial = {
      canonicalUrl: result.canonicalUrl,
      url: page?.url ?? result.url,
      title: page?.title || result.title,
      site: result.site,
      publishedAt: result.publishedAt,
      fetchedAt: new Date().toISOString(),
      passages: passages.length ? passages : [result.snippet.slice(0, 400)],
      snippetOnly,
      contentHash: markdown ? contentHash(markdown) : null,
      etag: page?.etag ?? null,
      lastModified: page?.lastModified ?? null,
    };

    const source = ctx.registry.add(partial);
    sources.push(source);
    await persistSource(source, markdown);
  }

  return { sources, meta };
}

/**
 * Fetch one page, optionally conditionally. Used by the re-check engine:
 * a 304 or an identical content hash means "nothing changed", with no model
 * call at all.
 */
export async function fetchPage(
  url: string,
  opts: { ifNoneMatch?: string | null; ifModifiedSince?: string | null } = {},
): Promise<FetchedPage | null> {
  const provider = fetchProvider();
  if (!provider?.fetchPages) return null;
  try {
    const [page] = await provider.fetchPages([url], {
      timeoutMs: 10_000,
      ttlSeconds: 0,
      ifNoneMatch: opts.ifNoneMatch,
      ifModifiedSince: opts.ifModifiedSince,
    });
    return page ?? null;
  } catch {
    return null;
  }
}

export function formatEvidence(sources: EvidenceSource[]): string {
  return sources
    .map((s) => {
      const date = s.publishedAt ? ` published="${s.publishedAt}"` : '';
      const body = s.passages.map((p) => `  <passage>${p.replace(/\s+/g, ' ')}</passage>`).join('\n');
      return `<source id="${s.id}" url="${s.url}" site="${siteOf(s.url)}"${date}${s.snippetOnly ? ' snippet-only="true"' : ''}>\n  <title>${s.title}</title>\n${body}\n</source>`;
    })
    .join('\n\n');
}
