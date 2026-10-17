# claim-api CHANGELOG

## 0.1.1 (2026-10-16)

**Fix: linked claims misread as "active" when the timeline was incomplete.**

Live incident: `GET /v1/issues/actualbudget/actual/9230/status` read the
claim as `linked` unauthenticated, but after `SERVICE_GITHUB_TOKEN` (a
fine-grained PAT) was configured it read `active` with the linked PR
missing. The issue timeline was returning without its `cross-referenced`
events under that token, and the service silently computed state from
comments-only data.

Changes:

- When the timeline request fails (non-200) or returns no linked PRs for
  an issue carrying protocol claim comments, the service now falls back
  to scanning the repo's open PRs for closing intent (`Fixes #N`, the
  issue URL, or the issue number in the title/branch) using the same
  link-strength classification as the Greenlight digest. One extra API
  call, cached per repo for 2 minutes.
- The status and claim-chain payloads now always carry
  `data_quality: { degraded, missing }`. `missing` names the sources that
  could not be read or proved incomplete: `"timeline"`, `"pr-scan"`,
  `"pr-scan-truncated"` (the open-PR list hit its 100-item page cap).
  Healthy reads return `{ degraded: false, missing: [] }`.
- `linkedPrDetails` entries now carry `source: "timeline"` or
  `source: "pr-scan"` so consumers can see which path found each link.

Note: the Greenlight engine extends `expires_at` on heartbeats even for
linked claims; what the link freezes is the claim's end (a linked claim
cannot expire). This release does not change that engine behavior.

DEPLOY.md documents the fine-grained PAT timeline behavior observed in
the incident; a classic PAT with `public_repo` read is noted as an
alternative service token.
