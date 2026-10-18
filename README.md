# claim-api

Hosted API for the [Greenlight Claim Protocol](https://github.com/CloudCorpRecords/greenlight/blob/main/protocol/SPEC.md),
plus the **Greenlight Claims GitHub App** backend (v1.0).

The protocol's core rule is: **GitHub is the source of truth, the Ledger is
only an index.** This service is the Phase 3 form of the pre-flight API
(SPEC 5.5): it computes protocol state **live** from GitHub comments instead
of the static 15-minute index, and it performs the **writes** the spec
reserves for Phase 3: claim, release, and heartbeat, posted **as the user**
via their GitHub OAuth grant.

Since v1.0 the service also runs the GitHub App backend: it receives
webhooks (issue comments, PRs, issues, installations), enforces the claim
lifecycle server side (one active claim per issue, lease 1 to 30 days from
repo policy, 28-day tenure cap, hard-gate checks before a claim counts as
valid), and keeps the durable claim state in the claim-ledger repo,
committed with its installation token. The app never posts comments on
third-party repos from webhooks; every webhook transition is state-only and
visible in the ledger. Registration is a one-time tap documented in
[docs/APP-RUNBOOK.md](docs/APP-RUNBOOK.md).

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| GET | `/healthz` | none | Liveness. |
| GET | `/v1/issues/:owner/:repo/:number/status` | none | Live SPEC 5.1 payload: verdict, active claim with expiry, queue, competing PRs, repo protocol status, `checked_at`, `stale_after_seconds: 60`. 60s in-memory cache per issue. |
| GET | `/v1/claims/:owner/:repo/:number` | none | The live claim chain (active, queue, every claim). |
| GET | `/v1/repos/:owner/:repo/friction` | none | Proxies the static Ledger's friction.json; falls back to `{score: null}` with a note. |
| POST | `/v1/claims` | user | Posts a protocol claim comment as you. Body: `{owner, repo, issue, plan?, eta_days?, queue_ok?}`. Refuses 409 when someone else holds the claim (unless `queue_ok: true`), 409 when the issue is closed, 404 when it does not exist. Idempotent: re-claiming your own active claim returns it unchanged. |
| POST | `/v1/claims/release` | user | Posts the release marker comment as you. Only the claim holder. |
| POST | `/v1/claims/heartbeat` | user | Renews your claim. Body `{owner, repo, issue, mode?: "comment" \| "reaction"}`: a minimal heartbeat comment (default), or a rocket reaction on your own claim comment (noise-free). |
| POST | `/v1/app/webhook` | GitHub signature | The app's webhook receiver. Verifies `X-Hub-Signature-256`; replays of seen delivery ids return 200 without re-applying. 503 `app-not-configured` until the app is registered. |
| GET | `/v1/app/repos/:owner/:repo/installation` | none | `{"installed": true, "app_slug": "..."}` or `{"installed": false}`. This is how clients choose the app path vs the direct comment path. |
| GET | `/v1/app/installations` | none | Every repo with the app installed. Feeds the ledger site's install section. |
| GET/POST | `/v1/app/sweep` | cron secret | Expiry sweep plus queue promotion. Wired in vercel.json every 15 minutes; safe to trigger manually. |
| POST | `/v1/app/claims` | user | The app posts the protocol claim comment **as itself** with an `on-behalf-of:` attribution line; the webhook records the claim. Body: `{owner, repo, issue, plan?, eta_days?, queue_ok?}`. 409 when the app is not installed on the repo. |
| GET | `/auth/github/login` | none | Redirects to GitHub OAuth (scope `public_repo`). |
| GET | `/auth/github/callback` | none | Exchanges the code, issues a session token. Add `?format=json` for CLI consumption. |

## Auth model

Three bearer forms on the write endpoints:

1. **Session token** (`gls2_...`) issued by the OAuth callback. Since v1.0
   sessions are stateless: the token is an HMAC-signed, AES-256-GCM
   encrypted envelope verified with `SESSION_SECRET`, so it survives
   server restarts and Vercel instance recycles. Raw GitHub user tokens
   never touch this store.
2. **Raw GitHub user token** (a fine-grained PAT with `public_repo` scope).
   Verified per-request against `GET /user`. This is what the CLI device
   flow uses: no session store, no cookies, no callback needed.
3. **App installation tokens** are internal only: the webhook backend mints
   a short-lived RS256 JWT from `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`
   and exchanges it per installation. Callers never see these.

The service never stores your GitHub credentials in the session path beyond
the token itself, and never posts without your token. The OAuth scope is
`public_repo`: the service can only comment on public issues, never read
private code.

Write rate limits: user write endpoints allow 30/hour per caller login;
webhook-triggered writes allow 240/hour per installation. Both are
in-memory sliding windows (per function instance on Vercel, documented in
DEPLOY.md). Rate-limit rejections are plain 429s, never written to any
ledger.

## Data quality

The read endpoints never answer from silently incomplete data. Every
status and claim-chain payload carries
`data_quality: { degraded, missing }`, where `missing` names sources that
could not be read or proved incomplete:

- `"timeline"` — the issue timeline request failed, or it reported no
  linked PRs while the open-PR scan found real closing links (observed
  with a fine-grained service token: the timeline returned 200 without
  its `cross-referenced` events).
- `"pr-scan"` — the fallback open-PR scan itself failed.
- `"pr-scan-truncated"` — the repo has 100+ open PRs, so the scan's first
  page may have missed a link.

The fallback runs when the timeline fails or yields no linked PRs for an
issue with protocol claim comments. Healthy reads return
`{ degraded: false, missing: [] }`. Each linked PR in the payload carries
`source: "timeline"` or `source: "pr-scan"`.

See [CHANGELOG.md](CHANGELOG.md) for the 0.1.1 incident and fix.

## Relationship to the static Ledger

The static Ledger (`cloudcorprecords.github.io/claim-ledger`) is the Phase 2
form: a public index rebuilt every 15 minutes, zero servers, fully
inspectable. claim-api is the Phase 3 form:

- **Reads** prefer this service when freshness matters (live state, 60s
  cache) and fall back to the static Ledger when this service is down or
  unneeded. Both return the same SPEC 5.1 payload shape.
- **Writes** need this service (or a hand-posted comment): the static Ledger
  cannot post as you. Every write this service performs is itself a public
  GitHub comment, so the static Ledger indexes it within ~15 minutes and the
  two forms converge.

## Running it

```
cp .env.example .env   # fill in the values
npm install
npm start              # listens on $PORT (default 8080)
npm test               # 81 tests against mocked GitHub APIs
```

See [DEPLOY.md](DEPLOY.md) for the OAuth app setup, Vercel deployment (primary
route), plain-Node fallback hosting, and curl smoke tests.
See [docs/client-integration.md](docs/client-integration.md)
for how a future Greenlight release calls this API.

**Vercel note:** the service also runs as one serverless function
(`api/index.mjs` default-exports the same handler `npm start` serves).
On Vercel the 60s read cache, the revocation blocklist, and the rate limit
windows are per-instance and best effort; session tokens and raw GitHub
user tokens are stateless and unaffected by recycles. Keep Vercel
Deployment Protection off the production domain so the API stays public.
The `*/15` sweep cron is wired in vercel.json; Vercel attaches
`Authorization: Bearer <CRON_SECRET>` to its cron calls automatically.

## Privacy posture

The app stores claim state only: claims, queues, per-event history,
installation records, and webhook delivery ids. No code, no user tokens,
no private data. Claim state mirrors public GitHub events and is committed
to the public claim-ledger repo, where anyone can read and verify it.
