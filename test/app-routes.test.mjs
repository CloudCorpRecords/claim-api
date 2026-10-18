/**
 * Tests: app HTTP routes. Webhook signature verification, idempotent
 * delivery handling, 503s before registration, installation reads, sweep
 * auth, and app-posted claim comments.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequestHandler } from "../src/server.mjs";
import { createSessions } from "../src/sessions.mjs";
import { createCache } from "../src/cache.mjs";
import { createAppStore } from "../src/app-store.mjs";
import { createRateLimiter } from "../src/app-ratelimit.mjs";
import { loadAppConfig } from "../src/app-config.mjs";

const CLAIM = "<!-- greenlight-claim v1 -->";
const WEBHOOK_SECRET = "test-webhook-secret";
const CRON_SECRET = "test-cron-secret";

function configuredApp() {
  return loadAppConfig({
    GITHUB_APP_ID: "1234",
    GITHUB_APP_PRIVATE_KEY: "pem",
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    CRON_SECRET,
    GITHUB_APP_SLUG: "greenlight-claims",
  });
}

function stubFactory(posted, users = {}) {
  return ({ token } = {}) => ({
    async user() {
      const login = users[token];
      if (!login) {
        const err = new Error("bad token");
        err.code = "invalid-token";
        throw err;
      }
      return { login, id: 1 };
    },
    async getIssue() {
      return { number: 42, title: "Fix the thing", state: "open" };
    },
    async postIssueComment(owner, repo, number, body) {
      posted.push({ owner, repo, number, body, token });
      return { id: 9001, html_url: `https://github.com/${owner}/${repo}/issues/${number}#issuecomment-9001` };
    },
    async getClaimsPolicy() {
      return null;
    },
    async getContents() {
      const err = new Error("not found");
      err.httpStatus = 404;
      throw err;
    },
    async listDir() {
      return null;
    },
  });
}

function testDeps(over = {}) {
  const posted = [];
  const store = createAppStore({ config: { stateMode: "memory" } });
  const handler = createRequestHandler({
    githubFactory: stubFactory(posted, { "tok-dave": "dave" }),
    sessions: createSessions({ secret: "test-secret" }),
    cache: createCache(),
    appConfig: configuredApp(),
    appAuth: {
      installationToken: async () => "install-token",
      listInstallations: async () => [],
    },
    appStore: store,
    limiter: createRateLimiter(),
    ...over,
  });
  return { handler, posted, store };
}

async function withHandler(deps, fn) {
  const { createServer } = await import("node:http");
  const server = createServer(deps.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

function sign(raw, secret = WEBHOOK_SECRET) {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}

async function postWebhook(base, { event, delivery, payload, secret }) {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${base}/v1/app/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret === null ? {} : { "X-Hub-Signature-256": sign(raw, secret || WEBHOOK_SECRET) }),
      "X-GitHub-Delivery": delivery,
      "X-GitHub-Event": event,
    },
    body: raw,
  });
  return { status: res.status, json: await res.json() };
}

function issueCommentPayload() {
  return {
    action: "created",
    installation: { id: 99 },
    repository: { full_name: "acme/repo" },
    issue: { number: 42, state: "open", title: "Fix the thing" },
    comment: {
      id: 1001,
      body: `Taking this on.\n\n${CLAIM}`,
      user: { login: "alice" },
      created_at: "2026-10-18T12:00:00Z",
      html_url: "https://github.com/acme/repo/issues/42#issuecomment-1001",
    },
  };
}

test("webhook without a signature is rejected", async () => {
  const deps = testDeps();
  await withHandler(deps, async (base) => {
    const { status, json } = await postWebhook(base, { event: "ping", delivery: "d1", payload: {}, secret: null });
    assert.equal(status, 401);
    assert.equal(json.error, "bad-webhook-signature");
  });
});

test("webhook with a wrong signature is rejected", async () => {
  const deps = testDeps();
  await withHandler(deps, async (base) => {
    const { status } = await postWebhook(base, { event: "ping", delivery: "d1", payload: {}, secret: "wrong" });
    assert.equal(status, 401);
  });
});

test("ping answers 200", async () => {
  const deps = testDeps();
  await withHandler(deps, async (base) => {
    const { status, json } = await postWebhook(base, { event: "ping", delivery: "d1", payload: { zen: "hi" } });
    assert.equal(status, 200);
    assert.equal(json.event, "ping");
  });
});

test("claim webhook is applied once; replays return 200 without re-applying", async () => {
  const deps = testDeps();
  await withHandler(deps, async (base) => {
    const first = await postWebhook(base, { event: "issue_comment", delivery: "d-claim-1", payload: issueCommentPayload() });
    assert.equal(first.status, 200);
    assert.equal(first.json.result.outcome, "claimed");
    const replay = await postWebhook(base, { event: "issue_comment", delivery: "d-claim-1", payload: issueCommentPayload() });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.replayed, true);
    const state = await deps.store.getRepoState("acme", "repo");
    assert.equal(state.issues["42"].history.filter((h) => h.event === "claimed").length, 1);
  });
});

test("app endpoints 503 before registration", async () => {
  const posted = [];
  const handler = createRequestHandler({
    githubFactory: stubFactory(posted),
    sessions: createSessions({ secret: "test-secret" }),
    cache: createCache(),
    appConfig: loadAppConfig({}),
    appAuth: { installationToken: async () => "x", listInstallations: async () => [] },
    appStore: createAppStore({ config: { stateMode: "memory" } }),
    limiter: createRateLimiter(),
  });
  await withHandler({ handler }, async (base) => {
    const raw = JSON.stringify({ zen: "x" });
    const r1 = await fetch(`${base}/v1/app/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(raw), "X-GitHub-Delivery": "d", "X-GitHub-Event": "ping" },
      body: raw,
    });
    assert.equal(r1.status, 503);
    assert.equal((await r1.json()).error, "app-not-configured");
    const r2 = await fetch(`${base}/v1/app/repos/acme/repo/installation`);
    assert.equal(r2.status, 503);
    const r3 = await fetch(`${base}/v1/app/sweep`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(r3.status, 503);
  });
});

test("installation reads reflect installation bookkeeping", async () => {
  const deps = testDeps();
  await deps.store.putInstallations({
    installations: [
      { installation_id: "99", account: "acme", account_type: "Organization", repos: [{ owner: "acme", repo: "repo" }], installed_at: "2026-10-18T00:00:00Z" },
    ],
  });
  await withHandler(deps, async (base) => {
    const r1 = await fetch(`${base}/v1/app/repos/acme/repo/installation`);
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    assert.equal(b1.installed, true);
    assert.equal(b1.app_slug, "greenlight-claims");
    const r2 = await fetch(`${base}/v1/app/repos/acme/other/installation`);
    assert.equal((await r2.json()).installed, false);
    const r3 = await fetch(`${base}/v1/app/installations`);
    const b3 = await r3.json();
    assert.equal(b3.repos.length, 1);
    assert.equal(b3.repos[0].installation_id, "99");
  });
});

test("sweep requires the cron secret", async () => {
  const deps = testDeps();
  await withHandler(deps, async (base) => {
    const r1 = await fetch(`${base}/v1/app/sweep`);
    assert.equal(r1.status, 401);
    const r2 = await fetch(`${base}/v1/app/sweep`, { headers: { Authorization: "Bearer wrong" } });
    assert.equal(r2.status, 401);
    const r3 = await fetch(`${base}/v1/app/sweep`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(r3.status, 200);
    const b3 = await r3.json();
    assert.equal(b3.ok, true);
    assert.ok(typeof b3.expired === "number");
  });
});

test("webhook rate limit trips at 240/hour per installation", async () => {
  const deps = testDeps();
  const limiter = createRateLimiter();
  for (let i = 0; i < 240; i++) limiter.check("webhook:99", 240);
  const deps2 = testDeps({ limiter });
  await withHandler(deps2, async (base) => {
    const { status, json } = await postWebhook(base, { event: "issue_comment", delivery: "d-rl", payload: issueCommentPayload() });
    assert.equal(status, 429);
    assert.equal(json.error, "webhook-rate-limited");
  });
});

test("POST /v1/app/claims posts as the app with on-behalf-of attribution", async () => {
  const deps = testDeps();
  await deps.store.putInstallations({
    installations: [
      { installation_id: "99", account: "acme", account_type: "Organization", repos: [{ owner: "acme", repo: "repo" }], installed_at: "2026-10-18T00:00:00Z" },
    ],
  });
  await withHandler(deps, async (base) => {
    const res = await fetch(`${base}/v1/app/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-dave" },
      body: JSON.stringify({ owner: "acme", repo: "repo", issue: 42, plan: "fix it" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.posted_by, "app");
    assert.equal(body.claimant, "dave");
    assert.equal(deps.posted.length, 1);
    assert.ok(deps.posted[0].body.includes(CLAIM));
    assert.ok(deps.posted[0].body.includes("on-behalf-of: dave"));
    assert.equal(deps.posted[0].token, "install-token");
  });
});

test("POST /v1/app/claims 409s when the app is not installed on the repo", async () => {
  const deps = testDeps();
  await withHandler(deps, async (base) => {
    const res = await fetch(`${base}/v1/app/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-dave" },
      body: JSON.stringify({ owner: "acme", repo: "repo", issue: 42 }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "app-not-installed");
  });
});

test("user write endpoints are rate limited at 30/hour per login", async () => {
  const deps = testDeps();
  const limiter = createRateLimiter();
  for (let i = 0; i < 30; i++) limiter.check("user:dave", 30);
  const deps2 = testDeps({ limiter });
  await withHandler(deps2, async (base) => {
    const res = await fetch(`${base}/v1/claims/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-dave" },
      body: JSON.stringify({ owner: "acme", repo: "repo", issue: 42 }),
    });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error, "user-rate-limited");
  });
});
