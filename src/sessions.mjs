/**
 * Stateless session tokens (claim-api v1.0).
 *
 * The old in-memory session map is gone: a session token is now a
 * self-contained envelope, AES-256-GCM encrypted and HMAC-SHA256 signed with
 * SESSION_SECRET. Any function instance can verify any token it did not
 * issue, so sessions survive Vercel cold starts and instance recycles.
 *
 * Token format: gls2_<iv>.<ciphertext>.<mac> (all base64url).
 * Payload: { login, userToken, iat, exp } with a 30 day TTL.
 *
 * revoke() keeps a small bounded in-memory blocklist of token MACs. It is
 * per-instance and best effort on serverless: revocation is a courtesy, not
 * a security boundary. Treat token secrecy as the real control.
 *
 * Raw GitHub user tokens (PAT / device flow) never touch this store: they
 * are verified per request against GET /user, exactly as before.
 */

import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { httpError } from "./server.mjs";

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const PREFIX = "gls2_";
const REVOCATION_CAP = 5000;

function deriveKeys(secret) {
  const encKey = createHmac("sha256", secret).update("claim-api:session-enc:v1").digest();
  const macKey = createHmac("sha256", secret).update("claim-api:session-mac:v1").digest();
  return { encKey, macKey };
}

function b64uDecode(s) {
  return Buffer.from(s, "base64url");
}

export function createSessions({ secret = "" } = {}) {
  const revoked = []; // bounded FIFO of revoked token MACs (per instance)
  const revokedSet = new Set();

  function keys() {
    if (!secret) throw httpError(500, "sessions-not-configured", "SESSION_SECRET is not set on this instance.");
    return deriveKeys(secret);
  }

  function macOf(envelope) {
    const { macKey } = keys();
    return createHmac("sha256", macKey).update(envelope).digest("base64url");
  }

  return {
    /** Issue a session token for a verified GitHub identity. */
    create({ login, userToken }) {
      const { encKey } = keys();
      const now = Date.now();
      const payload = JSON.stringify({ login, userToken, iat: now, exp: now + SESSION_TTL_MS });
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encKey, iv);
      const ct = Buffer.concat([cipher.update(payload, "utf8"), cipher.final(), cipher.getAuthTag()]);
      const envelope = `${iv.toString("base64url")}.${ct.toString("base64url")}`;
      return `${PREFIX}${envelope}.${macOf(envelope)}`;
    },

    get(token) {
      if (typeof token !== "string" || !token.startsWith(PREFIX)) return null;
      const parts = token.slice(PREFIX.length).split(".");
      if (parts.length !== 3) return null;
      const [ivB64, ctB64, macB64] = parts;
      const envelope = `${ivB64}.${ctB64}`;
      let macBuf;
      let expected;
      try {
        macBuf = b64uDecode(macB64);
        expected = b64uDecode(macOf(envelope));
      } catch {
        return null;
      }
      if (macBuf.length !== expected.length || !timingSafeEqual(macBuf, expected)) return null;
      if (revokedSet.has(macB64)) return null;
      try {
        const { encKey } = keys();
        const iv = b64uDecode(ivB64);
        const ctAndTag = b64uDecode(ctB64);
        if (iv.length !== 12 || ctAndTag.length < 17) return null;
        const ct = ctAndTag.subarray(0, ctAndTag.length - 16);
        const tag = ctAndTag.subarray(ctAndTag.length - 16);
        const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
        decipher.setAuthTag(tag);
        const payload = JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
        if (!payload || typeof payload.login !== "string" || typeof payload.userToken !== "string") return null;
        if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
        return { login: payload.login, userToken: payload.userToken, created: payload.iat };
      } catch {
        return null;
      }
    },

    revoke(token) {
      if (typeof token !== "string" || !token.startsWith(PREFIX)) return false;
      const macB64 = token.slice(PREFIX.length).split(".")[2];
      if (!macB64 || revokedSet.has(macB64)) return false;
      revoked.push(macB64);
      revokedSet.add(macB64);
      while (revoked.length > REVOCATION_CAP) revokedSet.delete(revoked.shift());
      return true;
    },
  };
}

/** Fingerprint of a session secret, for safe logging (never log the secret). */
export function secretFingerprint(secret) {
  if (!secret) return "missing";
  return createHash("sha256").update(String(secret)).digest("hex").slice(0, 12);
}
