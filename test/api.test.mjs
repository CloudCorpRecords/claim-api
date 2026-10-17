/**
 * claim-api tests: the whole service runs locally against a mocked GitHub
 * API (fetch is injected through the github factory). Covers the read
 * endpoints, the claim success path (asserting the exact comment body,
 * marker included), the 409 refusal, queue joining, 401s, release, and
 * both heartbeat modes, plus the OAuth callback skeleton.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createSessions } from "../src/sessions.mjs";
import { createCache } from "../src/cache.mjs";
import { httpError } from "../src/github.mjs";

const CLAIM_MARKER = "<!-- greenlight-claim v1 -->";
const RELEASE_MARKER = "<!-- greenlight-claim release -->";

function isoDaysAgo(d) {
  return new Date(Date.now() - d * 864e5).toISOString();
}

function aliceClaimComment() {
  return {
    id: 1001,
    user: { login: "alice" },
    body: `I'd like to take this on: Fix the thing.\n\n${CLAIM_MARKER}\nClaimed under the Greenlight Claim Protocol: this claim renews or expires\nautomatically, and releases the moment a PR is linked or I say so.`,
    created_at: isoDaysAgo(1),
    html_url: "https://github.com/acme/repo/issues/42#issuecomment-1001",
  };
}

function makeStore({ comments = [] } = {}) {
  const store = {
    users: { "tok-alice": "alice", "tok-bob": "bob" },
    issue: { number: 42, title: "Fix the thing", state: "open" },
    comments: comments.map((c) => ({ ...c })),
    reactions: [],
    nextCommentId: 2000,
  };
  return store;
}

function makeFactory(store) {
  return ({ token } = {}) => {
    const login = store.users[token];
    return {
      async user() {
        if (!login) throw httpError(401, "invalid-token", "Token is not valid GitHub credentials.");
        return { login, id: 1 };
      },
      async exchangeCode(clientId, clientSecret, code) {
        if (code !== "good-code") throw httpError(401, "oauth-exchange-failed", "nope");
        return "tok-alice";
      },
      async getIssue() { return { ...store.issue }; },
      async getComments() { return store.comments.map((c) => ({ ...c })); },
      async getCommentReactions() { return []; },
      async postIssueComment(owner, repo, number, body) {
        const comment = {
          id: store.nextCommentId++,
          user: { login },
          body,
          created_at: new Date().toISOString(),
          html_url: `https://github.com/${owner}/${repo}/issues/${number}#issuecomment-${store.nextCommentId}`,
        };
        store.comments.push(comment);
        return { ...comment };
      },
      async addCommentReaction(owner, repo, commentId, content) {
        store.reactions.push({ commentId, content, by: login });
        return { content };
      },
      async getTimeline() { return []; },
      async getPull() { return null; },
      async listOpenPulls() { return []; },
      async getClaimsPolicy() { return null; },
    };
  };
}

async function withServer(store, fn) {
  const app = createApp({
    githubFactory: makeFactory(store),
    sessions: createSessions(),
    cache: createCache(),
    config: { serviceToken: "svc", ledgerBaseUrl: "http://127.0.0.1:1", clientId: "cid", clientSecret: "csecret" },
  });
  await new Promise((resolve) => app.listen(0, resolve));
  const port = app.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    app.close();
  }
}

async function postJson(base, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

test("GET /healthz answers", async () => {
  await withServer(makeStore(), async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});

test("GET status on an issue with no protocol claims leaves the verdict to the caller", async () => {
  await withServer(makeStore(), async (base) => {
    const res = await fetch(`${base}/v1/issues/acme/repo/42/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.verdict, null);
    assert.equal(body.claim, null);
    assert.ok(body.issue.includes("/acme/repo/issues/42"));
    assert.equal(body.stale_after_seconds, 60);
    assert.ok(body.checked_at);
    assert.deepEqual(body.data_quality, { degraded: false, missing: [] });
  });
});

test("POST /v1/claims posts the exact protocol claim body", async () => {
  const store = makeStore();
  await withServer(store, async (base) => {
    const { status, json } = await postJson(
      base, "/v1/claims",
      { owner: "acme", repo: "repo", issue: 42, plan: "Reproduce first", eta_days: 3 },
      "tok-bob"
    );
    assert.equal(status, 201);
    assert.equal(json.action, "claimed");
    assert.equal(json.queue_position, 1);
    const posted = store.comments[store.comments.length - 1];
    assert.equal(posted.user.login, "bob");
    assert.ok(posted.body.includes(CLAIM_MARKER), "claim comment carries the marker");
    assert.ok(posted.body.includes("plan: Reproduce first"));
    assert.ok(posted.body.includes("eta-days: 3"));
    assert.ok(posted.body.includes("Claimed under the Greenlight Claim Protocol"));
    assert.ok(posted.body.includes("Fix the thing"));
  });
});

test("POST /v1/claims refuses when another user holds the active claim", async () => {
  const store = makeStore({ comments: [aliceClaimComment()] });
  await withServer(store, async (base) => {
    const { status, json } = await postJson(
      base, "/v1/claims", { owner: "acme", repo: "repo", issue: 42 }, "tok-bob"
    );
    assert.equal(status, 409);
    assert.equal(json.error, "claim-held");
    assert.equal(json.holder.claimant, "alice");
    assert.equal(store.comments.length, 1, "nothing was posted");
  });
});

test("POST /v1/claims with queue_ok joins the public queue", async () => {
  const store = makeStore({ comments: [aliceClaimComment()] });
  await withServer(store, async (base) => {
    const { status, json } = await postJson(
      base, "/v1/claims", { owner: "acme", repo: "repo", issue: 42, queue_ok: true }, "tok-bob"
    );
    assert.equal(status, 201);
    assert.equal(json.action, "claimed");
    assert.equal(json.queue_position, 2);
    const posted = store.comments[store.comments.length - 1];
    assert.ok(posted.body.includes(CLAIM_MARKER));
    assert.ok(posted.body.includes("queue-ok: yes"), "queue intent is a structured line");
    // A live status read now shows alice active with bob queued.
    const res = await fetch(`${base}/v1/issues/acme/repo/42/status`);
    const body = await res.json();
    assert.equal(body.claim.state, "active");
    assert.equal(body.claim.claimant, "alice");
    assert.equal(body.claim.queue.length, 1);
    assert.equal(body.claim.queue[0].claimant, "bob");
    // Fallback scan ran (empty), everything fetched fine: not degraded.
    assert.deepEqual(body.data_quality, { degraded: false, missing: [] });
  });
});

test("POST /v1/claims with a bad token gives 401", async () => {
  await withServer(makeStore(), async (base) => {
    const { status, json } = await postJson(
      base, "/v1/claims", { owner: "acme", repo: "repo", issue: 42 }, "tok-nobody"
    );
    assert.equal(status, 401);
    assert.equal(json.error, "invalid-token");
  });
});

test("POST /v1/claims without a token gives 401", async () => {
  await withServer(makeStore(), async (base) => {
    const { status, json } = await postJson(base, "/v1/claims", { owner: "acme", repo: "repo", issue: 42 });
    assert.equal(status, 401);
  });
});

test("POST /v1/claims/release posts the release marker as the holder", async () => {
  const store = makeStore({ comments: [aliceClaimComment()] });
  await withServer(store, async (base) => {
    const { status, json } = await postJson(
      base, "/v1/claims/release", { owner: "acme", repo: "repo", issue: 42 }, "tok-alice"
    );
    assert.equal(status, 201);
    assert.equal(json.action, "released");
    const posted = store.comments[store.comments.length - 1];
    assert.ok(posted.body.includes(RELEASE_MARKER), "release comment carries the release marker");
    assert.equal(posted.user.login, "alice");
  });
});

test("POST /v1/claims/release by a non-holder gives 403", async () => {
  const store = makeStore({ comments: [aliceClaimComment()] });
  await withServer(store, async (base) => {
    const { status, json } = await postJson(
      base, "/v1/claims/release", { owner: "acme", repo: "repo", issue: 42 }, "tok-bob"
    );
    assert.equal(status, 403);
    assert.equal(json.error, "not-claim-holder");
  });
});

test("POST /v1/claims/heartbeat in comment mode renews the holder", async () => {
  const store = makeStore({ comments: [aliceClaimComment()] });
  await withServer(store, async (base) => {
    const { status, json } = await postJson(
      base, "/v1/claims/heartbeat", { owner: "acme", repo: "repo", issue: 42 }, "tok-alice"
    );
    assert.equal(status, 201);
    assert.equal(json.action, "heartbeat");
    assert.equal(json.mode, "comment");
    const posted = store.comments[store.comments.length - 1];
    assert.ok(posted.body.startsWith("Heartbeat:"), "minimal heartbeat comment");
  });
});

test("POST /v1/claims/heartbeat in reaction mode adds a rocket to the holder's own claim comment", async () => {
  const store = makeStore({ comments: [aliceClaimComment()] });
  await withServer(store, async (base) => {
    const { status, json } = await postJson(
      base, "/v1/claims/heartbeat", { owner: "acme", repo: "repo", issue: 42, mode: "reaction" }, "tok-alice"
    );
    assert.equal(status, 201);
    assert.equal(json.mode, "reaction");
    assert.deepEqual(store.reactions, [{ commentId: 1001, content: "rocket", by: "alice" }]);
  });
});

test("GET /v1/claims/:owner/:repo/:number returns the live claim chain", async () => {
  const store = makeStore({ comments: [aliceClaimComment()] });
  await withServer(store, async (base) => {
    const res = await fetch(`${base}/v1/claims/acme/repo/42`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.repo, "acme/repo");
    assert.equal(body.issue, 42);
    assert.equal(body.active.claimant, "alice");
    assert.ok(Array.isArray(body.claims));
    assert.equal(body.claims.length, 1);
  });
});

test("OAuth callback skeleton issues a usable session token", async () => {
  const store = makeStore();
  await withServer(store, async (base) => {
    const res = await fetch(`${base}/auth/github/callback?code=good-code&format=json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.session_token);
    assert.equal(body.github_login, "alice");
    // The session token works on write endpoints.
    const { status, json } = await postJson(
      base, "/v1/claims", { owner: "acme", repo: "repo", issue: 42 }, body.session_token
    );
    assert.equal(status, 201);
    assert.equal(json.action, "claimed");
  });
});
