/**
 * Tests: app store interface over the memory backend (ledger and local
 * backends share the same interface; the ledger backend's GitHub calls are
 * covered by the webhook integration tests via injected fetch).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppStore } from "../src/app-store.mjs";

function memoryStore() {
  return createAppStore({ config: { stateMode: "memory" } });
}

test("repo state round trip with empty default", async () => {
  const s = memoryStore();
  const empty = await s.getRepoState("acme", "repo");
  assert.deepEqual(empty.issues, {});
  const state = { issues: { 42: { active: { claimant: "alice" }, queue: [], history: [] } } };
  await s.putRepoState("acme", "repo", state);
  const back = await s.getRepoState("acme", "repo");
  assert.equal(back.issues["42"].active.claimant, "alice");
  assert.ok(back.updated_at);
});

test("listRepos tracks written repos without duplicates", async () => {
  const s = memoryStore();
  await s.putRepoState("acme", "a", { issues: {} });
  await s.putRepoState("acme", "b", { issues: {} });
  await s.putRepoState("acme", "a", { issues: {} });
  const repos = await s.listRepos();
  assert.equal(repos.length, 2);
});

test("deliveries are idempotent per day", async () => {
  const s = memoryStore();
  assert.equal(await s.deliverySeen("2026-10-18", "d1"), false);
  await s.recordDelivery("2026-10-18", "d1");
  assert.equal(await s.deliverySeen("2026-10-18", "d1"), true);
  await s.recordDelivery("2026-10-18", "d1"); // replay: no duplicate
  assert.equal(await s.deliverySeen("2026-10-19", "d1"), false);
});

test("installations round trip", async () => {
  const s = memoryStore();
  const empty = await s.getInstallations();
  assert.deepEqual(empty.installations, []);
  await s.putInstallations({ installations: [{ installation_id: "7", account: "acme", repos: [] }] });
  const back = await s.getInstallations();
  assert.equal(back.installations[0].installation_id, "7");
});

test("local backend mirrors the ledger layout on disk", async () => {
  // The sandbox denies file writes from processes that loaded workspace
  // modules, so the local backend's fs layer is injected as a fake here.
  // The layout logic (paths, JSON round trip, repo index) is what is under
  // test; real disk IO is exercised by hand in dev with APP_STATE_MODE=local.
  const files = new Map();
  const fakeFs = {
    async readFile(p) {
      if (!files.has(p)) {
        const err = new Error("not found");
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    },
    async writeFile(p, content) {
      files.set(p, content);
    },
    async mkdir() {},
  };
  const s = createAppStore({ config: { stateMode: "local", stateDir: "/state" }, fsImpl: fakeFs });
  await s.putRepoState("acme", "repo", { issues: { 1: { active: null, queue: [], history: [] } } });
  const back = await s.getRepoState("acme", "repo");
  assert.deepEqual(back.issues["1"].queue, []);
  const repos = await s.listRepos();
  assert.equal(repos.length, 1);
  await s.recordDelivery("2026-10-18", "d9");
  assert.equal(await s.deliverySeen("2026-10-18", "d9"), true);
  // Layout check: files land at the ledger-mirroring relative paths.
  const paths = [...files.keys()].map((p) => p.replace(/^\/state\//, ""));
  assert.ok(paths.includes("docs/v1/repos/acme/repo/claims-app.json"));
  assert.ok(paths.includes("docs/v1/apps/greenlight-claims/repos.json"));
  assert.ok(paths.includes("docs/v1/apps/greenlight-claims/deliveries/2026-10-18.json"));
});
