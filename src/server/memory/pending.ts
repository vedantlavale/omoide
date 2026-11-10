/**
 * The race between "answer finished streaming" and "the user immediately asks
 * a follow-up".
 *
 * Post-turn work (claim extraction) runs after the response, so a fast follow-up
 * like "is that still correct?" can arrive before the claims exist. We keep a
 * per-message promise and make recall wait for it briefly. If it is still not
 * done, recall falls back to re-searching the topic — never to guessing.
 */

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __recallPending: Map<string, Deferred> | undefined;
}

function store(): Map<string, Deferred> {
  if (!globalThis.__recallPending) globalThis.__recallPending = new Map();
  return globalThis.__recallPending;
}

export function registerPending(messageId: string): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const deferred = { promise, resolve };
  store().set(messageId, deferred);
  return deferred;
}

export function resolvePending(messageId: string): void {
  const d = store().get(messageId);
  if (!d) return;
  d.resolve();
  // Keep the entry for a while: a second follow-up may still read it.
  setTimeout(() => store().delete(messageId), 60_000).unref?.();
}

export async function awaitPending(messageId: string, timeoutMs = 5000): Promise<boolean> {
  const d = store().get(messageId);
  if (!d) return true;
  const timeout = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    t.unref?.();
  });
  return Promise.race([d.promise.then(() => true), timeout]);
}
