/**
 * claim-api Vercel entry tests: the api/index.mjs default export is the
 * same request handler that serves `npm start`, invoked here with mock
 * req/res pairs the way Vercel's Node runtime would (async (req, res)).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/index.mjs";
import { createRequestHandler, readJsonBody } from "../src/server.mjs";

function mockReq({ method = "GET", url = "/healthz", headers = {}, body } = {}) {
  const req = { method, url, headers };
  if (body !== undefined) req.body = body;
  return req;
}

function mockRes() {
  const captured = { status: null, headers: null, text: null };
  const res = {
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(text) {
      captured.text = text;
    },
  };
  return { res, captured };
}

test("api/index.mjs default-exports a request handler function", () => {
  assert.equal(typeof handler, "function");
});

test("Vercel entry handler answers /healthz with a mock req/res", async () => {
  const { res, captured } = mockRes();
  await handler(mockReq({ url: "/healthz" }), res);
  assert.equal(captured.status, 200);
  const body = JSON.parse(captured.text);
  assert.equal(body.ok, true);
  assert.equal(body.service, "claim-api");
});

test("Vercel entry handler sees the original path, not the rewrite destination", async () => {
  // Vercel preserves req.url across rewrites; the router must route on the
  // client path. A leaked rewrite destination like /api/index.mjs 404s.
  const { res, captured } = mockRes();
  await handler(mockReq({ url: "/v1/repos/acme/repo/friction" }), res);
  assert.equal(captured.status, 200);
});

test("readJsonBody accepts a pre-parsed object body (platform pre-parse case)", async () => {
  const parsed = await readJsonBody(mockReq({ method: "POST", body: { owner: "acme" } }));
  assert.deepEqual(parsed, { owner: "acme" });
});

test("readJsonBody accepts a pre-parsed string body (platform pre-parse case)", async () => {
  const parsed = await readJsonBody(mockReq({ method: "POST", body: '{"n":1}' }));
  assert.deepEqual(parsed, { n: 1 });
});

test("createRequestHandler builds a handler independent of the module-level entry", async () => {
  const local = createRequestHandler({ config: { ledgerBaseUrl: "https://example.invalid" } });
  assert.equal(typeof local, "function");
  const { res, captured } = mockRes();
  await local(mockReq({ url: "/healthz" }), res);
  assert.equal(captured.status, 200);
});
