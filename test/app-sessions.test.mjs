/**
 * Tests: stateless sessions (HMAC + AES-256-GCM envelopes).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessions } from "../src/sessions.mjs";

const SECRET = "test-session-secret-0123456789abcdef";

test("create/get round trip preserves login and user token", () => {
  const s = createSessions({ secret: SECRET });
  const tok = s.create({ login: "alice", userToken: "tok-abc" });
  assert.ok(tok.startsWith("gls2_"));
  const got = s.get(tok);
  assert.equal(got.login, "alice");
  assert.equal(got.userToken, "tok-abc");
});

test("tokens verify on a different instance with the same secret", () => {
  const a = createSessions({ secret: SECRET });
  const b = createSessions({ secret: SECRET });
  const tok = a.create({ login: "bob", userToken: "tok-b" });
  assert.equal(b.get(tok).login, "bob");
});

test("wrong secret does not verify", () => {
  const a = createSessions({ secret: SECRET });
  const b = createSessions({ secret: "another-secret" });
  const tok = a.create({ login: "alice", userToken: "tok-abc" });
  assert.equal(b.get(tok), null);
});

test("tampered token does not verify", () => {
  const s = createSessions({ secret: SECRET });
  const tok = s.create({ login: "alice", userToken: "tok-abc" });
  const parts = tok.split(".");
  const tampered = `${parts[0]}.${parts[1].replace(/./, "A")}.${parts[2]}`;
  assert.equal(s.get(tampered), null);
  assert.equal(s.get("gls2_garbage"), null);
  assert.equal(s.get("gls_oldopaque"), null);
  assert.equal(s.get(null), null);
});

test("revoke blocks the token afterwards", () => {
  const s = createSessions({ secret: SECRET });
  const tok = s.create({ login: "alice", userToken: "tok-abc" });
  assert.equal(s.revoke(tok), true);
  assert.equal(s.get(tok), null);
  assert.equal(s.revoke(tok), false);
});

test("create without a secret fails closed", () => {
  const s = createSessions({ secret: "" });
  assert.throws(() => s.create({ login: "a", userToken: "t" }), (err) => err && err.code === "sessions-not-configured");
  assert.equal(s.get("gls2_x.y.z"), null);
});
