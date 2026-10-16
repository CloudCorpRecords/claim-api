# Greenlight client integration design: `greenlight claim --via-api`

Status: design only. No Greenlight code changes ship with this document; it
specifies exactly what a future Greenlight release (v0.4.1+) would do so the
work is a single build pass.

## Goal

`greenlight claim <issue-url> --via-api` posts the claim through the hosted
claim-api instead of requiring the user to paste a comment or hand the CLI a
token. The CLI authenticates once; every later claim is one command.

## Auth options, ranked

### Option 1 (recommended): CLI device flow against the user's own GitHub token

GitHub's OAuth device flow needs no browser callback at all:

1. `greenlight auth login` starts a device flow against the OAuth app's
   client id: POST `https://github.com/login/device/code`
   `{client_id, scope: "public_repo"}`.
2. The CLI prints `Enter code XXXX-XXXX at https://github.com/login/device`.
   The user does this once, on any device.
3. The CLI polls `https://github.com/login/oauth/access_token`
   `{client_id, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code"}`
   until GitHub issues a user token.
4. The CLI stores the token in the OS keychain (never in a file) and uses it
   as `Authorization: Bearer <token>` directly against claim-api's write
   endpoints. **No session token, no server-side session store involved.**

Why this is the right default: claim-api already accepts a raw GitHub user
token on every write endpoint (verified per-request via `GET /user`), so the
device flow needs zero new server code. The OAuth app only needs "Enable
Device Flow" checked in its settings.

### Option 2: browser OAuth, session token in the keychain

`greenlight auth login --browser` opens the system browser at
`<API>/auth/github/login`, the user completes the grant, and the CLI reads
the session token from the `?format=json` callback (or the user pastes it).
Stored in the keychain; sent as the bearer on write endpoints. Depends on
the server's session store, so sessions die on server restart (documented in
DEPLOY.md).

### Option 3: PAT passthrough

`greenlight claim --via-api --token ghp_...` (or `GREENLIGHT_API_TOKEN` env).
For scripts and agents that already hold a token. Documented, supported, not
advertised in help text.

## Command behavior

```
greenlight claim <issue-url> --via-api [--plan "..."] [--eta-days N] [--queue-ok]
```

1. Pre-flight: call `GET /v1/issues/:owner/:repo/:number/status` (or reuse
   `claim_status` against the hosted API base). If the payload verdict is
   TAKEN by someone else and `--queue-ok` is absent, print the holder and
   expiry and stop, exactly as the local refusal does.
2. POST `/v1/claims` with the bearer from the keychain. On 201/200, print the
   comment URL and queue position. On 401, re-run the device flow once; on
   second 401, print the manual steps and stop.
3. Cache the last-known API base in the user's config (`~/.config/greenlight/config.json`),
   defaulting to the hosted instance URL; `--api-base` overrides per call.

`greenlight release <issue-url> --via-api` and
`greenlight heartbeat <issue-url> --via-api [--reaction]` map 1:1 onto the
server endpoints.

## Fallback and honesty

- If the API is unreachable, the CLI says so and offers the local path
  (`greenlight claim` without `--via-api`, which prints/drafts the comment
  for hand-posting). It never silently downgrades.
- The claim comment body is built server-side from the same
  `buildClaimComment` the CLI uses, so `--via-api` and hand-posted claims are
  byte-compatible protocol claims.
- The CLI verifies the posted comment by re-reading the status endpoint and
  confirming its own login appears in the chain; if not, it prints the
  comment URL and tells the user to check, rather than claiming success.

## MCP surface (future)

- `claim_via_api` tool: `{issue_url, plan?, eta_days?, queue_ok?}`. Uses the
  configured API base and the keychain token; refuses when no token is
  stored, with instructions to run `greenlight auth login`.
- `api_status` tool: the hosted status payload, for agents that want the
  60-second-fresh answer instead of the 15-minute static one.

## What this design deliberately does not include

- No server-side claim queue manipulation: the queue lives in GitHub
  comments; the API only reads and appends.
- No maintainer override endpoints: supersede stays a maintainer comment or
  the existing verified-comment flow.
- No token refresh logic: GitHub OAuth user tokens for `public_repo` do not
  expire on a schedule; rotation is the user's PAT hygiene, unchanged.
