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
 *
 * Two ways to serve it with the SAME handler:
 *   - long-running node:http server: `npm start` (createApp)
 *   - Vercel Node function: api/index.mjs default-exports createRequestHandler()
 */

import { createServer } from "node:http";
import { registerRoutes } from "./routes.mjs";
import { createSessions } from "./sessions.mjs";
import { createCache } from "./cache.mjs";
import { createServiceGitHub } from "./github.mjs";

/**
 * Build the request handler as a plain async (req, res) function.
 * Vercel's Node functions accept exactly this shape, and the long-running
 * server wraps it with node:http's createServer. Vercel preserves the
 * original req.url across vercel.json rewrites, so the router below sees
 * the real client path (e.g. /v1/issues/...) unchanged.
 */
export function createRequestHandler(deps = {}) {
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

  return async function requestHandler(req, res) {
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
  };
}

/**
 * The long-running node:http server (`npm start`). Returns the server,
 * exactly as before; the refactor only moved the listener into
 * createRequestHandler.
 */
export function createApp(deps = {}) {
  return createServer(createRequestHandler(deps));
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
  // Vercel's Node runtime passes req as a readable stream, same as
  // node:http. If some platform pre-parses the body onto req.body, accept
  // that too instead of fighting the stream.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      if (!req.body.length) return {};
      try {
        return JSON.parse(req.body);
      } catch {
        throw httpError(400, "bad-json", "Request body is not valid JSON.");
      }
    }
    if (Buffer.isBuffer(req.body)) {
      if (!req.body.length) return {};
      try {
        return JSON.parse(req.body.toString("utf8"));
      } catch {
        throw httpError(400, "bad-json", "Request body is not valid JSON.");
      }
    }
    if (typeof req.body === "object") return req.body;
  }
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
