# Greenlight Claims app: registration runbook

One page. Steps marked TAP need Rene in the browser. Everything else is
already built and deployed.

## What you are creating

A public GitHub App named **Greenlight Claims** that receives webhooks for
issue comments, PRs, and issues on repos where it is installed, and keeps
the Greenlight Claim Protocol state (claims, queues, expiries) in the
claim-ledger repo. Until the four env vars below exist, the app endpoints
answer 503 `app-not-configured`; that is expected, not a failure.

Permissions, in plain language:

- Issues (write): read issue state and comments to track claims.
- Pull requests (write): read PRs so claims link to the PR that fixes them.
- Contents (write): the app commits claim state JSON to the claim-ledger
  repo. On every other repo it only reads policy files. Note: the build
  contract draft said `read`; `write` is required because the durable store
  lives in the claim-ledger repo, written by the app with its installation
  token. The code never writes contents anywhere else.
- Metadata (read): required by GitHub for any app.

## The tap

1. TAP: run `node scripts/print-manifest-url.mjs` and open the printed URL
   in a browser signed in as CloudCorpRecords. Review the prefilled name,
   homepage, webhook URL, permissions, and events. Click **Create GitHub
   App**.
2. TAP: on the app settings page, note the **App ID**.
3. TAP: click **Generate a private key**. GitHub downloads a PEM file.
4. TAP: generate a webhook secret locally with `openssl rand -hex 32`,
   paste it into the app's **Webhook secret** field, and save.
5. Generate a CRON_SECRET locally with `openssl rand -hex 32`.
6. TAP, KEY CUSTODY (binding): the private key and the webhook secret must
   land in exactly two places, and never in a third:
   (a) Vercel: add `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
       `GITHUB_WEBHOOK_SECRET`, and `CRON_SECRET` to the claim-api-wine
       project's Production environment variables, then redeploy. Paste
       the private key PEM exactly as downloaded, BEGIN and END lines
       included.
   (b) The encrypted vault: write the private key to
       `vault:github-apps/greenlight-claims/private-key` and the webhook
       secret to `vault:github-apps/greenlight-claims/webhook-secret` with
       the vault CLI, piping values in, never via a file.
   NEVER write the PEM or the secret to any file, /tmp, chat message, or
   git, not even transiently. Pipe each value straight from the secure
   capture into the env var write and the vault write, then discard it.
   If the vault CLI is not ready yet: do (a) now; the vault copy is
   PENDING. Only the two paths above are recorded, never the values.
7. TAP: set `GITHUB_APP_SLUG` to the app's slug (visible in the app
   settings page URL) in the Vercel Production env and redeploy.
8. TAP: install the app from `https://github.com/apps/<slug>` (use the
   real slug from step 7) on **CloudCorpRecords/claim-ledger** (the app
   needs contents write there; that is where claim state lives) and on
   **CloudCorpRecords/greenlight**.
9. Verify with the curl checks below.

## Verify

```bash
API=https://claim-api-wine.vercel.app
curl -s $API/v1/app/repos/CloudCorpRecords/greenlight/installation
# {"installed": true, "app_slug": "greenlight-claims"}
curl -s $API/v1/app/installations | head -c 400
curl -s -X POST $API/v1/app/sweep -H "Authorization: Bearer $CRON_SECRET" | head -c 300
# {"ok": true, "repos": ..., "expired": ..., "promoted": ...}
curl -s -X POST $API/v1/app/webhook -d '{}' | head -c 200
# 401 {"error": "bad-webhook-signature", ...}
```

## Privacy posture

The app stores claim state only: claims, queues, per-event history,
installation records, and webhook delivery ids. No code, no user tokens,
no private data. Claim state mirrors public GitHub events and is committed
to the public claim-ledger repo, where anyone can read and verify it.
