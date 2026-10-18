/**
 * Sliding-window rate limiter with an injectable store.
 *
 * Contract limits:
 *   - user write endpoints: 30/hr per caller login
 *   - webhook-triggered writes: 240/hr per installation id
 *
 * The default store is an in-memory Map, which means the limit is
 * per function instance on Vercel (documented in DEPLOY.md): a burst
 * spread across N warm instances can reach N times the limit. For the
 * traffic this service sees that is acceptable; a shared store (Redis,
 * Vercel KV) can replace the Map without changing callers.
 *
 * Rate-limit rejections are plain 429s and are never written to any ledger.
 */

export const USER_WRITE_LIMIT = 30;
export const WEBHOOK_WRITE_LIMIT = 240;
export const WINDOW_MS = 3600_000;

export function createRateLimiter({ store = new Map(), now = () => Date.now(), windowMs = WINDOW_MS } = {}) {
  function check(key, limit) {
    const t = now();
    const raw = store.get(key) || [];
    const recent = raw.filter((ts) => t - ts < windowMs);
    if (recent.length >= limit) {
      store.set(key, recent);
      return { allowed: false, remaining: 0, retryAfterMs: windowMs - (t - recent[0]) };
    }
    recent.push(t);
    store.set(key, recent);
    return { allowed: true, remaining: limit - recent.length, retryAfterMs: 0 };
  }
  return { check };
}
