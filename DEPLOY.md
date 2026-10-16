# claim-api: DEPLOY.md

Exact steps to get the Phase 3 hosted API live. Nothing here needs further
research; every step names the path, the value shape, and the check.

## A. Create the GitHub OAuth app

1. Sign in to GitHub as @CloudCorpRecords.
2. Go to **Settings** (your avatar menu, top right) -> **Developer settings**
   (bottom of the left sidebar) -> **OAuth Apps** -> **New OAuth App**.
3. Fill in:
   - **Application name:** `Claim Protocol API`
   - **Homepage URL:** `https://claim-api-RENETHING.replit.app` (replace with
     your actual Replit URL after step B; you will come back and fix this).
   - **Application description:** `Hosted write API for the Greenlight Claim Protocol.`
   - **Authorization callback URL:** `https://claim-api-RENETHING.replit.app/auth/github/callback`
     (the callback URL is `<APP_BASE_URL>/auth/github/callback`, nothing else).
4. Click **Register application**.
5. On the app page, copy the **Client ID**. Click **Generate a new client
   secret**, copy the **Client secret** once. These go into the Replit secrets
   in step B as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
6. Note: the app asks for `public_repo` scope at login (the service requests
   it in the authorize redirect). It cannot see or touch private repos.

## B. Deploy to Replit

1. Push this directory to a GitHub repo (e.g. `CloudCorpRecords/claim-api`).
2. In Replit: **Create** -> **Import from GitHub** -> paste the repo URL.
3. Replit detects Node. Set the **run command** to `npm start`.
4. Open the **Secrets** tool (lock icon in the left sidebar) and add:
   - `GITHUB_CLIENT_ID` = the Client ID from step A
   - `GITHUB_CLIENT_SECRET` = the Client secret from step A
   - `APP_BASE_URL` = your Replit app URL, e.g.
     `https://claim-api-reneturcios.replit.app` (no trailing slash)
   - `SERVICE_GITHUB_TOKEN` = a fine-grained personal access token with
     **public repository read** (Settings -> Developer settings ->
     Personal access tokens -> Fine-grained tokens -> Generate new token;
     repository access: Public repositories; permissions: none needed beyond
     the default public read). This gives reads 5000 calls/hour.
   - `LEDGER_BASE_URL` = `https://cloudcorprecords.github.io/claim-ledger`
   - `SESSION_SECRET` = any long random string (e.g. `openssl rand -hex 32`).
   - `PORT` = leave unset; Replit injects its own (the service reads `$PORT`).
5. Press **Run**. The console should print
   `claim-api listening on :<port> ...`.
6. Go back to the OAuth app in step A and fix **Homepage URL** and
   **Authorization callback URL** to the real Replit URL if they differ.

## C. Smoke tests with curl

Replace `API` with your base URL (e.g. `https://claim-api-reneturcios.replit.app`).

```bash
API=https://claim-api-reneturcios.replit.app

# 1. Liveness
curl -s $API/healthz
# -> {"ok": true, "service": "claim-api", "version": "0.1.0"}

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

## Notes

- Replit sleeps idle free-tier apps; the first request after sleep is slow.
  For the 15-minute-freshness promise this matters less than it sounds: reads
  fall back to the static Ledger, and writes are user-initiated.
- Rate limits: reads use `SERVICE_GITHUB_TOKEN` (5000/hr shared by all
  callers). At real traffic, raise the 60s cache or put a CDN in front of the
  GET endpoints.
- The session store is in memory: restarting the service invalidates session
  tokens. Raw GitHub PATs keep working through restarts (verified per request).
