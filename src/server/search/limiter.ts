/**
 * Per-provider token bucket. Providers publish different limits (and sometimes
 * contradict themselves), so each provider gets a conservative budget. When a
 * bucket is empty we wait very briefly, then give up and let the next provider
 * answer — a slow search is worse than a second index.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();
const BUDGETS: Record<string, number> = {
  tinyfish: 20, // docs mention both 5 and 30 rpm; 20 is the safe middle
  exa: 60,
  tavily: 60,
  mock: 1000,
};

export class RateLimitedError extends Error {
  constructor(provider: string) {
    super(`${provider} rate limit reached`);
    this.name = 'RateLimitedError';
  }
}

function bucketFor(provider: string): Bucket {
  let b = buckets.get(provider);
  if (!b) {
    b = { tokens: BUDGETS[provider] ?? 30, updatedAt: Date.now() };
    buckets.set(provider, b);
  }
  return b;
}

export async function takeToken(provider: string, maxWaitMs = 750): Promise<void> {
  const budget = BUDGETS[provider] ?? 30;
  const b = bucketFor(provider);
  const now = Date.now();
  const refill = ((now - b.updatedAt) / 60_000) * budget;
  b.tokens = Math.min(budget, b.tokens + refill);
  b.updatedAt = now;

  if (b.tokens >= 1) {
    b.tokens -= 1;
    return;
  }

  const waitMs = Math.min(maxWaitMs, Math.ceil(((1 - b.tokens) / budget) * 60_000));
  await new Promise((r) => setTimeout(r, waitMs));
  // Re-check: another request may have consumed the refill.
  const after = bucketFor(provider);
  const refill2 = ((Date.now() - after.updatedAt) / 60_000) * budget;
  after.tokens = Math.min(budget, after.tokens + refill2);
  after.updatedAt = Date.now();
  if (after.tokens >= 1) {
    after.tokens -= 1;
    return;
  }
  throw new RateLimitedError(provider);
}

export function resetLimiters(): void {
  buckets.clear();
}
