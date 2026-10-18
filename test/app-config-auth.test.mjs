/**
 * Tests: app config loading and app auth (JWT mint, installation token cache).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { loadAppConfig, normalizePrivateKey } from "../src/app-config.mjs";
import { createAppAuth } from "../src/app-auth.mjs";

function testKeys() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

test("loadAppConfig: not configured without the four secrets", () => {
  const c = loadAppConfig({});
  assert.equal(c.configured, false);
  assert.equal(c.stateMode, "ledger");
  assert.equal(c.ledgerOwner, "CloudCorpRecords");
});

test("loadAppConfig: configured when all four secrets are present", () => {
  const c = loadAppConfig({
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "pem",
    GITHUB_WEBHOOK_SECRET: "wh",
    CRON_SECRET: "cron",
    GITHUB_APP_SLUG: "greenlight-claims",
  });
  assert.equal(c.configured, true);
  assert.equal(c.appSlug, "greenlight-claims");
});

test("normalizePrivateKey: converts literal backslash-n to newlines", () => {
  const raw = "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----";
  assert.ok(normalizePrivateKey(raw).includes("\nABC\n"));
  assert.ok(normalizePrivateKey("already\nfine").includes("already\nfine"));
});

test("mintJwt: produces a verifiable RS256 JWT with iss/iat/exp", async () => {
  const { createVerify } = await import("node:crypto");
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const priv = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const auth = createAppAuth({ config: loadAppConfig({ GITHUB_APP_ID: "999", GITHUB_APP_PRIVATE_KEY: priv }) });
  const jwt = auth.mintJwt(1_700_000_000_000);
  const [h, p, s] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).alg, "RS256");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(payload.iss, "999");
  assert.equal(payload.exp - payload.iat, 660); // 600s expiry, iat minus 60s
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert.equal(v.verify(pair.publicKey, s, "base64url"), true);
});

test("installationToken: caches until expiry minus 60s", async () => {
  const pem = testKeys();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        token: `tok-${calls}`,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    };
  };
  const auth = createAppAuth({ config: loadAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem }), fetchImpl });
  const t1 = await auth.installationToken(42);
  const t2 = await auth.installationToken(42);
  assert.equal(t1, t2);
  assert.equal(calls, 1);
  const t3 = await auth.installationToken(43);
  assert.notEqual(t1, t3);
  assert.equal(calls, 2);
});

test("installationToken: surfaces GitHub errors honestly", async () => {
  const pem = testKeys();
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => "not found" });
  const auth = createAppAuth({ config: loadAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem }), fetchImpl });
  await assert.rejects(() => auth.installationToken(42), (err) => err && err.code === "installation-token-failed");
});
