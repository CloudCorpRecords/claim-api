/**
 * Live protocol state assembly: fetch public GitHub data for one issue and
 * run the Greenlight engine over it. Same logic as the claim-ledger indexer,
 * minus the budget batching (this endpoint answers one issue).
 */

import {
  computeClaimState,
  parseClaimsPolicy,
  defaultClaimsPolicy,
  buildIssueStatus,
  CLAIM_MARKER,
  RELEASE_MARKER,
} from "@reneturcios/greenlight/dist/protocol.js";
import { classifyLinkStrength } from "@reneturcios/greenlight/dist/linkstrength.js";

export async function fetchPolicyState(github, owner, repo) {
  const data = await github.getClaimsPolicy(owner, repo);
  if (!data || !data.content) {
    return { honored: false, policy: defaultClaimsPolicy(), invalid: false };
  }
  const text = Buffer.from(data.content, "base64").toString("utf8");
  const policy = parseClaimsPolicy(text);
  return { honored: true, policy, invalid: !!policy.invalid };
}

function engineComments(rawComments) {
  return (rawComments || []).map((c) => ({
    id: c.id,
    author: c.user && c.user.login,
    body: c.body || "",
    createdAt: c.created_at,
    url: c.html_url,
  }));
}

export async function fetchLinkedPrs(github, owner, repo, number) {
  const timeline = await github.getTimeline(owner, repo, number);
  const numbers = [];
  for (const ev of timeline || []) {
    const src = ev && ev.source && ev.source.issue;
    if (ev.event === "cross-referenced" && src && src.pull_request && !numbers.includes(src.number)) {
      numbers.push(src.number);
    }
  }
  const inputs = [];
  const details = [];
  for (const prNumber of numbers.slice(0, 10)) {
    const pr = await github.getPull(owner, repo, prNumber);
    if (!pr) continue;
    const strength = classifyLinkStrength({
      title: pr.title || "",
      body: pr.body || "",
      branch: (pr.head && pr.head.ref) || "",
      issueNumber: number,
    });
    if (strength !== "closing") continue;
    const state = pr.merged_at ? "merged" : pr.state;
    inputs.push({ number: prNumber, state, createdAt: pr.created_at });
    details.push({ number: prNumber, author: pr.user && pr.user.login, state, createdAt: pr.created_at || null });
  }
  return { inputs, details };
}

export async function assembleProtocolState(github, owner, repo, number, nowIso) {
  const rawComments = (await github.getComments(owner, repo, number)) || [];
  const reactions = [];
  for (const c of rawComments) {
    if (!(c.body || "").includes(CLAIM_MARKER)) continue;
    const rs = (await github.getCommentReactions(owner, repo, c.id)) || [];
    for (const r of rs) {
      reactions.push({ commentId: c.id, user: r.user && r.user.login, content: r.content });
    }
  }
  const { inputs: linkedPrs, details: linkedPrDetails } = await fetchLinkedPrs(github, owner, repo, number);
  const mergedPrNumber = linkedPrDetails.find((d) => d.state === "merged")?.number ?? null;
  const { honored, policy } = await fetchPolicyState(github, owner, repo);

  const computation = computeClaimState({
    comments: engineComments(rawComments),
    reactions,
    linkedPrs,
    mergedPrNumber,
    policy,
    now: nowIso,
    repo: `${owner}/${repo}`,
    issue: number,
  });
  return { computation, linkedPrDetails, honored, policy };
}

export function buildStatusPayload({ owner, repo, number, issueTitle, computation, linkedPrDetails, honored, policy, checkedAt }) {
  const payload = buildIssueStatus({
    issueUrl: `https://github.com/${owner}/${repo}/issues/${number}`,
    computation,
    competingPrs: linkedPrDetails.map((d) => ({ number: d.number, author: d.author, state: d.state })),
    gates: [],
    repoProtocol: honored
      ? { honored: true, lease_days: policy.lease_days }
      : { honored: false, lease_days: policy.lease_days },
    checkedAt,
    staleAfterSeconds: 60,
  });
  return {
    ...payload,
    issue_title: issueTitle || null,
    _api_note: "Live read: computed from GitHub comments at checked_at. Gates are not evaluated by this service (empty); use greenlight check for gates.",
  };
}

export { CLAIM_MARKER, RELEASE_MARKER };
