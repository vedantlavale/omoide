import type { Freshness } from '../../types';
import type { RawResult } from '../rank';

export interface ProviderSearchArgs {
  query: string;
  freshness: Freshness;
  afterDate?: string | null;
  news?: boolean;
  site?: string | null;
  num?: number;
}

export interface FetchOptions {
  /** 0 = bypass the provider's own cache (used by re-checks). */
  ttlSeconds?: number;
  /** Conditional request validators, for "has this page changed?" */
  ifNoneMatch?: string | null;
  ifModifiedSince?: string | null;
  timeoutMs?: number;
}

export interface FetchedPage {
  url: string;
  markdown: string;
  title?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  notModified?: boolean;
  error?: string;
}

export interface SearchProvider {
  name: string;
  search(args: ProviderSearchArgs): Promise<RawResult[]>;
  fetchPages?(urls: string[], opts?: FetchOptions): Promise<FetchedPage[]>;
}

/** Providers differ in shape and rename fields; map defensively. */
export function pickArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;
  for (const key of ['results', 'data', 'items', 'organic_results', 'web', 'documents']) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      for (const nested of ['results', 'items', 'documents', 'web']) {
        const nv = (v as Record<string, unknown>)[nested];
        if (Array.isArray(nv)) return nv;
      }
    }
  }
  return [];
}

export function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}
