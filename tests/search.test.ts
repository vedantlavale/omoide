import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, domainMatchesEntity, siteOf } from '../src/server/search/canonical';
import { rankResults, type RawResult } from '../src/server/search/rank';
import { selectPassages } from '../src/server/search/extract';
import { stripInvalidCitations } from '../src/server/agent/synthesize';
import { heuristicClaims } from '../src/server/memory/claims';
import type { EvidenceSource } from '../src/server/types';

describe('canonical URLs', () => {
  it('strips tracking params, www, hash and trailing slash', () => {
    expect(canonicalizeUrl('https://www.neon.com/pricing/?utm_source=x&gclid=abc#plans')).toBe(
      'https://neon.com/pricing',
    );
  });

  it('keeps meaningful query params and sorts them', () => {
    expect(canonicalizeUrl('https://example.com/a?b=2&a=1')).toBe('https://example.com/a?a=1&b=2');
  });

  it('rejects non-http URLs', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
  });

  it('extracts the site', () => {
    expect(siteOf('https://www.aws.amazon.com/rds')).toBe('aws.amazon.com');
  });

  it('matches an entity to its own domain', () => {
    expect(domainMatchesEntity('https://neon.com/pricing', 'Neon')).toBe(true);
    expect(domainMatchesEntity('https://g2.com/compare', 'Neon')).toBe(false);
  });
});

describe('ranking', () => {
  const tinyfish: RawResult[] = [
    { url: 'https://blog.example.com/best-pricing', title: 'Best pricing listicles', snippet: 'x', provider: 'tinyfish' },
    { url: 'https://neon.com/pricing', title: 'Neon pricing', snippet: 'Neon Launch is $19', provider: 'tinyfish' },
  ];
  const exa: RawResult[] = [
    { url: 'https://neon.com/pricing?utm_source=exa', title: 'Neon pricing', snippet: 'Launch $19/month', provider: 'exa' },
    { url: 'https://supabase.com/pricing', title: 'Supabase pricing', snippet: 'Pro $30', provider: 'exa' },
  ];

  it('dedupes the same page across providers and fuses ranks', () => {
    const ranked = rankResults([tinyfish, exa], { queryText: 'pricing' });
    const neon = ranked.filter((r) => r.canonicalUrl === 'https://neon.com/pricing');
    expect(neon).toHaveLength(1);
    expect(neon[0].providers.sort()).toEqual(['exa', 'tinyfish']);
  });

  it('prefers the vendor page over a listicle', () => {
    const ranked = rankResults([tinyfish, exa], { queryText: 'neon pricing', entities: ['Neon'] });
    expect(ranked[0].canonicalUrl).toBe('https://neon.com/pricing');
  });

  it('demotes content farms', () => {
    const ranked = rankResults([
      [
        { url: 'https://pinterest.com/pin/1', title: 'Pricing', snippet: '', provider: 'tinyfish' },
        { url: 'https://vendor.com/pricing', title: 'Pricing', snippet: '', provider: 'tinyfish' },
      ],
    ]);
    expect(ranked[0].canonicalUrl).toBe('https://vendor.com/pricing');
  });
});

describe('passage extraction', () => {
  it('picks the block that answers the query, not the whole page', () => {
    const page = [
      '# Pricing',
      'Neon has a usage-based pricing model with several plans and a free tier for hobby projects.',
      'The Launch plan starts at $19 per month and includes 10 GB of storage and 300 compute hours.',
      'Neon supports branching, point-in-time restore and scale to zero on every plan.',
    ].join('\n\n');
    const passages = selectPassages(page, 'neon launch plan price per month');
    expect(passages.join(' ')).toContain('$19');
    expect(passages.join(' ').length).toBeLessThan(1200);
  });
});

describe('citation hygiene', () => {
  it('drops citations that do not exist in the registry', () => {
    expect(stripInvalidCitations('Neon is $19 [S1] and X is $3 [S9].', ['S1'])).toBe(
      'Neon is $19 [S1] and X is $3 .',
    );
  });
});

describe('claim extraction (deterministic path)', () => {
  const sources: EvidenceSource[] = [
    {
      id: 'S1',
      url: 'https://neon.com/pricing',
      canonicalUrl: 'https://neon.com/pricing',
      title: 'Neon — Pricing',
      site: 'neon.com',
      fetchedAt: new Date().toISOString(),
      passages: [],
      snippetOnly: false,
    },
  ];

  it('extracts money facts with their entity and source', () => {
    const claims = heuristicClaims('Neon Launch is $19 per month [S1].', sources, ['Neon']);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0].entity).toBe('Neon');
    expect(claims[0].value).toBe('$19');
    expect(claims[0].sourceId).toBe('S1');
  });

  it('ignores prose with no checkable numbers', () => {
    expect(heuristicClaims('Neon is a good choice for side projects.', sources, ['Neon'])).toEqual([]);
  });
});
