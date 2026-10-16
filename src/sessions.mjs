/**
 * Session store: opaque tokens in memory, issued by the OAuth callback.
 * Production needs a real store (Redis, Postgres); the token format is
 * opaque so swapping the store later does not change the API.
 *
 * Note: the API also accepts a raw GitHub user token as the bearer for
 * write endpoints, verified per-request against GET /user. That is what
 * makes CLI device-flow and personal-access-token usage work without any
 * session at all.
 */

import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function createSessions() {
  const store = new Map();
  return {
    /** Issue a session token for a verified GitHub identity. */
    create({ login, userToken }) {
      const token = `gls_${randomBytes(24).toString("hex")}`;
      store.set(token, { login, userToken, expires: Date.now() + SESSION_TTL_MS, created: Date.now() });
      return token;
    },
    get(token) {
      const s = store.get(token);
      if (!s) return null;
      if (Date.now() > s.expires) {
        store.delete(token);
        return null;
      }
      return s;
    },
    revoke(token) {
      return store.delete(token);
    },
  };
}
