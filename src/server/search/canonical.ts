/**
 * URL normalisation. Two results that "are the same page" must collapse into
 * one citation, otherwise the agent cites the same price twice and looks
 * confused. This also keys the page cache and the claim ledger.
 */

const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'spm',
  'igshid',
];

export function canonicalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';
  for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
  url.searchParams.sort();

  let path = url.pathname.replace(/\/+$/, '');
  if (!path) path = '/';
  url.pathname = path;

  let out = url.toString();
  if (out.endsWith('/') && url.search === '') out = out.slice(0, -1);
  return out;
}

export function siteOf(input: string): string {
  try {
    return new URL(input).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const LOW_TRUST = [
  'pinterest.',
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'quora.com',
  'answers.yahoo',
  'slideshare.net',
];

export function isLowTrust(canonicalUrl: string): boolean {
  return LOW_TRUST.some((d) => canonicalUrl.includes(d));
}

/** Cheap entity→domain match, used to prefer a vendor's own pricing page. */
export function domainMatchesEntity(canonicalUrl: string, entity: string): boolean {
  const token = entity
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  if (token.length < 3) return false;
  const host = siteOf(canonicalUrl).replace(/\./g, '');
  return host.includes(token);
}
