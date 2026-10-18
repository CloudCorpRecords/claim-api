/**
 * App routes for claim-api v1.0: the GitHub App backend.
 *
 *   POST /v1/app/webhook                        GitHub webhook receiver
 *   GET  /v1/app/repos/:owner/:repo/installation app installed on this repo?
 *   GET  /v1/app/installations                   repos with the app installed
 *   GET  /v1/app/sweep  (Bearer CRON_SECRET)     expiry sweep + queue promotion
 *   POST /v1/app/sweep  (Bearer CRON_SECRET)     same, manual trigger
 *   POST /v1/app/claims                          app posts the claim comment as itself
 *   GET  /app/setup-complete                     manifest redirect target
 *
 * Until GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET /
 * CRON_SECRET are all set, every /v1/app/* endpoint answers 503
 * app-not-configured (documented, not an error). /app/setup-complete is the
 * exception: GitHub redirects there right after app creation, before the env
 * vars exist.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { json, readJsonBody, httpError } from "./server.mjs";
import { resolveCaller } from "./routes.mjs";
import { buildClaimComment } from "@reneturcios/greenlight/dist/automate.js";
import { CLAIM_MARKER } from "./protocol-live.mjs";
import {
  handleIssueComment,
  handlePullRequest,
  handleIssues,
  handleInstallation,
  handleInstallationRepositories,
  installationForRepo,
  runSweep,
} from "./app-handlers.mjs";
import { USER_WRITE_LIMIT, WEBHOOK_WRITE_LIMIT } from "./app-ratelimit.mjs";

const QUEUE_OK_LINE = "queue-ok: yes";

function requireApp(app) {
  if (!app.config.configured) {
    throw httpError(503, "app-not-configured",
      "The GitHub App is not registered on this instance yet. See docs/APP-RUNBOOK.md for the setup tap.");
  }
}

function bearerToken(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

function parseNum(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, "bad-number", `${name} must be a positive integer.`);
  return n;
}

async function readRawBody(req, limitBytes = 256 * 1024) {
  // Vercel's Node runtime passes req as a readable stream. If the platform
  // pre-parsed the body into an object, the webhook signature cannot be
  // verified against raw bytes, so we fail closed.
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body !== undefined && req.body !== null) {
    throw httpError(400, "body-preparsed",
      "The request body was pre-parsed, so the webhook signature cannot be verified. Configure the platform to pass the raw body.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw httpError(413, "body-too-large", "Webhook body too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(signatureHeader || "").trim());
  if (!m || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(m[1], "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function appNotInstalledError(owner, repo, slug) {
  const where = slug ? `https://github.com/apps/${slug}` : "the app install page (see docs/APP-RUNBOOK.md)";
  return httpError(409, "app-not-installed",
    `The Greenlight Claims app is not installed on ${owner}/${repo}. Install it from ${where} first.`);
}

export function registerAppRoutes({ route, config, githubFactory, sessions, cache, app }) {
  // The manifest flow lands here right after GitHub creates the app, before
  // any env vars exist, so this route never requires app configuration.
  route("GET", /^\/app\/setup-complete$/, async (req, res) => {
    json(res, 200, {
      ok: true,
      message: "GitHub App created. Next: add the four env vars to Vercel Production and redeploy, then install the app on your repos.",
      runbook: "https://github.com/CloudCorpRecords/claim-api/blob/main/docs/APP-RUNBOOK.md",
      configured: !!app.config.configured,
    });
  });

  route("POST", /^\/v1\/app\/webhook$/, async (req, res) => {
    requireApp(app);
    const raw = await readRawBody(req);
    if (!verifyWebhookSignature(raw, req.headers["x-hub-signature-256"], app.config.webhookSecret)) {
      throw httpError(401, "bad-webhook-signature", "X-Hub-Signature-256 is missing or invalid.");
    }
    const delivery = String(req.headers["x-github-delivery"] || "");
    const eventName = String(req.headers["x-github-event"] || "");
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw httpError(400, "bad-json", "Webhook body is not valid JSON.");
    }

    if (eventName === "ping") return json(res, 200, { ok: true, event: "ping" });

    const day = new Date().toISOString().slice(0, 10);
    if (delivery && (await app.store.deliverySeen(day, delivery))) {
      return json(res, 200, { ok: true, replayed: true, delivery });
    }

    const installationId = payload.installation && payload.installation.id;
    if (!installationId) throw httpError(400, "missing-installation", "Webhook payload has no installation.");
    const rl = app.limiter.check(`webhook:${installationId}`, WEBHOOK_WRITE_LIMIT);
    if (!rl.allowed) {
      throw httpError(429, "webhook-rate-limited",
        "Webhook write budget exhausted for this installation (240/hour). GitHub will retry the delivery.");
    }

    const token = await app.auth.installationToken(installationId);
    const github = githubFactory({ token });
    const ctx = { store: app.store, github, cache, now: () => new Date() };
    const repoFull = payload.repository ? payload.repository.full_name : "";
    const [owner, repo] = repoFull.split("/");
    let result;
    try {
      if (eventName === "issue_comment") {
        result = await handleIssueComment(ctx, {
          action: payload.action,
          owner,
          repo,
          issue: {
            number: payload.issue.number,
            state: payload.issue.state,
            title: payload.issue.title,
          },
          comment: {
            id: payload.comment.id,
            body: payload.comment.body || "",
            author: payload.comment.user.login,
            created_at: payload.comment.created_at,
            html_url: payload.comment.html_url,
          },
        });
      } else if (eventName === "pull_request") {
        const pr = payload.pull_request;
        result = await handlePullRequest(ctx, {
          action: payload.action,
          owner,
          repo,
          pr: {
            number: payload.number,
            title: pr.title || "",
            body: pr.body || "",
            author: pr.user.login,
            merged: !!pr.merged,
            html_url: pr.html_url,
            head_branch: (pr.head && pr.head.ref) || "",
          },
        });
      } else if (eventName === "issues") {
        result = await handleIssues(ctx, {
          action: payload.action,
          owner,
          repo,
          issue: { number: payload.issue.number, state: payload.issue.state },
        });
      } else if (eventName === "installation") {
        const inst = payload.installation;
        result = await handleInstallation(ctx, {
          action: payload.action,
          installation: {
            id: inst.id,
            account_login: inst.account.login,
            account_type: inst.account.type,
            repos: (payload.repositories || []).map((r) => {
              const [o, nm] = String(r.full_name).split("/");
              return { owner: o, repo: nm };
            }),
          },
        });
      } else if (eventName === "installation_repositories") {
        const inst = payload.installation;
        const mapRepos = (arr) =>
          (arr || []).map((r) => {
            const [o, nm] = String(r.full_name).split("/");
            return { owner: o, repo: nm };
          });
        result = await handleInstallationRepositories(ctx, {
          action: payload.action,
          installation: { id: inst.id },
          added: mapRepos(payload.repositories_added),
          removed: mapRepos(payload.repositories_removed),
        });
      } else {
        result = { outcome: "ignored", reason: `unhandled-event:${eventName}` };
      }
    } catch (err) {
      // A 503 here means the durable store is unreachable (e.g. the app is
      // not installed on the claim-ledger repo yet). Do not record the
      // delivery, so GitHub's retry can succeed later.
      if (err && err.code === "app-state-unavailable") throw httpError(503, err.code, err.message);
      throw err;
    }
    if (delivery) await app.store.recordDelivery(day, delivery);
    json(res, 200, { ok: true, event: eventName, delivery, result });
  });

  route("GET", /^\/v1\/app\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/installation$/, async (req, res, url, p) => {
    requireApp(app);
    let installationId = null;
    let note = null;
    try {
      installationId = await installationForRepo(app.store, p.owner, p.repo);
    } catch (err) {
      if (err && err.code === "app-state-unavailable") note = "Claim state store unreachable; the app may not be installed on the claim-ledger repo yet.";
      else throw err;
    }
    if (!installationId) return json(res, 200, { installed: false, ...(note ? { _note: note } : {}) });
    json(res, 200, { installed: true, app_slug: app.config.appSlug || null });
  });

  route("GET", /^\/v1\/app\/installations$/, async (req, res) => {
    requireApp(app);
    let data;
    try {
      data = await app.store.getInstallations();
    } catch (err) {
      if (err && err.code === "app-state-unavailable") throw httpError(503, err.code, err.message);
      throw err;
    }
    const repos = [];
    for (const i of data.installations || []) {
      for (const r of i.repos || []) {
        repos.push({
          owner: r.owner,
          repo: r.repo,
          installation_id: String(i.installation_id),
          installed_at: i.installed_at || null,
        });
      }
    }
    json(res, 200, { repos });
  });

  async function sweepHandler(req, res) {
    requireApp(app);
    const token = bearerToken(req);
    if (!app.config.cronSecret || token !== app.config.cronSecret) {
      throw httpError(401, "bad-cron-secret", "Send Authorization: Bearer <CRON_SECRET>.");
    }
    const result = await runSweep({ store: app.store, now: () => new Date() });
    json(res, 200, { ok: true, ...result });
  }
  // Vercel Cron Jobs issue GET and automatically attach
  // Authorization: Bearer <CRON_SECRET>; manual triggers may use POST.
  route("GET", /^\/v1\/app\/sweep$/, sweepHandler);
  route("POST", /^\/v1\/app\/sweep$/, sweepHandler);

  // App-posted claim comment (user-authenticated). The app posts the protocol
  // comment AS ITSELF with an on-behalf-of attribution line; the webhook then
  // records the claim in the durable store. This is the path the dogfood
  // uses, because Rene's personal account is comment-blocked.
  route("POST", /^\/v1\/app\/claims$/, async (req, res) => {
    requireApp(app);
    const { login, github: callerGithub } = await resolveCaller({ req, sessions, githubFactory });
    void callerGithub;
    const rl = app.limiter.check(`user:${login}`, USER_WRITE_LIMIT);
    if (!rl.allowed) {
      throw httpError(429, "user-rate-limited", `Write rate limit reached (30/hour for @${login}). Try again in a bit.`);
    }
    const body = await readJsonBody(req);
    for (const f of ["owner", "repo", "issue"]) {
      if (!body[f]) throw httpError(400, "missing-field", `Body must include ${f}.`);
    }
    const number = parseNum(body.issue, "issue");
    let installationId;
    try {
      installationId = await installationForRepo(app.store, body.owner, body.repo);
    } catch (err) {
      if (err && err.code === "app-state-unavailable") throw httpError(503, err.code, err.message);
      throw err;
    }
    if (!installationId) throw appNotInstalledError(body.owner, body.repo, app.config.appSlug);
    const token = await app.auth.installationToken(installationId);
    const github = githubFactory({ token });
    const issue = await github.getIssue(body.owner, body.repo, number);
    if (!issue) throw httpError(404, "issue-not-found", `Issue ${body.owner}/${body.repo}#${number} does not exist.`);
    if (issue.state !== "open") throw httpError(409, "issue-closed", `Issue ${body.owner}/${body.repo}#${number} is ${issue.state}; only open issues can be claimed.`);
    if (issue.pull_request) throw httpError(400, "is-pull-request", "That number is a pull request, not an issue.");

    let commentBody = buildClaimComment(
      { title: issue.title },
      [],
      login,
      { plan: body.plan, etaDays: body.eta_days }
    );
    const extraLines = [`on-behalf-of: ${login}`];
    if (body.queue_ok) extraLines.push(QUEUE_OK_LINE);
    commentBody = commentBody.replace(CLAIM_MARKER, `${CLAIM_MARKER}\n${extraLines.join("\n")}`);
    commentBody = `> Posted by the Greenlight Claims app for @${login}.\n\n${commentBody}`;
    const comment = await github.postIssueComment(body.owner, body.repo, number, commentBody);
    json(res, 201, {
      action: "claim-posted",
      posted: true,
      posted_by: "app",
      claimant: login,
      comment_url: comment && comment.html_url,
      note: "The app webhook records this claim into the durable store; check the ledger for the active claim.",
    });
  });
}
