/**
 * Tests: sliding-window rate limiter.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter, USER_WRITE_LIMIT, WEBHOOK_WRITE_LIMIT } from "../src/app-ratelimit.mjs";

test("allows up to the limit, then denies", () => {
  const rl = createRateLimiter();
  for (let i = 0; i < USER_WRITE_LIMIT; i++) {
    const r = rl.check("user:alice", USER_WRITE_LIMIT);
    assert.equal(r.allowed, true);
  }
  const denied = rl.check("user:alice", USER_WRITE_LIMIT);
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
});

test("limits are per key", () => {
  const rl = createRateLimiter();
  for (let i = 0; i < USER_WRITE_LIMIT; i++) rl.check("user:alice", USER_WRITE_LIMIT);
  assert.equal(rl.check("user:bob", USER_WRITE_LIMIT).allowed, true);
  assert.equal(rl.check("webhook:1", WEBHOOK_WRITE_LIMIT).allowed, true);
});

test("window slides with injected clock", () => {
  let t = 0;
  const rl = createRateLimiter({ now: () => t, windowMs: 1000 });
  assert.equal(rl.check("k", 2).allowed, true);
  assert.equal(rl.check("k", 2).allowed, true);
  assert.equal(rl.check("k", 2).allowed, false);
  t += 1001;
  const r = rl.check("k", 2);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 1);
});

test("custom store is honored (injectable)", () => {
  const store = new Map();
  const rl = createRateLimiter({ store });
  rl.check("k", 1);
  assert.equal(store.get("k").length, 1);
});
