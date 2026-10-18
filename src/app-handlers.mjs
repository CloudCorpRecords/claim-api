/**
 * Webhook event handlers for the Greenlight Claims GitHub App.
 *
 * Every handler is a pure-ish function of (ctx, event) that reads and writes
 * the durable app store; the only GitHub calls are policy and gate reads
 * under the event's installation token. The app never posts comments on
 * third-party repos from webhooks: all transitions here are state-only and
 * visible in the ledger.
 *
 * ctx: { store, github, cache, now } where github is an installation-token
 * client (createServiceGitHub) and now() returns a Date.
 */

import {
  parseClaimComment,
  parseClaimsPolicy,
  defaultClaimsPolicy,
} from "@reneturcios/greenlight/dist/protocol.js";
import { classifyLinkStrength } from "@reneturcios/greenlight/dist/linkstrength.js";
import { checkRepoGates } from "./app-gates.mjs";

const ON_BEHALF_OF_RE = /^on-behalf-of:\s*([A-Za-z0-9-]+)\s*$/im;
const ISSUE_REF_RE = /#(\d+)/g;
const TENURE_CAP_DEFAULT_DAYS = 28;

function isoNow(ctx) {
  return (ctx.now ? ctx.now() : new Date()).toISOString();
}

function clampLeaseDays(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 7;
  return Math.min(30, Math.max(1, Math.floor(n)));
}

async function readPolicy(github, owner, repo) {
  try {
    const data = await github.getClaimsPolicy(owner, repo);
    if (data && data.content) {
      const text = Buffer.from(data.content, "base64").toString("utf8");
      const policy = parseClaimsPolicy(text);
      if (policy && !policy.invalid) return { honored: true, policy };
    }
  } catch {
    // fall through to defaults
  }
  return { honored: false, policy: defaultClaimsPolicy() };
}

function emptyIssueEntry() {
  return { active: null, queue: [], history: [] };
}

function getEntry(state, number) {
  const key = String(number);
  if (!state.issues[key]) state.issues[key] = emptyIssueEntry();
  return state.issues[key];
}

function pushHistory(entry, event) {
  entry.history.push(event);
}

function buildClaim({ ctx, owner, repo, number, claimant, comment, parsed, policy, gates, queuePosition, postedVia }) {
  const now = isoNow(ctx);
  const leaseDays = clampLeaseDays(policy.lease_days);
  const tenureCapDays = Number(policy.tenure_cap_days) > 0 ? Math.floor(Number(policy.tenure_cap_days)) : TENURE_CAP_DEFAULT_DAYS;
  const claimedAt = comment.created_at || now;
  const hard = (gates && gates.hard) || [];
  const aiBan = gates && gates.aiBan;
  const gateBlockers = hard.map((g) => `${g.kind}${g.evidence ? `: ${g.evidence}` : ""}`);
  if (aiBan) gateBlockers.push(`ai_generated_banned: ${aiBan.evidence}`);
  let valid = gateBlockers.length === 0;
  let invalidReason = gateBlockers.length ? `GATED: ${gateBlockers.join("; ")}` : null;
  if (policy.who_can_claim && policy.who_can_claim !== "anyone") {
    valid = false;
    invalidReason = `who_can_claim=${policy.who_can_claim}: this repo does not take open protocol claims`;
  }
  return {
    v: 1,
    repo: `${owner}/${repo}`,
    issue: number,
    claimant,
    claimed_at: claimedAt,
    comment_id: comment.id,
    comment_url: comment.html_url,
    state: queuePosition === 1 ? "active" : "queued",
    lease_days: leaseDays,
    tenure_cap_days: tenureCapDays,
    expires_at: new Date(new Date(claimedAt).getTime() + leaseDays * 864e5).toISOString(),
    last_heartbeat_at: claimedAt,
    linked_pr: null,
    queue_position: queuePosition,
    plan: parsed.plan || null,
    eta_days: parsed.etaDays || null,
    valid,
    invalid_reason: invalidReason,
    posted_via: postedVia,
    history: [
      {
        event: queuePosition === 1 ? "claimed" : "queued",
        at: now,
        by: claimant,
        evidence: comment.html_url,
        ...(valid ? {} : { invalid_reason: invalidReason }),
      },
    ],
  };
}

/**
 * Promote the queue head to active. Called after a release or an expiry.
 * Returns the promoted claim or null.
 */
function promoteQueue(ctx, entry, { leaseDays }) {
  const now = isoNow(ctx);
  const head = entry.queue.shift();
  if (!head) return null;
  head.state = "active";
  head.claimed_at = now;
  head.last_heartbeat_at = now;
  head.expires_at = new Date(new Date(now).getTime() + leaseDays * 864e5).toISOString();
  head.queue_position = 1;
  head.linked_pr = null;
  pushHistory(head, { event: "promoted", at: now, by: "system", evidence: null });
  entry.active = head;
  entry.queue.forEach((c, i) => {
    c.queue_position = i + 2;
  });
  return head;
}

function releaseActive(ctx, entry, { by, reason, leaseDays }) {
  const now = isoNow(ctx);
  const active = entry.active;
  if (!active) return null;
  active.state = "released";
  active.ended_at = now;
  pushHistory(active, { event: "released", at: now, by, reason });
  pushHistory(entry, { event: "released", at: now, by, reason, claim: active.claimant });
  entry.active = null;
  return promoteQueue(ctx, entry, { leaseDays });
}

// ------------------------------------------------------- issue_comment ---

export async function handleIssueComment(ctx, event) {
  const { owner, repo } = event;
  const number = event.issue.number;
  const comment = event.comment;

  if (event.action === "deleted") {
    const state = await ctx.store.getRepoState(owner, repo);
    const entry = getEntry(state, number);
    if (entry.active && entry.active.comment_id === comment.id) {
      const { policy } = await readPolicy(ctx.github, owner, repo);
      const promoted = releaseActive(ctx, entry, {
        by: comment.author,
        reason: "comment-deleted",
        leaseDays: clampLeaseDays(policy.lease_days),
      });
      await ctx.store.putRepoState(owner, repo, state);
      return { outcome: "released", reason: "comment-deleted", promoted: promoted ? promoted.claimant : null };
    }
    return { outcome: "ignored", reason: "deleted-comment-was-not-the-claim" };
  }

  const parsed = parseClaimComment(comment.body || "");
  const onBehalfOf = (comment.body || "").match(ON_BEHALF_OF_RE);
  const claimant = (onBehalfOf && onBehalfOf[1]) || comment.author;
  const postedVia = onBehalfOf ? "app" : "comment";

  const state = await ctx.store.getRepoState(owner, repo);
  const entry = getEntry(state, number);

  // Edited comment that dropped the marker behaves like a deletion.
  if (!parsed.isClaim && !parsed.isRelease) {
    if (event.action === "edited" && entry.active && entry.active.comment_id === comment.id) {
      const { policy } = await readPolicy(ctx.github, owner, repo);
      const promoted = releaseActive(ctx, entry, {
        by: comment.author,
        reason: "claim-marker-removed",
        leaseDays: clampLeaseDays(policy.lease_days),
      });
      await ctx.store.putRepoState(owner, repo, state);
      return { outcome: "released", reason: "claim-marker-removed", promoted: promoted ? promoted.claimant : null };
    }
    return { outcome: "ignored", reason: "no-protocol-marker" };
  }

  if (parsed.isRelease) {
    const { policy } = await readPolicy(ctx.github, owner, repo);
    const active = entry.active;
    const isHolder = active && active.claimant === claimant;
    const isMaintainer = (policy.maintainers || []).some(
      (m) => String(m).toLowerCase() === String(claimant).toLowerCase()
    );
    if (!active || (active.state !== "active" && active.state !== "linked")) {
      return { outcome: "ignored", reason: "no-active-claim-to-release" };
    }
    if (!isHolder && !isMaintainer) {
      return { outcome: "ignored", reason: "release-not-by-holder-or-maintainer" };
    }
    const promoted = releaseActive(ctx, entry, {
      by: claimant,
      reason: isHolder ? "released-by-holder" : "superseded-by-maintainer",
      leaseDays: clampLeaseDays(policy.lease_days),
    });
    await ctx.store.putRepoState(owner, repo, state);
    return {
      outcome: "released",
      reason: isHolder ? "released-by-holder" : "superseded-by-maintainer",
      promoted: promoted ? promoted.claimant : null,
    };
  }

  // Claim intent.
  if (event.issue.state !== "open") {
    return { outcome: "ignored", reason: "issue-not-open" };
  }
  const { policy } = await readPolicy(ctx.github, owner, repo);
  const gates = await checkRepoGates({ github: ctx.github, owner, repo, cache: ctx.cache });
  const now = isoNow(ctx);
  const active = entry.active;
  const live = active && (active.state === "active" || active.state === "linked");

  if (live && active.claimant === claimant) {
    // Re-claim by the holder is a heartbeat: the lease extends.
    const leaseDays = clampLeaseDays(policy.lease_days);
    active.expires_at = new Date(new Date(now).getTime() + leaseDays * 864e5).toISOString();
    active.last_heartbeat_at = now;
    pushHistory(active, { event: "heartbeat", at: now, by: claimant, evidence: comment.html_url });
    pushHistory(entry, { event: "heartbeat", at: now, by: claimant, claim: claimant });
    await ctx.store.putRepoState(owner, repo, state);
    return { outcome: "heartbeat", claimant, expires_at: active.expires_at };
  }

  if (live) {
    const claim = buildClaim({
      ctx, owner, repo, number, claimant, comment, parsed, policy, gates,
      queuePosition: entry.queue.length + 2, postedVia,
    });
    entry.queue.push(claim);
    pushHistory(entry, { event: "queued", at: now, by: claimant, claim: claimant, position: claim.queue_position });
    await ctx.store.putRepoState(owner, repo, state);
    return { outcome: "queued", claimant, queue_position: claim.queue_position, valid: claim.valid };
  }

  const claim = buildClaim({
    ctx, owner, repo, number, claimant, comment, parsed, policy, gates,
    queuePosition: 1, postedVia,
  });
  entry.active = claim;
  pushHistory(entry, { event: "claimed", at: now, by: claimant, claim: claimant, valid: claim.valid });
  await ctx.store.putRepoState(owner, repo, state);
  return { outcome: "claimed", claimant, valid: claim.valid, invalid_reason: claim.invalid_reason };
}

// ------------------------------------------------------------ pull_request ---

function extractIssueNumbers(...texts) {
  const found = [];
  for (const text of texts) {
    if (!text) continue;
    ISSUE_REF_RE.lastIndex = 0;
    let m;
    while ((m = ISSUE_REF_RE.exec(text)) !== null) {
      const n = Number(m[1]);
      if (!found.includes(n)) found.push(n);
    }
  }
  return found;
}

export async function handlePullRequest(ctx, event) {
  const { owner, repo } = event;
  const pr = event.pr;
  const now = isoNow(ctx);
  const candidates = extractIssueNumbers(pr.title, pr.body, pr.head_branch);
  if (!candidates.length) return { outcome: "ignored", reason: "no-issue-reference" };

  const state = await ctx.store.getRepoState(owner, repo);
  const transitions = [];
  for (const n of candidates) {
    const entry = state.issues[String(n)];
    if (!entry || !entry.active) continue;
    const active = entry.active;
    if (active.state !== "active" && active.state !== "linked") continue;
    const strength = classifyLinkStrength({
      title: pr.title || "",
      body: pr.body || "",
      branch: pr.head_branch || "",
      issueNumber: n,
    });
    const linked = strength === "closing" || pr.author === active.claimant;
    if (!linked) continue;

    if (event.action === "opened" && active.state === "active") {
      active.state = "linked";
      active.linked_pr = pr.number;
      pushHistory(active, {
        event: "linked", at: now, by: pr.author, evidence: pr.html_url,
        detail: `PR #${pr.number} opened with closing intent; lease frozen`,
      });
      pushHistory(entry, { event: "linked", at: now, by: pr.author, claim: active.claimant, pr: pr.number });
      transitions.push({ issue: n, to: "linked", pr: pr.number });
    } else if (event.action === "closed" && active.linked_pr === pr.number) {
      if (pr.merged) {
        active.state = "completed";
        active.ended_at = now;
        pushHistory(active, { event: "completed", at: now, by: pr.author, evidence: pr.html_url });
        pushHistory(entry, { event: "completed", at: now, by: pr.author, claim: active.claimant, pr: pr.number });
        transitions.push({ issue: n, to: "completed", pr: pr.number });
      } else {
        active.state = "linked-dead";
        active.ended_at = now;
        pushHistory(active, {
          event: "linked-dead", at: now, by: pr.author, evidence: pr.html_url,
          detail: `Linked PR #${pr.number} closed unmerged`,
        });
        pushHistory(entry, { event: "linked-dead", at: now, by: pr.author, claim: active.claimant, pr: pr.number });
        transitions.push({ issue: n, to: "linked-dead", pr: pr.number });
      }
    }
  }
  if (transitions.length) await ctx.store.putRepoState(owner, repo, state);
  return transitions.length
    ? { outcome: "transitioned", transitions }
    : { outcome: "ignored", reason: "no-claim-link" };
}

// ------------------------------------------------------------------ issues ---

export async function handleIssues(ctx, event) {
  const { owner, repo } = event;
  const number = event.issue.number;
  const now = isoNow(ctx);
  if (event.action === "closed") {
    const state = await ctx.store.getRepoState(owner, repo);
    const entry = getEntry(state, number);
    const active = entry.active;
    if (active && (active.state === "active" || active.state === "linked")) {
      active.state = "released";
      active.ended_at = now;
      pushHistory(active, { event: "released", at: now, by: "system", reason: "issue-closed" });
      pushHistory(entry, { event: "released", at: now, by: "system", reason: "issue-closed", claim: active.claimant });
      entry.active = null;
      await ctx.store.putRepoState(owner, repo, state);
      return { outcome: "released", reason: "issue-closed", claimant: active.claimant };
    }
    return { outcome: "ignored", reason: "no-live-claim" };
  }
  if (event.action === "reopened") {
    return { outcome: "ignored", reason: "no-auto-restore" };
  }
  return { outcome: "ignored", reason: `unhandled-action:${event.action}` };
}

// ------------------------------------------------- installation bookkeeping ---

function repoKey(r) {
  return `${String(r.owner).toLowerCase()}/${String(r.repo).toLowerCase()}`;
}

export async function handleInstallation(ctx, event) {
  const now = isoNow(ctx);
  const data = await ctx.store.getInstallations();
  const list = data.installations || [];
  const id = String(event.installation.id);
  const idx = list.findIndex((i) => String(i.installation_id) === id);
  if (event.action === "deleted") {
    if (idx >= 0) list.splice(idx, 1);
  } else {
    const record = {
      installation_id: id,
      account: event.installation.account_login,
      account_type: event.installation.account_type || "User",
      repos: event.installation.repos || [],
      installed_at: idx >= 0 && list[idx].installed_at ? list[idx].installed_at : now,
      updated_at: now,
    };
    if (idx >= 0) list[idx] = record;
    else list.push(record);
  }
  await ctx.store.putInstallations({ installations: list });
  return { outcome: event.action === "deleted" ? "removed" : "upserted", installation_id: id };
}

export async function handleInstallationRepositories(ctx, event) {
  const now = isoNow(ctx);
  const data = await ctx.store.getInstallations();
  const list = data.installations || [];
  const id = String(event.installation.id);
  const rec = list.find((i) => String(i.installation_id) === id);
  if (!rec) return { outcome: "ignored", reason: "unknown-installation" };
  const have = new Map((rec.repos || []).map((r) => [repoKey(r), r]));
  for (const r of event.added || []) have.set(repoKey(r), r);
  for (const r of event.removed || []) have.delete(repoKey(r));
  rec.repos = [...have.values()];
  rec.updated_at = now;
  await ctx.store.putInstallations({ installations: list });
  return { outcome: "updated", installation_id: id, repos: rec.repos.length };
}

/** Find the installation id that covers owner/repo, or null. */
export async function installationForRepo(store, owner, repo) {
  const data = await store.getInstallations();
  const want = `${String(owner).toLowerCase()}/${String(repo).toLowerCase()}`;
  for (const i of data.installations || []) {
    for (const r of i.repos || []) {
      if (`${String(r.owner).toLowerCase()}/${String(r.repo).toLowerCase()}` === want) {
        return String(i.installation_id);
      }
    }
  }
  return null;
}

// -------------------------------------------------------------------- sweep ---

export async function runSweep(ctx) {
  const now = isoNow(ctx);
  const nowMs = new Date(now).getTime();
  const repos = await ctx.store.listRepos();
  let expired = 0;
  let promoted = 0;
  for (const { owner, repo } of repos) {
    const state = await ctx.store.getRepoState(owner, repo);
    let changed = false;
    for (const key of Object.keys(state.issues)) {
      const entry = state.issues[key];
      const active = entry.active;
      if (!active || active.state !== "active") continue;
      const leaseExpired = new Date(active.expires_at).getTime() <= nowMs;
      const tenureMs = (active.tenure_cap_days || TENURE_CAP_DEFAULT_DAYS) * 864e5;
      const tenureExceeded = !active.linked_pr && nowMs - new Date(active.claimed_at).getTime() > tenureMs;
      if (!leaseExpired && !tenureExceeded) continue;
      const reason = tenureExceeded ? "tenure-cap" : "lease-expired";
      active.state = "expired";
      active.ended_at = now;
      pushHistory(active, { event: "expired", at: now, by: "system", reason });
      pushHistory(entry, { event: "expired", at: now, by: "system", reason, claim: active.claimant });
      entry.active = null;
      expired += 1;
      const head = promoteQueue(ctx, entry, { leaseDays: active.lease_days || 7 });
      if (head) {
        promoted += 1;
        pushHistory(entry, { event: "promoted", at: now, by: "system", claim: head.claimant });
      }
      changed = true;
    }
    if (changed) await ctx.store.putRepoState(owner, repo, state);
  }
  return { repos: repos.length, expired, promoted, at: now };
}
