# claim-api: DEPLOY.md

Exact steps to get the Phase 3 hosted API live. Nothing here needs further
research; every step names the path, the value shape, and the check.

## A. Create the GitHub OAuth app

1. Sign in to GitHub as @CloudCorpRecords.
2. Go to **Settings** (your avatar menu, top right) -> **Developer settings**
   (bottom of the left sidebar) -> **OAuth Apps** -> **New OAuth App**.
3. Fill in:
   - **Application name:** `Claim Protocol API`
   - **Homepage URL:** `https://claim-api-YOURNAME.vercel.app` (replace with
     your actual Vercel URL after step B; you will come back and fix this).
   - **Application description:** `Hosted write API for the Greenlight Claim Protocol.`
   - **Authorization callback URL:** `https://claim-api-YOURNAME.vercel.app/auth/github/callback`
     (the callback URL is `<APP_BASE_URL>/auth/github/callback`, nothing else).
4. Click **Register application**.
5. On the app page, copy the **Client ID**. Click **Generate a new client
   secret**, copy the **Client secret** once. These go into the Vercel
   environment variables in step B as `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`.
6. Note: the app asks for `public_repo` scope at login (the service requests
   it in the authorize redirect). It cannot see or touch private repos.

## B. Deploy to Vercel (primary route)

The service runs on Vercel as a single Node serverless function
(`api/index.mjs`), with every path rewritten onto it by `vercel.json`.
The same handler also serves the plain `npm start` server (see section D),
so this is a deployment change only: no code forks.

1. Push this directory to a GitHub repo (e.g. `CloudCorpRecords/claim-api`).
2. In Vercel: **Add New** -> **Project** -> **Import** the repo.
3. Configure the project:
   - **Framework Preset:** `Other`
   - **Build Command:** leave empty (no build step; `api/index.mjs` is
     plain ESM Node)
   - **Output Directory:** leave empty
   - **Root Directory:** repo root (as-is)
   - **Install Command:** `npm install`
4. In **Settings** -> **Environment Variables** (apply to Production, or all
   environments), add:
   - `GITHUB_CLIENT_ID` = the Client ID from step A
   - `GITHUB_CLIENT_SECRET` = the Client secret from step A
   - `APP_BASE_URL` = your Vercel production URL, e.g.
     `https://claim-api-YOURNAME.vercel.app` (no trailing slash)
   - `SERVICE_GITHUB_TOKEN` = a fine-grained personal access token with
     **public repository read** (Settings -> Developer settings ->
     Personal access tokens -> Fine-grained tokens -> Generate new token;
     repository access: Public repositories; permissions: none needed beyond
     the default public read). This gives reads 5000 calls/hour.
     **Known limitation (observed 2026-10-16):** under a fine-grained PAT,
     the issue timeline endpoint has been seen returning without its
     `cross-referenced` events (200 OK, no event), which made a linked claim
     read as "active". The service now falls back to scanning the repo's
     open PRs for closing intent (`Fixes #N`) when the timeline is empty or
     fails, and any remaining gap is disclosed in the payload's
     `data_quality` field (`{degraded: true, missing: ["timeline"]}`).
     If you want the timeline as the primary source with no fallback
     reliance, a **classic PAT with `public_repo` read** is an alternative
     service token (not verified against this incident; the fallback covers
     linked detection either way).
   - `LEDGER_BASE_URL` = `https://cloudcorprecords.github.io/claim-ledger`
   - `SESSION_SECRET` = any long random string (e.g. `openssl rand -hex 32`).
5. **Deployment Protection:** in **Settings** -> **Deployment Protection**,
   make sure the production domain is NOT behind Vercel Authentication.
   Set protection to **Only Preview Deployments** (or Standard Protection
   off for production). If Vercel Authentication guards production, the
   public API answers with a Vercel login wall instead of protocol data.
6. **Deploy.** Vercel builds and the production URL goes live.
7. Go back to the OAuth app in step A and fix **Homepage URL** and
   **Authorization callback URL** to the real Vercel URL if they differ.

## C. Smoke tests with curl

Replace `API` with your base URL (e.g. `https://claim-api-YOURNAME.vercel.app`).

```bash
API=https://claim-api-YOURNAME.vercel.app

# 1. Liveness
curl -s $API/healthz
# -> {"ok": true, "service": "claim-api", "version": "0.1.1"}

# 2. Live status read (no protocol claims yet: verdict null, honest cold start)
curl -s $API/v1/issues/ComposioHQ/composio/4668/status | head -c 600
# -> {"issue": "https://github.com/ComposioHQ/composio/issues/4668", "verdict": null, ...}

# 3. Claim chain read
curl -s $API/v1/claims/ComposioHQ/composio/4668

# 4. Friction read (proxied from the static Ledger)
curl -s $API/v1/repos/ComposioHQ/composio/friction | head -c 300

# 5. OAuth login page (should 302 to github.com)
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" $API/auth/github/login
# -> 302 https://github.com/login/oauth/authorize?client_id=...

# 6. Authenticated claim (needs YOUR fine-grained PAT with public_repo scope).
#    Posts a REAL public comment as you: use a test issue you control.
TOKEN=ghp_your_pat_here
curl -s -X POST $API/v1/claims \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"owner":"CloudCorpRecords","repo":"greenlight","issue":3,"plan":"Testing the claim API","eta_days":1,"queue_ok":false}'
# -> {"action":"claimed","posted":true,"comment_url":"...","queue_position":1,...}

# 7. Heartbeat, then release, on the same issue
curl -s -X POST $API/v1/claims/heartbeat \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"owner":"CloudCorpRecords","repo":"greenlight","issue":3}'
curl -s -X POST $API/v1/claims/release \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"owner":"CloudCorpRecords","repo":"greenlight","issue":3}'
# -> {"action":"released","posted":true,...}

# 8. Status now shows the full lifecycle in the chain
curl -s $API/v1/claims/CloudCorpRecords/greenlight/3
```

If step 6 returns `claim-held` with a holder, the validation is working: send
`"queue_ok": true` to join the queue instead.

## D. GitHub App backend (v1.0)

The app backend extends this same service and Vercel project. Registration
is a one-time tap: follow [docs/APP-RUNBOOK.md](docs/APP-RUNBOOK.md)
(manifest URL helper at `scripts/print-manifest-url.mjs`).

Environment variables (Production):

- `GITHUB_APP_ID`: the numeric app id from the app settings page.
- `GITHUB_APP_PRIVATE_KEY`: the PEM generated on the app settings page.
  Paste it exactly, BEGIN/END lines included. Key custody is binding: it
  goes into this env var and into the encrypted vault at
  `vault:github-apps/greenlight-claims/private-key`, and never into any
  file, chat message, or git.
- `GITHUB_WEBHOOK_SECRET`: the secret set on the app settings page.
  Same custody rule; vault path
  `vault:github-apps/greenlight-claims/webhook-secret`.
- `CRON_SECRET`: any long random string (`openssl rand -hex 32`). Guards
  `/v1/app/sweep`; Vercel attaches it to cron calls automatically.
- `GITHUB_APP_SLUG`: the app slug (public), used in install answers.
- `APP_STATE_MODE`: `ledger` (default, production), `local` (dev, needs
  `APP_STATE_DIR`), or `memory` (tests).

Until the first four are set, every `/v1/app/*` endpoint answers 503
`app-not-configured`. The claim-ledger repo must have the app installed
with contents write, or state writes answer 503 `app-state-unavailable`
while reads keep working.

## E. Fallback: plain Node hosting

Any host that runs a long-lived Node process can serve the same handler with
`npm start` (Render, Fly.io, a VPS, your own machine). Environment variables
are the same as section B, plus `PORT` (the server listens on `$PORT` or
8080). On a long-lived process the in-memory session store and 60s read
cache persist across requests instead of per-instance (see below), and there
is no deployment-protection wall to trip over.

Note (Oct 2026): Render and Fly.io both demanded a credit card before
creating even a free-tier service, which is why Vercel is the primary route.

## Notes

- **Vercel instances recycle.** On Vercel, the in-memory session store and
  the 60s read cache are per-function-instance and best effort: a cold or
  recycled instance forgets prior sessions, so a session token can
  occasionally stop working and the user re-logs in via
  `/auth/github/login?format=json`. Raw GitHub user tokens (PATs) are
  stateless, verified per request against `GET /user`, and are unaffected
  by recycles. This is a deliberate trade-off documented in the spec
  (`who_can_claim: "passport"` and persistent sessions remain future work);
  if sessions ever need to survive recycles, the session store moves to
  Vercel KV or Postgres.
- **Cold starts.** The first request to an idle Vercel deployment is slower;
  live status computation also calls the GitHub API several times, so
  `vercel.json` sets the function `maxDuration` to 60 seconds. Static reads
  always fall back to the Ledger, and writes are user-initiated, so this
  matters less than it sounds.
- **Rate limits:** reads use `SERVICE_GITHUB_TOKEN` (5000/hr shared by all
  callers). At real traffic, raise the 60s cache or put a CDN in front of the
  GET endpoints.
- **Rewrites preserve the path.** `vercel.json` rewrites every path onto
  `/api/index.mjs`; Vercel keeps the original `req.url` when invoking the
  function, so routing behaves exactly like the plain Node server. If paths
  ever start 404ing on Vercel, check the rewrite entry before touching code.
