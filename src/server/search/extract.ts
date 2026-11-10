/**
 * Passage extraction.
 *
 * Handing a model a whole 90k-character pricing page is expensive and makes it
 * worse at the task. We split the page into blocks and keep the handful that
 * actually match the query (a small BM25-ish score), while never sending more
 * than ~1200 characters per source. This is the difference between "cited a
 * page" and "cited the sentence that answers the question".
 */

const STOP = new Set(
  'a an and are as at be by for from has have how in is it its of on or that the their then there these this to was were what when where which who why will with you your'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$%./-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[-./]+|[-./]+$/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function selectPassages(markdown: string, query: string, opts: { maxChars?: number; maxBlocks?: number } = {}): string[] {
  const maxChars = opts.maxChars ?? 1200;
  const maxBlocks = opts.maxBlocks ?? 3;

  const blocks = markdown
    .split(/\n{2,}/)
    .map((b) =>
      b
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/[*_`>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((b) => b.length >= 60 && b.length <= 2500);

  if (!blocks.length) {
    const flat = markdown.replace(/\s+/g, ' ').trim();
    return flat ? [flat.slice(0, maxChars)] : [];
  }

  const queryTokens = new Set(tokenize(query));
  const docFreq = new Map<string, number>();
  const tokenized = blocks.map((b) => tokenize(b));
  for (const toks of tokenized) {
    for (const t of new Set(toks)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }

  const scored = blocks.map((block, i) => {
    const toks = tokenized[i];
    let score = 0;
    const counts = new Map<string, number>();
    for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [token, count] of counts) {
      if (!queryTokens.has(token)) continue;
      const idf = Math.log(1 + blocks.length / (1 + (docFreq.get(token) ?? 1)));
      score += (1 + Math.log(count)) * idf;
    }
    // Numbers and currency are what "pricing changed" questions turn on.
    if (/\$\s?\d|\d+\s?(usd|eur|gbp|inr)\b/i.test(block)) score *= 1.15;
    return { i, block, score };
  });

  const picked = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxBlocks);

  const chosen = (picked.length ? picked : scored.slice(0, 1)).sort((a, b) => a.i - b.i);

  const out: string[] = [];
  let used = 0;
  for (const c of chosen) {
    const remaining = maxChars - used;
    if (remaining < 80) break;
    out.push(c.block.length > remaining ? `${c.block.slice(0, remaining - 1)}…` : c.block);
    used += Math.min(c.block.length, remaining);
  }
  return out;
}

export function firstSentence(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const m = clean.match(/^.{20,}?[.!?](\s|$)/);
  const out = m ? m[0] : clean.slice(0, max);
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
