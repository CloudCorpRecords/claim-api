/**
 * Tests: webhook event handlers, every transition.
 * Store is the memory backend; the GitHub client is a stub.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppStore } from "../src/app-store.mjs";
import {
  handleIssueComment,
  handlePullRequest,
  handleIssues,
  handleInstallation,
  handleInstallationRepositories,
  installationForRepo,
  runSweep,
} from "../src/app-handlers.mjs";

const CLAIM = "<!-- greenlight-claim v1 -->";
const RELEASE = "<!-- greenlight-claim release -->";

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

/** Stub installation-token GitHub client. */
function stubGithub({ policy = null, files = {} } = {}) {
  return {
    async getClaimsPolicy() {
      return policy ? { content: b64(policy) } : null;
    },
    async getContents(owner, repo, path) {
      if (!(path in files)) {
        const err = new Error("not found");
        err.httpStatus = 404;
        throw err;
      }
      return { content: b64(files[path]) };
    },
    async listDir() {
      return null;
    },
  };
}

function ctx(store, github, nowMs) {
  return {
    store,
    github,
    cache: null,
    now: () => new Date(nowMs || "2026-10-18T12:00:00Z"),
  };
}

function commentEvent(over = {}) {
  return {
    action: "created",
    owner: "acme",
    repo: "repo",
    issue: { number: 42, state: "open", title: "Fix the thing" },
    comment: {
      id: 1001,
      body: `I will take this.\n\n${CLAIM}\nplan: fix it`,
      author: "alice",
      created_at: "2026-10-18T12:00:00Z",
      html_url: "https://github.com/acme/repo/issues/42#issuecomment-1001",
    },
    ...over,
  };
}

async function freshStore() {
  return createAppStore({ config: { stateMode: "memory" } });
}

test("claim intent on an open issue becomes active", async () => {
  const store = await freshStore();
  const r = await handleIssueComment(ctx(store, stubGithub()), commentEvent());
  assert.equal(r.outcome, "claimed");
  assert.equal(r.valid, true);
  const state = await store.getRepoState("acme", "repo");
  const active = state.issues["42"].active;
  assert.equal(active.claimant, "alice");
  assert.equal(active.state, "active");
  assert.equal(active.lease_days, 7);
  assert.equal(active.comment_id, 1001);
  assert.ok(active.expires_at > active.claimed_at);
});

test("second claimant queues at position 2", async () => {
  const store = await freshStore();
  const c = ctx(store, stubGithub());
  await handleIssueComment(c, commentEvent());
  const r = await handleIssueComment(
    c,
    commentEvent({ comment: { id: 1002, body: `Me too.\n\n${CLAIM}`, author: "bob", created_at: "2026-10-18T12:05:00Z", html_url: "u2" } })
  );
  assert.equal(r.outcome, "queued");
  assert.equal(r.queue_position, 2);
  const state = await store.getRepoState("acme", "repo");
  assert.equal(state.issues["42"].queue.length, 1);
  assert.equal(state.issues["42"].active.claimant, "alice");
});

test("re-claim by the holder is a heartbeat that extends the lease", async () => {
  const store = await freshStore();
  const c = ctx(store, stubGithub(), "2026-10-18T12:00:00Z");
  await handleIssueComment(c, commentEvent());
  const before = (await store.getRepoState("acme", "repo")).issues["42"].active.expires_at;
  const c2 = ctx(store, stubGithub(), "2026-10-20T12:00:00Z");
  const r = await handleIssueComment(
    c2,
    commentEvent({ comment: { id: 1003, body: `Still on it.\n\n${CLAIM}`, author: "alice", created_at: "2026-10-20T12:00:00Z", html_url: "u3" } })
  );
  assert.equal(r.outcome, "heartbeat");
  const after = (await store.getRepoState("acme", "repo")).issues["42"].active;
  assert.ok(after.expires_at > before);
  assert.equal(after.last_heartbeat_at, "2026-10-20T12:00:00.000Z");
});

test("release by the holder frees the issue and promotes the queue head", async () => {
  const store = await freshStore();
  const c = ctx(store, stubGithub());
  await handleIssueComment(c, commentEvent());
  await handleIssueComment(
    c,
    commentEvent({ comment: { id: 1002, body: `Me too.\n\n${CLAIM}`, author: "bob", created_at: "2026-10-18T12:05:00Z", html_url: "u2" } })
  );
  const r = await handleIssueComment(
    c,
    commentEvent({
      comment: { id: 1004, body: `Done here.\n\n${RELEASE}`, author: "alice", created_at: "2026-10-18T13:00:00Z", html_url: "u4" },
    })
  );
  assert.equal(r.outcome, "released");
  assert.equal(r.promoted, "bob");
  const state = await store.getRepoState("acme", "repo");
  assert.equal(state.issues["42"].active.claimant, "bob");
  assert.equal(state.issues["42"].queue.length, 0);
});

test("release by a stranger is ignored; maintainer supersede works", async () => {
  const policy = JSON.stringify({ protocol: 1, lease_days: 7, maintainers: ["carol"] });
  const store = await freshStore();
  const c = ctx(store, stubGithub({ policy }));
  await handleIssueComment(c, commentEvent());
  const r1 = await handleIssueComment(
    c,
    commentEvent({ comment: { id: 1005, body: `Releasing.\n\n${RELEASE}`, author: "mallory", created_at: "2026-10-18T13:00:00Z", html_url: "u5" } })
  );
  assert.equal(r1.outcome, "ignored");
  const r2 = await handleIssueComment(
    c,
    commentEvent({ comment: { id: 1006, body: `Reassigning.\n\n${RELEASE}`, author: "carol", created_at: "2026-10-18T13:05:00Z", html_url: "u6" } })
  );
  assert.equal(r2.outcome, "released");
  assert.equal(r2.reason, "superseded-by-maintainer");
});

test("claim on a closed issue is ignored", async () => {
  const store = await freshStore();
  const r = await handleIssueComment(
    ctx(store, stubGithub()),
    commentEvent({ issue: { number: 42, state: "closed", title: "t" } })
  );
  assert.equal(r.outcome, "ignored");
  assert.equal(r.reason, "issue-not-open");
});

test("deleting the claim comment is an implicit release", async () => {
  const store = await freshStore();
  const c = ctx(store, stubGithub());
  await handleIssueComment(c, commentEvent());
  await handleIssueComment(
    c,
    commentEvent({ comment: { id: 1002, body: `Me too.\n\n${CLAIM}`, author: "bob", created_at: "2026-10-18T12:05:00Z", html_url: "u2" } })
  );
  const r = await handleIssueComment(
    c,
    commentEvent({ action: "deleted", comment: { id: 1001, body: "", author: "alice" } })
  );
  assert.equal(r.outcome, "released");
  assert.equal(r.reason, "comment-deleted");
  assert.equal(r.promoted, "bob");
});

test("gated repo: claim recorded valid:false with gate evidence", async () => {
  const files = {
    "CONTRIBUTING.md": "# C\nWe have temporarily paused unsolicited pull requests from outside the core team.\n",
  };
  const store = await freshStore();
  const r = await handleIssueComment(ctx(store, stubGithub({ files })), commentEvent());
  assert.equal(r.outcome, "claimed");
  assert.equal(r.valid, false);
  assert.ok(r.invalid_reason.includes("unsolicited_prs_paused"));
  const active = (await store.getRepoState("acme", "repo")).issues["42"].active;
  assert.equal(active.valid, false);
});

test("lease_days clamps to 1..30, default 7", async () => {
  for (const [lease, expected] of [[99, 30], [0, 1], [3, 3], [null, 7]]) {
    const policy = lease === null ? null : JSON.stringify({ protocol: 1, lease_days: lease });
    const store = await freshStore();
    await handleIssueComment(ctx(store, stubGithub({ policy })), commentEvent());
    const active = (await store.getRepoState("acme", "repo")).issues["42"].active;
    assert.equal(active.lease_days, expected, `lease ${lease}`);
  }
});

test("on-behalf-of attributes the claim to the named login, posted via app", async () => {
  const store = await freshStore();
  const r = await handleIssueComment(
    ctx(store, stubGithub()),
    commentEvent({
      comment: {
        id: 1010,
        body: `> Posted by the Greenlight Claims app for @dave.\n\nClaiming.\n\n${CLAIM}\non-behalf-of: dave`,
        author: "greenlight-claims[bot]",
        created_at: "2026-10-18T12:00:00Z",
        html_url: "u10",
      },
    })
  );
  assert.equal(r.outcome, "claimed");
  assert.equal(r.claimant, "dave");
  const active = (await store.getRepoState("acme", "repo")).issues["42"].active;
  assert.equal(active.posted_via, "app");
});

function prEvent(over = {}) {
  return {
    action: "opened",
    owner: "acme",
    repo: "repo",
    pr: {
      number: 7,
      title: "Fix the thing",
      body: "Fixes #42",
      author: "alice",
      merged: false,
      html_url: "https://github.com/acme/repo/pull/7",
      head_branch: "fix-thing",
    },
    ...over,
  };
}

test("PR opened with closing intent links the claim and freezes the lease", async () => {
  const store = await freshStore();
  const c = ctx(store, stubGithub());
  await handleIssueComment(c, commentEvent());
  const before = (await store.getRepoState("acme", "repo")).issues["42"].active.expires_at;
  const r = await handlePullRequest(c, prEvent());
  assert.equal(r.outcome, "transitioned");
  assert.equal(r.transitions[0].to, "linked");
  const active = (await store.getRepoState("acme", "repo")).issues["42"].active;
  assert.equal(active.state, "linked");
  assert.equal(active.linked_pr, 7);
  assert.equal(active.expires_at, before);
});

test("PR merged completes the claim; closed unmerged marks linked-dead", async () => {
  const store = await freshStore();
  const c = ctx(store, stubGithub());
  await handleIssueComment(c, commentEvent());
  await handlePullRequest(c, prEvent());
  const r1 = await handlePullRequest(
    c,
    prEvent({ action: "closed", pr: { number: 7, title: "t", body: "Fixes #42", author: "alice", merged: true, html_url: "u", head_branch: "b" } })
  );
  assert.equal(r1.transitions[0].to, "completed");

  const store2 = await freshStore();
  const c2 = ctx(store2, stubGithub());
  await handleIssueComment(c2, commentEvent());
  await handlePullRequest(c2, prEvent());
  const r2 = await handlePullRequest(
    c2,
    prEvent({ action: "closed", pr: { number: 7, title: "t", body: "Fixes #42", author: "alice", merged: false, html_url: "u", head_branch: "b" } })
  );
  assert.equal(r2.transitions[0].to, "linked-dead");
});

test("PR without closing intent does not link", async () => {
  const store = await freshStore();
  const c = ctx(store, stubGithub());
  await handleIssueComment(c, commentEvent());
  const r = await handlePullRequest(
    c,
    prEvent({ pr: { number: 8, title: "Unrelated", body: "see #42 for context", author: "bob", merged: false, html_url: "u", head_branch: "x" } })
  );
  assert.equal(r.outcome, "ignored");
});

test("issues closed releases the claim; reopened does not restore", async () => {
  const store = await freshStore();
  const c = ctx(store, stubGithub());
  await handleIssueComment(c, commentEvent());
  const r1 = await handleIssues(c, { action: "closed", owner: "acme", repo: "repo", issue: { number: 42, state: "closed" } });
  assert.equal(r1.outcome, "released");
  assert.equal(r1.reason, "issue-closed");
  const r2 = await handleIssues(c, { action: "reopened", owner: "acme", repo: "repo", issue: { number: 42, state: "open" } });
  assert.equal(r2.reason, "no-auto-restore");
  assert.equal((await store.getRepoState("acme", "repo")).issues["42"].active, null);
});

test("installation bookkeeping: create, repos change, delete", async () => {
  const store = await freshStore();
  const c = ctx(store, stubGithub());
  await handleInstallation(c, {
    action: "created",
    installation: { id: 11, account_login: "acme", account_type: "Organization", repos: [{ owner: "acme", repo: "a" }] },
  });
  assert.equal(await installationForRepo(store, "acme", "a"), "11");
  assert.equal(await installationForRepo(store, "acme", "b"), null);
  await handleInstallationRepositories(c, {
    action: "added",
    installation: { id: 11 },
    added: [{ owner: "acme", repo: "b" }],
    removed: [],
  });
  assert.equal(await installationForRepo(store, "acme", "b"), "11");
  await handleInstallation(c, { action: "deleted", installation: { id: 11 } });
  assert.equal(await installationForRepo(store, "acme", "a"), null);
});

test("runSweep expires stale leases, enforces the tenure cap, spares linked claims", async () => {
  const store = await freshStore();
  // alice claims at t0 with a 1-day lease; bob queues behind her.
  const t0 = "2026-10-10T12:00:00Z";
  const policy = JSON.stringify({ protocol: 1, lease_days: 1 });
  const c0 = ctx(store, stubGithub({ policy }), t0);
  await handleIssueComment(c0, commentEvent({
    comment: { id: 1001, body: `I will take this.\n\n${CLAIM}\nplan: fix it`, author: "alice", created_at: t0, html_url: "u1" },
  }));
  await handleIssueComment(
    c0,
    commentEvent({ comment: { id: 1002, body: `Me too.\n\n${CLAIM}`, author: "bob", created_at: t0, html_url: "u2" } })
  );
  // Sweep 3 days later: alice's lease expired, bob promotes.
  const r = await runSweep(ctx(store, stubGithub(), "2026-10-13T12:00:00Z"));
  assert.equal(r.expired, 1);
  assert.equal(r.promoted, 1);
  const entry = (await store.getRepoState("acme", "repo")).issues["42"];
  assert.equal(entry.active.claimant, "bob");
  assert.equal(entry.history.filter((h) => h.event === "expired").length, 1);

  // Tenure cap: seed a claim with a 30-day lease but a 28-day tenure cap
  // (the engine ties tenure to lease, so this seeds the store directly to
  // exercise the sweep's own tenure math). Swept at 29 days: the lease is
  // still live, but the tenure cap fires.
  const store2 = await freshStore();
  await store2.putRepoState("acme", "repo", {
    issues: {
      42: {
        active: {
          v: 1, repo: "acme/repo", issue: 42, claimant: "alice",
          claimed_at: t0, comment_id: 1001, comment_url: "u1",
          state: "active", lease_days: 30, tenure_cap_days: 28,
          expires_at: "2026-11-09T12:00:00Z",
          last_heartbeat_at: t0, linked_pr: null, queue_position: 1,
          valid: true, invalid_reason: null, posted_via: "comment",
          history: [{ event: "claimed", at: t0, by: "alice", evidence: "u1" }],
        },
        queue: [],
        history: [],
      },
    },
  });
  const r2 = await runSweep(ctx(store2, stubGithub(), "2026-11-08T12:00:00Z"));
  assert.equal(r2.expired, 1);
  const entry2 = (await store2.getRepoState("acme", "repo")).issues["42"];
  assert.equal(entry2.active, null);
  assert.equal(entry2.history.filter((h) => h.event === "expired" && h.reason === "tenure-cap").length, 1);

  // Linked claims are spared: lease frozen.
  const store3 = await freshStore();
  const cB = ctx(store3, stubGithub({ policy }), t0);
  await handleIssueComment(cB, commentEvent());
  await handlePullRequest(cB, prEvent());
  const r3 = await runSweep(ctx(store3, stubGithub(), "2026-10-20T12:00:00Z"));
  assert.equal(r3.expired, 0);
  assert.equal((await store3.getRepoState("acme", "repo")).issues["42"].active.state, "linked");
});
