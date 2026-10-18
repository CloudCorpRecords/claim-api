/**
 * GitHub App configuration for claim-api v1.0.
 *
 * The app backend only activates when the four registration secrets are
 * present in the environment. Until then every /v1/app/* endpoint answers
 * 503 app-not-configured (documented in the runbook, not a failure).
 */

export function normalizePrivateKey(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  // Vercel env vars often carry the PEM with literal \n escapes.
  if (s.includes("\\n")) return s.replace(/\\n/g, "\n");
  return s;
}

export function loadAppConfig(env = process.env) {
  const appId = (env.GITHUB_APP_ID || "").trim();
  const privateKey = normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY || "");
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET || "";
  const cronSecret = env.CRON_SECRET || "";
  return {
    appId,
    privateKey,
    webhookSecret,
    cronSecret,
    sessionSecret: env.SESSION_SECRET || "",
    appSlug: (env.GITHUB_APP_SLUG || "").trim(),
    appName: env.GITHUB_APP_NAME || "Greenlight Claims",
    stateMode: env.APP_STATE_MODE || "ledger", // ledger | local | memory
    stateDir: env.APP_STATE_DIR || "",
    ledgerOwner: env.APP_LEDGER_OWNER || "CloudCorpRecords",
    ledgerRepo: env.APP_LEDGER_REPO || "claim-ledger",
    ledgerInstallationId: (env.APP_LEDGER_INSTALLATION_ID || "").trim(),
    configured: !!(appId && privateKey && webhookSecret && cronSecret),
  };
}
