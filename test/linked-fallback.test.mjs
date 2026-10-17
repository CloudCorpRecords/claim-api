/**
 * Linked-PR fallback tests (claim-api 0.1.1).
 *
 * Incident: the issue timeline returned without its cross-referenced
 * events under a fine-grained PAT, so a linked claim was misread as
 * "active". These tests pin the fix: when the timeline fails or comes
 * back empty, the service scans the repo's open PRs for closing intent
 * (same classification as the Greenlight digest), and any remaining gap
 * is reported in data_quality instead of failing silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createSessions } from "../src/sessions.mjs";
import { createCache } from "../src/cache.mjs";
import { httpError } from "../src/github.mjs";
import { fetchOpenPrLinks } from "../src/protocol-live.mjs";

const CLAIM_MARKER = "<!-- greenlight-claim v1 -->";

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

function aliceFixPr() {
  return {
    number: 900,
    title: "[AI] Fix the thing properly",
    body: "Fixes #42\n\nThe initial implementation was drafted with AI assistance and then reviewed and edited by the human.",
    head: { ref: "fix/thing-42" },
    user: { login: "alice" },
    state: "open",
    created_at: new Date().toISOString(),
  };
}

function makeFactory({ timeline = [], timelineError = null, pulls = [], pullsError = null } = {}) {
  return ({ token } = {}) => ({
    async user() { return { login: "alice", id: 1 }; },
    async getIssue() { return { number: 42, title: "Fix the thing", state: "open" }; },
    async getComments() { return [aliceClaimComment()]; },
    async getCommentReactions() {
      return [{ user: { login: "alice" }, content: "rocket" }];
    },
    async getTimeline() {
      if (timelineError) throw timelineError;
      return timeline;
    },
    async getPull() { return null; },
    async listOpenPulls() {
      if (pullsError) throw pullsError;
      return pulls;
    },
    async getClaimsPolicy() { return null; },
  });
}

async function withServer(factoryOpts, fn) {
  const app = createApp({
    githubFactory: makeFactory(factoryOpts),
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

test("timeline 403 + PR scan finds the claimant's 'Fixes #N' PR: state linked, timeline gap flagged", async () => {
  await withServer(
    { timelineError: httpError(403, "github-forbidden", "Resource not accessible by personal access token"), pulls: [aliceFixPr()] },
    async (base) => {
      const res = await fetch(`${base}/v1/issues/acme/repo/42/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.claim.state, "linked");
      assert.equal(body.claim.claimant, "alice");
      assert.ok(body.reason.includes("linked"), "reason names the linked state");
      assert.ok(
        body.competing_prs.some((p) => p.number === 900),
        "scan-found PR appears in competing_prs"
      );
      assert.equal(body.data_quality.degraded, true);
      assert.ok(body.data_quality.missing.includes("timeline"), "timeline gap is disclosed");
    }
  );
});

test("timeline healthy but event-less + PR scan finds the PR: still linked, timeline flagged incomplete", async () => {
  await withServer(
    { timeline: [], pulls: [aliceFixPr()] },
    async (base) => {
      const res = await fetch(`${base}/v1/issues/acme/repo/42/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.claim.state, "linked");
      assert.equal(body.data_quality.degraded, true);
      assert.ok(body.data_quality.missing.includes("timeline"), "incomplete timeline disclosed");
    }
  );
});

test("timeline 403 + PR scan finds nothing: state active, degraded flag present", async () => {
  await withServer(
    { timelineError: httpError(403, "github-forbidden", "nope"), pulls: [] },
    async (base) => {
      const res = await fetch(`${base}/v1/issues/acme/repo/42/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.claim.state, "active");
      assert.equal(body.claim.claimant, "alice");
      assert.deepEqual(body.data_quality, { degraded: true, missing: ["timeline"] });
    }
  );
});

test("timeline 403 + PR scan itself fails: both gaps disclosed", async () => {
  await withServer(
    {
      timelineError: httpError(403, "github-forbidden", "nope"),
      pullsError: httpError(502, "github-error", "GitHub 500"),
    },
    async (base) => {
      const res = await fetch(`${base}/v1/issues/acme/repo/42/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.claim.state, "active");
      assert.equal(body.data_quality.degraded, true);
      assert.ok(body.data_quality.missing.includes("timeline"));
      assert.ok(body.data_quality.missing.includes("pr-scan"));
    }
  );
});

test("claims chain payload carries data_quality too", async () => {
  await withServer(
    { timelineError: httpError(403, "github-forbidden", "nope"), pulls: [] },
    async (base) => {
      const res = await fetch(`${base}/v1/claims/acme/repo/42`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.active.claimant, "alice");
      assert.deepEqual(body.data_quality, { degraded: true, missing: ["timeline"] });
    }
  );
});

test("open-PR scan is cached per repo", async () => {
  let calls = 0;
  const github = {
    async listOpenPulls() {
      calls += 1;
      return [aliceFixPr()];
    },
  };
  const cache = createCache();
  const first = await fetchOpenPrLinks(github, cache, "acme", "repo", 42);
  const second = await fetchOpenPrLinks(github, cache, "acme", "repo", 42);
  assert.equal(calls, 1, "second scan served from cache");
  assert.equal(first.inputs.length, 1);
  assert.equal(second.inputs[0].number, 900);
  assert.equal(first.details[0].source, "pr-scan");
});

test("open-PR scan ignores PRs without closing intent", async () => {
  const github = {
    async listOpenPulls() {
      return [
        { number: 901, title: "Unrelated refactor", body: "no links here", head: { ref: "refactor" }, user: { login: "bob" }, state: "open", created_at: new Date().toISOString() },
      ];
    },
  };
  const { inputs } = await fetchOpenPrLinks(github, null, "acme", "repo", 42);
  assert.equal(inputs.length, 0);
});

test("open-PR scan reports truncation when the PR list hits the page cap", async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    number: 1000 + i,
    title: "x",
    body: "y",
    head: { ref: "z" },
    user: { login: "bob" },
    state: "open",
    created_at: new Date().toISOString(),
  }));
  const github = { async listOpenPulls() { return many; } };
  const { truncated } = await fetchOpenPrLinks(github, null, "acme", "repo", 42);
  assert.equal(truncated, true);
});
