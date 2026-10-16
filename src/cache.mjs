/**
 * Tiny in-memory TTL cache (60s for issue status). Not shared across
 * instances; production with more than one instance needs Redis or similar.
 */

export function createCache({ ttlMs = 60_000 } = {}) {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expires) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttl = ttlMs) {
      store.set(key, { value, expires: Date.now() + ttl });
    },
    invalidate(key) {
      store.delete(key);
    },
    size() {
      return store.size;
    },
  };
}
