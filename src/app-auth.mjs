/**
 * GitHub App authentication: mint a short-lived RS256 JWT from
 * GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, then exchange it for per-installation
 * tokens via POST /app/installations/:id/access_tokens.
 *
 * Installation tokens are cached in memory until expires_at minus 60s.
 * Per-installation scoping: every GitHub call the app makes uses the token
 * for the installation that delivered the event.
 */

import { createSign } from "node:crypto";
import { httpError } from "./server.mjs";

const UA = "claim-api/1.0.0";
const APP_API = "https://api.github.com";

function b64u(s) {
  return Buffer.from(s, "utf8").toString("base64url");
}

export function createAppAuth({ config, fetchImpl = fetch } = {}) {
  const tokenCache = new Map(); // installationId -> { token, expiresAtMs }

  function mintJwt(nowMs = Date.now()) {
    if (!config.appId || !config.privateKey) {
      throw httpError(503, "app-not-configured", "The GitHub App is not registered on this instance yet.");
    }
    const now = Math.floor(nowMs / 1000);
    const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64u(JSON.stringify({ iat: now - 60, exp: now + 600, iss: config.appId }));
    const signingInput = `${header}.${payload}`;
    let signature;
    try {
      signature = createSign("RSA-SHA256").update(signingInput).sign(config.privateKey, "base64url");
    } catch (err) {
      throw httpError(500, "app-key-invalid", `Could not sign the app JWT: ${err.message}`);
    }
    return `${signingInput}.${signature}`;
  }

  async function installationToken(installationId) {
    const key = String(installationId);
    const cached = tokenCache.get(key);
    if (cached && Date.now() < cached.expiresAtMs - 60_000) return cached.token;
    const jwt = mintJwt();
    const res = await fetchImpl(`${APP_API}/app/installations/${encodeURIComponent(key)}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw httpError(502, "installation-token-failed",
        `GitHub refused an installation token for installation ${key}: HTTP ${res.status} ${body.slice(0, 160)}`);
    }
    const data = await res.json();
    if (!data || !data.token) throw httpError(502, "installation-token-failed", "GitHub returned no token.");
    tokenCache.set(key, { token: data.token, expiresAtMs: new Date(data.expires_at).getTime() });
    return data.token;
  }

  /** List every installation of this app (JWT auth). Used to bootstrap the ledger installation. */
  async function listInstallations() {
    const jwt = mintJwt();
    const res = await fetchImpl(`${APP_API}/app/installations?per_page=100`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw httpError(502, "installations-list-failed", `GitHub HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    return res.json();
  }

  return { mintJwt, installationToken, listInstallations };
}
