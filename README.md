# claim-api

Phase 3 hosted API for the [Greenlight Claim Protocol](https://github.com/CloudCorpRecords/greenlight/blob/main/protocol/SPEC.md).

The protocol's core rule is: **GitHub is the source of truth, the Ledger is
only an index.** This service is the Phase 3 form of the pre-flight API
(SPEC 5.5): it computes protocol state **live** from GitHub comments instead
of the static 15-minute index, and it performs the **writes** the spec
reserves for Phase 3: claim, release, and heartbeat, posted **as the user**
via their GitHub OAuth grant.

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
| GET | `/auth/github/login` | none | Redirects to GitHub OAuth (scope `public_repo`). |
| GET | `/auth/github/callback` | none | Exchanges the code, issues a session token. Add `?format=json` for CLI consumption. |

## Auth model

Two bearer forms, both accepted on the write endpoints:

1. **Session token** (`gls_...`) issued by the OAuth callback, held in memory.
   Convenience for browser flows; the token is opaque and revocable.
2. **Raw GitHub user token** (a fine-grained PAT with `public_repo` scope).
   Verified per-request against `GET /user`. This is what the CLI device
   flow uses: no session store, no cookies, no callback needed.

The service never stores your GitHub credentials in the session path beyond
the token itself, and never posts without your token. The OAuth scope is
`public_repo`: the service can only comment on public issues, never read
private code.

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
npm test               # 19 tests against a mocked GitHub API
```

See [DEPLOY.md](DEPLOY.md) for the OAuth app setup, Vercel deployment (primary
route), plain-Node fallback hosting, and curl smoke tests.
See [docs/client-integration.md](docs/client-integration.md)
for how a future Greenlight release calls this API.

**Vercel note:** the service also runs as one serverless function
(`api/index.mjs` default-exports the same handler `npm start` serves).
On Vercel the in-memory session store and 60s read cache are per-instance
and best effort, so session tokens can occasionally require re-login; raw
GitHub user tokens are stateless and unaffected. Keep Vercel Deployment
Protection off the production domain so the API stays public.
