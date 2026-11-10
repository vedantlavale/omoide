/**
 * Circuit breaker. Three failures inside a minute takes a provider out for two
 * minutes. Without this, one dead API key turns every answer into a 10-second
 * timeout instead of a fast answer from the other index.
 */

interface BreakerState {
  failures: number[];
  openUntil: number;
}

const state = new Map<string, BreakerState>();
const WINDOW_MS = 60_000;
const OPEN_MS = 120_000;
const THRESHOLD = 3;

function get(name: string): BreakerState {
  let s = state.get(name);
  if (!s) {
    s = { failures: [], openUntil: 0 };
    state.set(name, s);
  }
  return s;
}

export function isOpen(name: string): boolean {
  const s = get(name);
  if (s.openUntil > Date.now()) return true;
  if (s.openUntil && s.openUntil <= Date.now()) {
    s.openUntil = 0;
    s.failures = [];
  }
  return false;
}

export function recordFailure(name: string): void {
  const s = get(name);
  const now = Date.now();
  s.failures = s.failures.filter((t) => now - t < WINDOW_MS);
  s.failures.push(now);
  if (s.failures.length >= THRESHOLD) s.openUntil = now + OPEN_MS;
}

export function recordSuccess(name: string): void {
  const s = get(name);
  s.failures = [];
  s.openUntil = 0;
}

export function resetBreakers(): void {
  state.clear();
}
