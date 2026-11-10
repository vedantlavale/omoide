/**
 * Search response cache, in Postgres (same table in PGlite and Neon).
 *
 * The cache is what makes a follow-up question feel instant and keeps us inside
 * free-tier allowances: the same query within the TTL is served from disk.
 * Freshness-sensitive queries (news, last-24h) get a much shorter TTL.
 */

import { createHash } from 'node:crypto';
import { getDb } from '../db/client';
import type { Freshness } from '../types';

/** Bump when provider normalisation or ranking semantics change. */
const CACHE_VERSION = 'v3';

export function cacheKey(provider: string, query: string, params: Record<string, unknown>): string {
  const normalised = JSON.stringify({
    q: query.trim().toLowerCase().replace(/\s+/g, ' '),
    p: Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .sort(([a], [b]) => a.localeCompare(b)),
  });
  return createHash('sha256').update(`${CACHE_VERSION}|${provider}|${normalised}`).digest('hex');
}

export function ttlFor(freshness: Freshness, news: boolean): number {
  if (news || freshness === 'day') return 10 * 60_000;
  if (freshness === 'week' || freshness === 'month') return 30 * 60_000;
  return 60 * 60_000;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const db = await getDb();
    const rows = await db.query<{ response: unknown }>(
      'SELECT response FROM search_cache WHERE key = $1 AND expires_at > now()',
      [key],
    );
    return rows.length ? (rows[0].response as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, provider: string, value: unknown, ttlMs: number): Promise<void> {
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO search_cache (key, provider, response, expires_at)
       VALUES ($1, $2, $3::jsonb, now() + ($4 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at`,
      [key, provider, JSON.stringify(value), String(ttlMs)],
    );
  } catch {
    // A cache write must never fail a user-facing turn.
  }
}

export async function pruneCache(): Promise<void> {
  try {
    const db = await getDb();
    await db.exec('DELETE FROM search_cache WHERE expires_at < now()');
  } catch {
    /* ignore */
  }
}
