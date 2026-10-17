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
import { httpError } from "./github.mjs";

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

/**
 * Fallback linked-PR detection: scan the repo's open PRs for closing intent
 * toward this issue (PR body/title "Fixes #N" or the issue URL, via the same
 * link-strength classification the Greenlight digest uses).
 *
 * The issue timeline is the primary source, but under some tokens it comes
 * back without the cross-referenced events (observed with a fine-grained
 * PAT: 200 OK, no event, and the claim was misread as "active"), and the
 * endpoint itself can fail. This scan costs exactly one extra API call and
 * is cached per repo for PR_SCAN_TTL_MS.
 *
 * Returns { inputs, details, truncated }. details entries carry
 * source: "pr-scan". Throws when the PR list cannot be fetched, so the
 * caller can record the gap in data_quality instead of failing silently.
 */
const PR_SCAN_TTL_MS = 120_000;

export async function fetchOpenPrLinks(github, cache, owner, repo, number) {
  const key = `openpulls:${owner}/${repo}`;
  let pulls = cache ? cache.get(key) : undefined;
  if (pulls === undefined) {
    pulls = await github.listOpenPulls(owner, repo);
    if (!pulls) {
      throw httpError(502, "pr-scan-failed", `Open-PR scan returned no data for ${owner}/${repo}.`);
    }
    if (cache) cache.set(key, pulls, PR_SCAN_TTL_MS);
  }
  const inputs = [];
  const details = [];
  for (const pr of pulls) {
    const strength = classifyLinkStrength({
      title: pr.title || "",
      body: pr.body || "",
      branch: (pr.head && pr.head.ref) || "",
      issueNumber: number,
    });
    if (strength !== "closing") continue;
    if (inputs.some((p) => p.number === pr.number)) continue;
    inputs.push({ number: pr.number, state: "open", createdAt: pr.created_at });
    details.push({
      number: pr.number,
      author: pr.user && pr.user.login,
      state: "open",
      createdAt: pr.created_at || null,
      source: "pr-scan",
    });
  }
  return { inputs, details, truncated: pulls.length >= 100 };
}

export async function assembleProtocolState(github, owner, repo, number, nowIso, cache) {
  const rawComments = (await github.getComments(owner, repo, number)) || [];
  const reactions = [];
  for (const c of rawComments) {
    if (!(c.body || "").includes(CLAIM_MARKER)) continue;
    const rs = (await github.getCommentReactions(owner, repo, c.id)) || [];
    for (const r of rs) {
      reactions.push({ commentId: c.id, user: r.user && r.user.login, content: r.content });
    }
  }
  // Linked-PR detection, two sources. The timeline is primary, but it can
  // fail outright (the github client throws on non-200) or return without
  // the cross-referenced events (observed with a fine-grained PAT: 200 OK,
  // no event, claim misread as "active", lease then movable by heartbeat).
  // The open-PR scan covers both cases. Anything still uncovered is
  // reported in data_quality; the endpoint never answers from silently
  // incomplete data.
  const missing = [];
  let linkedPrs = [];
  let linkedPrDetails = [];
  let timelineOk = false;
  try {
    const t = await fetchLinkedPrs(github, owner, repo, number);
    linkedPrs = t.inputs;
    linkedPrDetails = t.details.map((d) => ({ ...d, source: "timeline" }));
    timelineOk = true;
  } catch {
    missing.push("timeline");
  }
  const claimMarkersPresent = rawComments.some((c) => (c.body || "").includes(CLAIM_MARKER));
  if (!timelineOk || (linkedPrs.length === 0 && claimMarkersPresent)) {
    try {
      const scan = await fetchOpenPrLinks(github, cache, owner, repo, number);
      const seen = new Set(linkedPrs.map((p) => p.number));
      for (const p of scan.inputs) {
        if (!seen.has(p.number)) {
          linkedPrs.push(p);
          seen.add(p.number);
        }
      }
      for (const d of scan.details) {
        if (!linkedPrDetails.some((x) => x.number === d.number)) linkedPrDetails.push(d);
      }
      if (scan.truncated && !missing.includes("pr-scan-truncated")) {
        missing.push("pr-scan-truncated");
      }
      // The timeline reported no links but the scan found real ones: the
      // timeline's event data was incomplete.
      if (timelineOk && scan.inputs.length > 0 && !missing.includes("timeline")) {
        missing.push("timeline");
      }
    } catch {
      missing.push("pr-scan");
    }
  }
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
  return {
    computation,
    linkedPrDetails,
    honored,
    policy,
    dataQuality: { degraded: missing.length > 0, missing },
  };
}

export function buildStatusPayload({ owner, repo, number, issueTitle, computation, linkedPrDetails, honored, policy, checkedAt, dataQuality }) {
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
    data_quality: dataQuality || { degraded: false, missing: [] },
    issue_title: issueTitle || null,
    _api_note: "Live read: computed from GitHub comments at checked_at. Gates are not evaluated by this service (empty); use greenlight check for gates.",
  };
}

export { CLAIM_MARKER, RELEASE_MARKER };
