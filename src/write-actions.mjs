/**
 * Write actions: claim, release, heartbeat.
 *
 * Every write is a public GitHub comment posted with the USER's own token,
 * so the action appears as them, exactly as if they had posted by hand.
 * The service validates the intent against live protocol state first and
 * refuses when the spec says the issue is not claimable.
 */

import { buildClaimComment } from "@reneturcios/greenlight/dist/automate.js";
import { assembleProtocolState, RELEASE_MARKER } from "./protocol-live.mjs";
import { httpError } from "./server.mjs";

const QUEUE_OK_LINE = "queue-ok: yes";

function activeClaimByOther(computation, login) {
  const active = computation.active;
  if (!active) return null;
  if (active.state !== "active" && active.state !== "linked") return null;
  if (active.claimant === login) return null;
  return active;
}

/**
 * POST /v1/claims
 * Body: { owner, repo, issue, plan?, eta_days?, queue_ok? }
 *
 * Refuses: issue missing/closed; an active/linked claim held by someone else
 * unless queue_ok is set and the repo policy allows a queue (queue joining is
 * always allowed when the caller says queue_ok; the engine queues it).
 * Idempotent: if the caller already holds the active claim, returns it
 * unchanged instead of posting a duplicate (a re-claim would be a heartbeat
 * anyway per SPEC 3.3, so we do not double-post).
 */
export async function claimIssue({ github, owner, repo, number, login, body }) {
  const issue = await github.getIssue(owner, repo, number);
  if (!issue) throw httpError(404, "issue-not-found", `Issue ${owner}/${repo}#${number} does not exist.`);
  if (issue.state !== "open") throw httpError(409, "issue-closed", `Issue ${owner}/${repo}#${number} is ${issue.state}; only open issues can be claimed.`);
  if (issue.pull_request) throw httpError(400, "is-pull-request", "That number is a pull request, not an issue.");

  const nowIso = new Date().toISOString();
  const { computation, policy } = await assembleProtocolState(github, owner, repo, number, nowIso);

  if (computation.active && computation.active.claimant === login &&
      (computation.active.state === "active" || computation.active.state === "linked")) {
    return { action: "already-claimed", claim: computation.active, posted: false };
  }

  const holder = activeClaimByOther(computation, login);
  const queueOk = !!body.queue_ok;
  if (holder && !queueOk) {
    const conflict = httpError(409, "claim-held",
      `Issue is actively claimed by @${holder.claimant} until ${holder.expires_at}. Join the public queue instead by sending queue_ok: true.`);
    conflict.holder = { claimant: holder.claimant, expires_at: holder.expires_at, state: holder.state };
    throw conflict;
  }

  let commentBody = buildClaimComment(
    { title: issue.title },
    [],
    login,
    { plan: body.plan, etaDays: body.eta_days }
  );
  if (queueOk && holder) {
    // Join the queue explicitly; the parser must see the structured line.
    commentBody = commentBody.replace(
      "<!-- greenlight-claim v1 -->",
      `<!-- greenlight-claim v1 -->\n${QUEUE_OK_LINE}`
    );
  }
  const comment = await github.postIssueComment(owner, repo, number, commentBody);
  return {
    action: "claimed",
    posted: true,
    comment_url: comment && comment.html_url,
    claimant: login,
    queue_position: holder ? (computation.queue || []).length + 2 : 1,
    note: holder
      ? `@${holder.claimant} holds the active claim; your claim joins the public queue and promotes automatically when theirs ends.`
      : "Your claim is now active. The Ledger indexes it within ~15 minutes; this API reads it live immediately.",
  };
}

/**
 * POST /v1/claims/release
 * Body: { owner, repo, issue }
 *
 * Only the claim holder (or any caller with no active claim? no: the holder)
 * may release. Posts the release marker comment; the next queued claim
 * promotes on the next read, per SPEC 3.3.
 */
export async function releaseClaim({ github, owner, repo, number, login }) {
  const issue = await github.getIssue(owner, repo, number);
  if (!issue) throw httpError(404, "issue-not-found", `Issue ${owner}/${repo}#${number} does not exist.`);

  const nowIso = new Date().toISOString();
  const { computation } = await assembleProtocolState(github, owner, repo, number, nowIso);
  const active = computation.active;
  if (!active || (active.state !== "active" && active.state !== "linked")) {
    throw httpError(409, "no-active-claim", "There is no active protocol claim on this issue to release.");
  }
  if (active.claimant !== login) {
    throw httpError(403, "not-claim-holder", `The active claim is held by @${active.claimant}; only the holder (or a maintainer) can release it.`);
  }

  const body = [
    "Releasing my claim on this issue.",
    "",
    RELEASE_MARKER,
    "Released under the Greenlight Claim Protocol: the next claim in the queue may now promote.",
  ].join("\n");
  const comment = await github.postIssueComment(owner, repo, number, body);
  return {
    action: "released",
    posted: true,
    comment_url: comment && comment.html_url,
    released_by: login,
    note: "The queue promotes on the next read. The Ledger reflects this within ~15 minutes.",
  };
}

/**
 * POST /v1/claims/heartbeat
 * Body: { owner, repo, issue, mode?: "comment" | "reaction" }
 *
 * Renews the caller's active claim. mode "comment" (default) posts a minimal
 * heartbeat comment; mode "reaction" adds a rocket reaction to the caller's
 * own claim comment instead (API-visible, noise-free per SPEC 3.3).
 */
export async function heartbeatClaim({ github, owner, repo, number, login, mode = "comment" }) {
  const issue = await github.getIssue(owner, repo, number);
  if (!issue) throw httpError(404, "issue-not-found", `Issue ${owner}/${repo}#${number} does not exist.`);

  const nowIso = new Date().toISOString();
  const { computation } = await assembleProtocolState(github, owner, repo, number, nowIso);
  const active = computation.active;
  if (!active || active.state !== "active") {
    throw httpError(409, "no-active-claim", "You have no active protocol claim on this issue to renew (linked or completed claims do not need heartbeats).");
  }
  if (active.claimant !== login) {
    throw httpError(403, "not-claim-holder", `The active claim is held by @${active.claimant}; heartbeats renew only the holder's claim.`);
  }

  if (mode === "reaction") {
    const claimComment = (computation.claims || []).find(
      (c) => c.claimant === login && c.commentId
    );
    const commentId = claimComment && claimComment.commentId;
    if (!commentId) {
      throw httpError(409, "no-claim-comment", "No claim comment id found for your claim; use mode \"comment\" instead.");
    }
    await github.addCommentReaction(owner, repo, commentId, "rocket");
    return {
      action: "heartbeat",
      mode: "reaction",
      posted: true,
      note: "Rocket reaction added to your claim comment; your lease is renewed from now.",
    };
  }

  const body = "Heartbeat: still working on this.\n\n(Greenlight Claim Protocol: this comment renews my claim's lease.)";
  const comment = await github.postIssueComment(owner, repo, number, body);
  return {
    action: "heartbeat",
    mode: "comment",
    posted: true,
    comment_url: comment && comment.html_url,
    note: "Heartbeat posted; your lease is renewed from now.",
  };
}
