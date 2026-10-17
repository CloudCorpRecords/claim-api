/**
 * Route registration for claim-api.
 */

import { json, readJsonBody, httpError } from "./server.mjs";
import { assembleProtocolState, buildStatusPayload, fetchPolicyState } from "./protocol-live.mjs";
import { claimIssue, releaseClaim, heartbeatClaim } from "./write-actions.mjs";

function parseNum(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, "bad-number", `${name} must be a positive integer.`);
  return n;
}

function bearerToken(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

/**
 * Resolve the caller. Accepts either a claim-api session token (issued by the
 * OAuth callback) or a raw GitHub user token (device flow / PAT). In both
 * cases we verify against GET /user and learn the GitHub login.
 */
async function resolveCaller({ req, sessions, githubFactory }) {
  const token = bearerToken(req);
  if (!token) throw httpError(401, "missing-token", "Send Authorization: Bearer <token>.");
  const session = sessions.get(token);
  const userToken = session ? session.userToken : token;
  const github = githubFactory({ token: userToken });
  let login;
  try {
    login = (await github.user()).login;
  } catch (err) {
    if (err && (err.code === "invalid-token" || err.code === "bad-credentials")) {
      throw httpError(401, "invalid-token", "That token is not valid GitHub credentials.");
    }
    throw err;
  }
  return { login, github, viaSession: !!session };
}

export function registerRoutes({ route, config, githubFactory, sessions, cache }) {
  const serviceGithub = () => githubFactory({ token: config.serviceToken });

  route("GET", /^\/healthz$/, async (req, res) => {
    json(res, 200, { ok: true, service: "claim-api", version: "0.1.1" });
  });

  route("GET", /^\/$/, async (req, res) => {
    json(res, 200, {
      service: "claim-api",
      description: "Phase 3 hosted API for the Greenlight Claim Protocol.",
      endpoints: [
        "GET /v1/issues/:owner/:repo/:number/status",
        "GET /v1/claims/:owner/:repo/:number",
        "GET /v1/repos/:owner/:repo/friction",
        "POST /v1/claims",
        "POST /v1/claims/release",
        "POST /v1/claims/heartbeat",
        "GET /auth/github/login",
        "GET /auth/github/callback",
        "GET /healthz",
      ],
      spec: "https://github.com/CloudCorpRecords/greenlight/blob/main/protocol/SPEC.md",
      ledger: config.ledgerBaseUrl,
    });
  });

  // ---- live reads ----

  route("GET", /^\/v1\/issues\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<number>\d+)\/status$/, async (req, res, url, p) => {
    const number = parseNum(p.number, "issue number");
    const key = `status:${p.owner}/${p.repo}#${number}`;
    const cached = cache.get(key);
    if (cached) return json(res, 200, { ...cached, _cache: "hit" });

    const github = serviceGithub();
    const issue = await github.getIssue(p.owner, p.repo, number);
    if (!issue) throw httpError(404, "issue-not-found", `Issue ${p.owner}/${p.repo}#${number} does not exist.`);
    const nowIso = new Date().toISOString();
    const { computation, linkedPrDetails, honored, policy, dataQuality } = await assembleProtocolState(
      github, p.owner, p.repo, number, nowIso, cache
    );
    const payload = buildStatusPayload({
      owner: p.owner, repo: p.repo, number,
      issueTitle: issue.title,
      computation, linkedPrDetails, honored, policy,
      checkedAt: nowIso,
      dataQuality,
    });
    cache.set(key, payload);
    json(res, 200, { ...payload, _cache: "miss" });
  });

  route("GET", /^\/v1\/claims\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<number>\d+)$/, async (req, res, url, p) => {
    const number = parseNum(p.number, "issue number");
    const github = serviceGithub();
    const issue = await github.getIssue(p.owner, p.repo, number);
    if (!issue) throw httpError(404, "issue-not-found", `Issue ${p.owner}/${p.repo}#${number} does not exist.`);
    const nowIso = new Date().toISOString();
    const { computation, dataQuality } = await assembleProtocolState(github, p.owner, p.repo, number, nowIso, cache);
    json(res, 200, {
      v: 1,
      repo: `${p.owner}/${p.repo}`,
      issue: number,
      generated_at: nowIso,
      active: computation.active,
      queue: computation.queue,
      claims: computation.claims,
      data_quality: dataQuality || { degraded: false, missing: [] },
      _api_note: "Append-only claim chain computed live from GitHub comments. GitHub comments are the source of truth.",
    });
  });

  route("GET", /^\/v1\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/friction$/, async (req, res, url, p) => {
    // Proxy the static Ledger's friction.json; fall back to an honest null.
    try {
      const upstream = await fetch(
        `${config.ledgerBaseUrl}/v1/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/friction.json`,
        { headers: { "User-Agent": "claim-api/0.1.1" }, signal: AbortSignal.timeout(8000) }
      );
      if (upstream.ok) {
        const data = await upstream.json();
        return json(res, 200, { ...data, _api_note: "Proxied from the static Ledger." });
      }
    } catch { /* fall through to the null payload */ }
    json(res, 200, {
      repo: `${p.owner}/${p.repo}`,
      score: null,
      source: "claim-api",
      note: "No friction data for this repo yet.",
      checked_at: new Date().toISOString(),
    });
  });

  // ---- writes (authenticated) ----

  route("POST", /^\/v1\/claims$/, async (req, res) => {
    const { login, github } = await resolveCaller({ req, sessions, githubFactory });
    const body = await readJsonBody(req);
    for (const f of ["owner", "repo", "issue"]) {
      if (!body[f]) throw httpError(400, "missing-field", `Body must include ${f}.`);
    }
    const number = parseNum(body.issue, "issue");
    const result = await claimIssue({
      github,
      owner: body.owner,
      repo: body.repo,
      number,
      login,
      body: { plan: body.plan, eta_days: body.eta_days, queue_ok: body.queue_ok },
    });
    cache.invalidate(`status:${body.owner}/${body.repo}#${number}`);
    json(res, result.posted ? 201 : 200, result);
  });

  route("POST", /^\/v1\/claims\/release$/, async (req, res) => {
    const { login, github } = await resolveCaller({ req, sessions, githubFactory });
    const body = await readJsonBody(req);
    for (const f of ["owner", "repo", "issue"]) {
      if (!body[f]) throw httpError(400, "missing-field", `Body must include ${f}.`);
    }
    const number = parseNum(body.issue, "issue");
    const result = await releaseClaim({ github, owner: body.owner, repo: body.repo, number, login });
    cache.invalidate(`status:${body.owner}/${body.repo}#${number}`);
    json(res, 201, result);
  });

  route("POST", /^\/v1\/claims\/heartbeat$/, async (req, res) => {
    const { login, github } = await resolveCaller({ req, sessions, githubFactory });
    const body = await readJsonBody(req);
    for (const f of ["owner", "repo", "issue"]) {
      if (!body[f]) throw httpError(400, "missing-field", `Body must include ${f}.`);
    }
    const number = parseNum(body.issue, "issue");
    const mode = body.mode === "reaction" ? "reaction" : "comment";
    const result = await heartbeatClaim({ github, owner: body.owner, repo: body.repo, number, login, mode });
    cache.invalidate(`status:${body.owner}/${body.repo}#${number}`);
    json(res, 201, result);
  });

  // ---- OAuth skeleton ----

  route("GET", /^\/auth\/github\/login$/, async (req, res, url) => {
    if (!config.clientId) {
      throw httpError(500, "oauth-not-configured", "GITHUB_CLIENT_ID is not set on this instance.");
    }
    const state = url.searchParams.get("state") || "";
    const redirect = new URL("https://github.com/login/oauth/authorize");
    redirect.searchParams.set("client_id", config.clientId);
    redirect.searchParams.set("scope", "public_repo");
    if (state) redirect.searchParams.set("state", state);
    res.writeHead(302, { Location: redirect.toString() });
    res.end();
  });

  route("GET", /^\/auth\/github\/callback$/, async (req, res, url) => {
    const code = url.searchParams.get("code");
    if (!code) throw httpError(400, "missing-code", "No code in the OAuth callback.");
    if (!config.clientId || !config.clientSecret) {
      throw httpError(500, "oauth-not-configured", "OAuth client credentials are not set on this instance.");
    }
    const github = githubFactory({});
    const userToken = await github.exchangeCode(config.clientId, config.clientSecret, code);
    const { login } = await githubFactory({ token: userToken }).user();
    const sessionToken = sessions.create({ login, userToken });
    if (url.searchParams.get("format") === "json") {
      return json(res, 200, {
        session_token: sessionToken,
        github_login: login,
        usage: "Send Authorization: Bearer <session_token> on write endpoints. You can also use a GitHub user token directly instead of this session token.",
      });
    }
    const html = `<!doctype html><html><body style="font-family:sans-serif;max-width:34em;margin:4em auto">`
      + `<h1>Signed in as @${escapeHtml(login)}</h1>`
      + `<p>Your session token (keep it secret):</p>`
      + `<pre style="word-break:break-all">${escapeHtml(sessionToken)}</pre>`
      + `<p>Use it as <code>Authorization: Bearer &lt;token&gt;</code> on the claim-api write endpoints, `
      + `or pass a GitHub personal access token instead.</p></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
