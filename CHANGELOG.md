# claim-api CHANGELOG

## 1.0.0 (2026-10-18)

**The Greenlight Claims GitHub App backend.** The service now runs the app
alongside the existing pre-flight API. All existing endpoints are backward
compatible.

New endpoints:

- `POST /v1/app/webhook`: GitHub webhook receiver. Verifies
  `X-Hub-Signature-256` (HMAC-SHA256 of the raw body); missing or bad
  signatures get 401. Processed `X-GitHub-Delivery` ids are recorded in the
  durable store, so replays return 200 without re-applying. Until the four
  app env vars are set, 503 `app-not-configured`.
- `GET /v1/app/repos/:owner/:repo/installation`: `{"installed": true,
  "app_slug": ...}` or `{"installed": false}`. Public.
- `GET /v1/app/installations`: every repo with the app installed. Public.
- `GET`/`POST /v1/app/sweep`: expiry sweep plus queue promotion, guarded
  by `Authorization: Bearer <CRON_SECRET>`; wired in vercel.json every 15
  minutes. (Vercel cron jobs issue GET and attach the bearer
  automatically.)
- `POST /v1/app/claims`: the app posts the protocol claim comment as
  itself with an `on-behalf-of:` attribution line; the webhook records the
  claim. 409 when the app is not installed on the repo.

Event handlers: issue_comment created/edited/deleted (claim, queue,
heartbeat, release, maintainer supersede, implicit release on deletion),
pull_request opened/closed (link on closing intent, lease frozen; merged
to completed, closed unmerged to linked-dead), issues closed/reopened
(release with reason `issue-closed`; no auto-restore), installation and
installation_repositories bookkeeping.

Enforcement: one active claim per issue (queue instead of overwrite),
lease 1 to 30 days from `.greenlight/claims.json` (default 7), 28-day
tenure cap without a linked PR, hard-gate checks (including an
AI-generated-contribution-ban detector) before a claim counts as valid,
30/hour per caller on user writes, 240/hour per installation on
webhook-triggered writes. Gate-blocked claims are recorded with
`valid: false` and the evidence, never silently dropped.

Durable state lives in the claim-ledger repo (installation token, GitHub
contents API): `docs/v1/repos/<owner>/<repo>/claims-app.json`,
`docs/v1/apps/greenlight-claims/installations.json`,
`docs/v1/apps/greenlight-claims/deliveries/<date>.json`. The store has
memory, local-file (`APP_STATE_MODE=local`), and ledger-repo backends.

Sessions are now stateless: HMAC-signed, AES-256-GCM encrypted envelopes
verified with `SESSION_SECRET` (the in-memory map is deleted). Session
tokens issued before this release stop working; raw GitHub user tokens are
unaffected.

Registration: `app-manifest.json`, `scripts/print-manifest-url.mjs`, and
`docs/APP-RUNBOOK.md` (the one-page tap: create the app from the manifest
URL, generate the private key and webhook secret, add the four env vars to
Vercel Production and redeploy, install on the claim-ledger and greenlight
repos). Note: the manifest requests `contents: write` (the contract draft
said `read`); write is required because the durable store is committed to
the claim-ledger repo by the app. The code never writes contents anywhere
else.

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
