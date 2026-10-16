/**
 * Vercel Node function entry for claim-api.
 *
 * The same request handler that serves the long-running node:http server
 * (`npm start` -> createApp) is default-exported here; Vercel's Node runtime
 * invokes default-exported (req, res) functions directly.
 *
 * vercel.json rewrites every path onto this function. Vercel preserves the
 * original req.url across rewrites, so the router in src/server.mjs sees
 * the real client path (/v1/..., /auth/github/..., /healthz) unchanged.
 *
 * Env vars are read at module load from Vercel's Project Settings; the
 * handler is instantiated once per warm function instance (in-memory
 * session store and the 60s read cache are per-instance, best effort).
 */

import { createRequestHandler } from "../src/server.mjs";

const handler = createRequestHandler();

export default handler;
