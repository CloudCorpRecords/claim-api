/**
 * Tests: repo gate check (policy sources, hard gates, AI-ban heuristic).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRepoGates, detectAiContributionBan } from "../src/app-gates.mjs";

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

/** Minimal installation-token client stub over a path->text map. */
function stubGithub(files) {
  return {
    async getContents(owner, repo, path) {
      if (!(path in files)) {
        const err = new Error("not found");
        err.httpStatus = 404;
        throw err;
      }
      return { content: b64(files[path]) };
    },
    async listDir() {
      return null;
    },
  };
}

test("clean repo: GO verdict, no hard gates", async () => {
  const github = stubGithub({ "CONTRIBUTING.md": "# Contributing\nBe nice.\n" });
  const r = await checkRepoGates({ github, owner: "acme", repo: "repo", cache: null });
  assert.equal(r.verdict, "GO");
  assert.equal(r.hard.length, 0);
  assert.equal(r.aiBan, null);
});

test("paused unsolicited PRs: GATED with evidence", async () => {
  const github = stubGithub({
    "CONTRIBUTING.md": "# Contributing\nWe have temporarily paused unsolicited pull requests from outside the core team.\n",
  });
  const r = await checkRepoGates({ github, owner: "acme", repo: "repo", cache: null });
  assert.equal(r.verdict, "GATED");
  assert.ok(r.hard.some((g) => g.kind === "unsolicited_prs_paused"));
  assert.ok(r.hard[0].evidence);
});

test("AI-generated PR ban: detected with evidence quote", async () => {
  const text = "# Contributing\nAI-generated pull requests are not accepted and will be closed.\n";
  const ban = detectAiContributionBan(text);
  assert.equal(ban.detected, true);
  assert.ok(ban.evidence.includes("AI-generated"));
  const github = stubGithub({ "CONTRIBUTING.md": text });
  const r = await checkRepoGates({ github, owner: "acme", repo: "repo", cache: null });
  assert.equal(r.verdict, "GATED");
  assert.equal(r.aiBan.kind, "ai_generated_banned");
});

test("AI-ban heuristic does not fire on innocent mentions", () => {
  const ban = detectAiContributionBan("# Contributing\nWe use AI tooling to review code faster.\n");
  assert.equal(ban.detected, false);
  assert.equal(detectAiContributionBan("").detected, false);
});

test("results are cached per repo", async () => {
  let calls = 0;
  const github = stubGithub({ "CONTRIBUTING.md": "# hi\n" });
  const inner = github.getContents.bind(github);
  github.getContents = async (...a) => {
    calls += 1;
    return inner(...a);
  };
  const cache = new Map();
  const wrapped = {
    get: (k) => cache.get(k),
    set: (k, v) => cache.set(k, v),
  };
  await checkRepoGates({ github, owner: "acme", repo: "repo", cache: wrapped });
  await checkRepoGates({ github, owner: "acme", repo: "repo", cache: wrapped });
  assert.equal(calls, 5); // 5 policy files fetched once
});

test("missing policy files: GO, best effort", async () => {
  const github = stubGithub({});
  const r = await checkRepoGates({ github, owner: "acme", repo: "repo", cache: null });
  assert.equal(r.verdict, "GO");
});
