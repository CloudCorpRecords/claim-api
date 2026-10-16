/**
 * claim-api: Phase 3 hosted API for the Greenlight Claim Protocol.
 *
 * Live reads (authenticated with the service's own token for rate limits)
 * plus authenticated writes (claim, release, heartbeat) that post protocol
 * comments AS THE USER via their GitHub OAuth token.
 *
 * GitHub is the source of truth: every write is a public comment; the API
 * never invents state. Reads compute protocol state from live comments with
 * the Greenlight engine (@reneturcios/greenlight/dist/protocol.js).
 *
 * Stack: raw node:http + a tiny router, zero runtime dependencies beyond the
 * Greenlight engine. Node 20+.
 */

import { createServer } from "node:http";
import { registerRoutes } from "./routes.mjs";
import { createSessions } from "./sessions.mjs";
import { createCache } from "./cache.mjs";
import { createServiceGitHub } from "./github.mjs";

export function createApp(deps = {}) {
  const config = {
    clientId: process.env.GITHUB_CLIENT_ID || "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
    serviceToken: process.env.SERVICE_GITHUB_TOKEN || "",
    ledgerBaseUrl: (process.env.LEDGER_BASE_URL || "https://cloudcorprecords.github.io/claim-ledger").replace(/\/$/, ""),
    sessionSecret: process.env.SESSION_SECRET || "",
    appBaseUrl: (process.env.APP_BASE_URL || "").replace(/\/$/, ""),
    ...(deps.config || {}),
  };
  const githubFactory = deps.githubFactory || createServiceGitHub;
  const sessions = deps.sessions || createSessions();
  const cache = deps.cache || createCache();
  const routes = [];

  function route(method, pattern, handler) {
    routes.push({ method, pattern, handler });
  }

  registerRoutes({ route, config, githubFactory, sessions, cache });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const match = routes.find(
      (r) => r.method === req.method && r.pattern.test(url.pathname)
    );
    if (!match) {
      return json(res, 404, { error: "not-found", message: `No ${req.method} ${url.pathname}` });
    }
    try {
      await match.handler(req, res, url, match.pattern.exec(url.pathname).groups || {});
    } catch (err) {
      const status = err && err.httpStatus ? err.httpStatus : 500;
      const body = {
        error: (err && err.code) || "internal-error",
        message: status === 500 ? "Unexpected server error." : String((err && err.message) || err),
      };
      if (err && err.holder) body.holder = err.holder;
      json(res, status, body);
    }
  });
  return server;
}

export function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw httpError(413, "body-too-large", "Request body too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "bad-json", "Request body is not valid JSON.");
  }
}

export function httpError(httpStatus, code, message) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  err.code = code;
  return err;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  createApp().listen(port, () => {
    console.log(`claim-api listening on :${port} (ledger base: ${process.env.LEDGER_BASE_URL || "default"})`);
  });
}
