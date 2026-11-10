/**
 * recheck() — "is that still true?"
 *
 * The cheap path is the point. A claim points at a source URL; the source has
 * stored validators (ETag / Last-Modified / content hash). If the page has not
 * changed, every claim on it is unchanged and we spend zero model tokens.
 * Only when the page really changed do we ask a model which claims moved.
 *
 * "Couldn't confirm" is a distinct outcome from "changed". We never turn a
 * failed fetch into a price change.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from '../config';
import { generateJson } from '../llm/openrouter';
import { contentHash, fetchPage, webSearch, type SourceRegistry } from '../search';
import { getDb } from '../db/client';
import type { ChangeReport, ClaimCheck, ClaimStatus, StoredClaim, TimeContext } from '../types';

const Verdict = z.object({
  status: z.enum(['unchanged', 'changed', 'not_found']),
  newValue: z.string().nullable().optional(),
  newQuote: z.string().nullable().optional(),
});
const VerdictList = z.object({ results: z.array(Verdict) });

interface SourceValidators {
  content_hash: string | null;
  etag: string | null;
  last_modified: string | null;
}

async function validatorsFor(url: string): Promise<SourceValidators | null> {
  try {
    const db = await getDb();
    const rows = await db.query<SourceValidators>(
      'SELECT content_hash, etag, last_modified FROM sources WHERE canonical_url = $1',
      [url],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

/** Deterministic verification used offline and as the LLM fallback. */
export function verifyHeuristically(claim: StoredClaim, pageText: string): { status: ClaimStatus; newValue: string | null } {
  const text = normalise(pageText);
  if (!text) return { status: 'unverifiable', newValue: null };
  if (text.includes(normalise(claim.value))) return { status: 'unchanged', newValue: null };

  const monies = [...new Set(pageText.match(/[$€£]\s?\d[\d,]*(?:\.\d+)?/g) ?? [])];
  const different = monies.find((m) => normalise(m) !== normalise(claim.value));
  if (different) return { status: 'changed', newValue: different };

  const version = pageText.match(/\b\d+\.\d+(?:\.\d+)?\b/g);
  if (version?.length) {
    const other = version.find((v) => v !== claim.value);
    if (other) return { status: 'changed', newValue: other };
  }
  return { status: 'not_found', newValue: null };
}

async function verifyWithModel(claims: StoredClaim[], pageText: string, time: TimeContext): Promise<Map<string, { status: ClaimStatus; newValue: string | null }>> {
  const config = getConfig();
  const out = new Map<string, { status: ClaimStatus; newValue: string | null }>();
  if (config.mock || !config.openrouterKey) {
    for (const c of claims) out.set(c.id, verifyHeuristically(c, pageText));
    return out;
  }

  try {
    const result = await generateJson<z.infer<typeof VerdictList>>({
      model: config.models.utility,
      temperature: 0,
      timeoutMs: 20_000,
      messages: [
        {
          role: 'system',
          content: `You verify whether old facts still hold on a page that has been re-fetched.

For each claim, return exactly one result:
- "unchanged": the page still states the same value.
- "changed": the page states a different value; put the new value in newValue and quote the line in newQuote.
- "not_found": the page no longer mentions it, or you cannot tell.

Never guess. "not_found" is not a change.
Return JSON: {"results":[{"status","newValue","newQuote"}]} in the same order as the claims.`,
        },
        {
          role: 'user',
          content: `TODAY: ${time.localDate}\n\nCLAIMS (in order):\n${claims
            .map((c, i) => `${i + 1}. ${c.entity} — ${c.attribute}: ${c.value}${c.unit ? ` ${c.unit}` : ''}\n   old quote: "${c.quote}"`)
            .join('\n')}\n\nCURRENT PAGE TEXT (truncated):\n${pageText.slice(0, 8000)}`,
        },
      ],
    });
    const parsed = VerdictList.safeParse(result);
    if (!parsed.success || parsed.data.results.length !== claims.length) throw new Error('bad verdicts');
    claims.forEach((c, i) => {
      const v = parsed.data.results[i];
      out.set(c.id, { status: v.status as ClaimStatus, newValue: v.newValue ?? null });
    });
    return out;
  } catch {
    for (const c of claims) out.set(c.id, verifyHeuristically(c, pageText));
    return out;
  }
}

async function persistChecks(checks: ClaimCheck[]): Promise<void> {
  if (!checks.length) return;
  try {
    const db = await getDb();
    for (const c of checks) {
      await db.query(
        `INSERT INTO claim_checks (id, claim_id, status, new_value, evidence_url, method, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), c.claim.id, c.status, c.newValue, c.evidenceUrl, c.method, c.note],
      );
    }
  } catch {
    /* checks are diagnostics */
  }
}

export async function recheck(input: {
  claims: StoredClaim[];
  sinceDate: string | null;
  time: TimeContext;
  registry: SourceRegistry;
  entities?: string[];
}): Promise<ChangeReport> {
  const checks: ClaimCheck[] = [];
  const byUrl = new Map<string, StoredClaim[]>();

  for (const claim of input.claims) {
    if (!claim.sourceUrl) {
      checks.push({ claim, status: 'unverifiable', newValue: null, evidenceUrl: null, note: 'no source recorded', method: 'none' });
      continue;
    }
    const list = byUrl.get(claim.sourceUrl) ?? [];
    list.push(claim);
    byUrl.set(claim.sourceUrl, list);
  }

  const urls = [...byUrl.keys()].slice(0, 8);

  await Promise.all(
    urls.map(async (url) => {
      const group = byUrl.get(url)!;
      const validators = await validatorsFor(url);
      const page = await fetchPage(url, {
        ifNoneMatch: validators?.etag ?? null,
        ifModifiedSince: validators?.last_modified ?? null,
      });

      if (page?.notModified) {
        for (const claim of group) {
          checks.push({ claim, status: 'unchanged', newValue: null, evidenceUrl: url, note: 'page not modified (conditional request)', method: 'etag' });
        }
        return;
      }

      if (!page?.markdown) {
        // Fetch failed: fall back to a targeted search rather than claiming a change.
        for (const claim of group) {
          checks.push({
            claim,
            status: 'unverifiable',
            newValue: null,
            evidenceUrl: url,
            note: 'source could not be re-fetched',
            method: 'none',
          });
        }
        return;
      }

      const pageHash = contentHash(page.markdown);
      if (validators?.content_hash && pageHash === validators.content_hash) {
        for (const claim of group) {
          checks.push({ claim, status: 'unchanged', newValue: null, evidenceUrl: url, note: 'page content identical', method: 'hash' });
        }
        return;
      }

      const verdicts = await verifyWithModel(group, page.markdown, input.time);
      for (const claim of group) {
        const v = verdicts.get(claim.id) ?? { status: 'unverifiable' as ClaimStatus, newValue: null };
        checks.push({
          claim,
          status: v.status,
          newValue: v.newValue,
          evidenceUrl: url,
          note: v.status === 'not_found' ? 'not mentioned on the current page' : null,
          method: 'llm',
        });
      }
    }),
  );

  // "Shipped something big since then?" — news bounded by the original date.
  const news: ChangeReport['news'] = [];
  if (input.sinceDate) {
    const entities = (input.entities?.length ? input.entities : [...new Set(input.claims.map((c) => c.entity))]).slice(0, 5);
    const queries = entities.map((e) => `${e} pricing change OR launch OR announces`);
    const result = await webSearch(
      { queries, after_date: input.sinceDate, news: true, freshness: 'month' },
      { registry: input.registry, time: input.time, maxSources: 4 },
    );
    for (const s of result.sources) {
      news.push({
        title: s.title,
        url: s.url,
        site: s.site,
        publishedAt: s.publishedAt,
        snippet: s.passages[0] ?? '',
      });
    }
  }

  await persistChecks(checks);

  return {
    checkedAt: new Date().toISOString(),
    sinceDate: input.sinceDate,
    checks,
    news,
    unverified: checks.filter((c) => c.status === 'unverifiable' || c.status === 'not_found').length,
  };
}

export function changeReportBlock(report: ChangeReport): string {
  const counts = report.checks.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});
  const lines = [
    `<change-report checked_at="${report.checkedAt.slice(0, 10)}" since="${report.sinceDate ?? 'unknown'}">`,
    `  <summary>${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ') || 'no claims stored'}</summary>`,
  ];
  for (const c of report.checks) {
    lines.push(
      `  <claim entity="${c.claim.entity}" attribute="${c.claim.attribute}" status="${c.status}" old="${c.claim.value}${c.claim.unit ? ` ${c.claim.unit}` : ''}"${
        c.newValue ? ` new="${c.newValue}"` : ''
      } source="${c.evidenceUrl ?? ''}" />`,
    );
  }
  if (report.news.length) {
    lines.push('  <news-since>');
    for (const n of report.news) {
      lines.push(`    <item url="${n.url}" date="${n.publishedAt ?? ''}">${n.title} — ${n.snippet.slice(0, 200)}</item>`);
    }
    lines.push('  </news-since>');
  }
  lines.push('</change-report>');
  return lines.join('\n');
}
