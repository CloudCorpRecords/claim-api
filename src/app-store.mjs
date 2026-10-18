/**
 * Durable claim state for the GitHub App backend.
 *
 * One interface, three backends:
 *   - memory:  process-local Maps (tests, and APP_STATE_MODE=memory)
 *   - local:   JSON files under APP_STATE_DIR mirroring the ledger layout
 *              (dev, APP_STATE_MODE=local)
 *   - ledger:  the claim-ledger repo, written through the GitHub contents
 *              API with the app's installation token (production)
 *
 * Ledger layout:
 *   docs/v1/apps/greenlight-claims/installations.json
 *   docs/v1/apps/greenlight-claims/repos.json               (sweep index)
 *   docs/v1/apps/greenlight-claims/deliveries/<yyyy-mm-dd>.json
 *   docs/v1/repos/<owner>/<repo>/claims-app.json
 *
 * claims-app.json: { updated_at, issues: { "<n>": { active, queue, history } } }
 * The claim shape follows SPEC 3.2 plus valid, invalid_reason, tenure_cap_days
 * and per-event at timestamps.
 *
 * The claim-ledger repo MUST have the app installed (contents write) for the
 * ledger backend. Until then reads degrade to empty state and writes throw
 * 503 app-state-unavailable; the webhook route turns that into its documented
 * 503 while public reads still answer.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { httpError } from "./server.mjs";

const APPS_PREFIX = "docs/v1/apps/greenlight-claims";
const INSTALLATIONS_PATH = `${APPS_PREFIX}/installations.json`;
const REPOS_INDEX_PATH = `${APPS_PREFIX}/repos.json`;
const DELIVERY_PREFIX = `${APPS_PREFIX}/deliveries`;
const MAX_DELIVERY_IDS = 20000;

function claimsPath(owner, repo) {
  return `docs/v1/repos/${owner}/${repo}/claims-app.json`;
}
function deliveryPath(day) {
  return `${DELIVERY_PREFIX}/${day}.json`;
}
function emptyRepoState() {
  return { updated_at: new Date().toISOString(), issues: {} };
}
function emptyInstallations() {
  return { updated_at: new Date().toISOString(), installations: [] };
}

function stateUnavailable(message) {
  return httpError(503, "app-state-unavailable", message);
}

// ---------------------------------------------------------------- memory ---

function createMemoryBackend() {
  const files = new Map(); // path -> object
  return {
    kind: "memory",
    async read(path, fallback) {
      const v = files.get(path);
      return v === undefined ? (typeof fallback === "function" ? fallback() : fallback) : structuredClone(v);
    },
    async write(path, value) {
      files.set(path, structuredClone(value));
    },
    async listRepos() {
      const idx = files.get(REPOS_INDEX_PATH);
      return idx && Array.isArray(idx.repos) ? idx.repos : [];
    },
    async noteRepo(owner, repo) {
      const idx = files.get(REPOS_INDEX_PATH) || { repos: [] };
      if (!idx.repos.some((r) => r.owner === owner && r.repo === repo)) {
        idx.repos.push({ owner, repo });
        files.set(REPOS_INDEX_PATH, idx);
      }
    },
  };
}

// -------------------------------------------------------------- local file ---
//
// Note: the fs layer is injectable ({ readFile, writeFile, mkdir }) so tests
// can run the layout logic against a fake without touching disk.

function createLocalBackend({ stateDir, fs: fsImpl = { readFile, writeFile, mkdir } }) {
  if (!stateDir) throw new Error("APP_STATE_DIR is required for APP_STATE_MODE=local.");
  async function read(path, fallback) {
    try {
      const text = await fsImpl.readFile(join(stateDir, path), "utf8");
      return JSON.parse(text);
    } catch {
      return typeof fallback === "function" ? fallback() : fallback;
    }
  }
  async function write(path, value) {
    const full = join(stateDir, path);
    await fsImpl.mkdir(dirname(full), { recursive: true });
    await fsImpl.writeFile(full, JSON.stringify(value, null, 2));
  }
  return {
    kind: "local",
    read,
    write,
    async listRepos() {
      const idx = await read(REPOS_INDEX_PATH, null);
      return idx && Array.isArray(idx.repos) ? idx.repos : [];
    },
    async noteRepo(owner, repo) {
      const idx = (await read(REPOS_INDEX_PATH, null)) || { repos: [] };
      if (!idx.repos.some((r) => r.owner === owner && r.repo === repo)) {
        idx.repos.push({ owner, repo });
        await write(REPOS_INDEX_PATH, idx);
      }
    },
  };
}

// ------------------------------------------------------------- ledger repo ---

function createLedgerBackend({ config, appAuth, fetchImpl = fetch }) {
  const { ledgerOwner, ledgerRepo } = config;
  let ledgerInstallationId = config.ledgerInstallationId || null;

  async function gh(path, { method = "GET", body } = {}) {
    if (!ledgerInstallationId) {
      ledgerInstallationId = await resolveLedgerInstallation();
    }
    const token = await appAuth.installationToken(ledgerInstallationId);
    const res = await fetchImpl(`https://api.github.com/repos/${ledgerOwner}/${ledgerRepo}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "claim-api/1.0.0",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 403) {
        throw stateUnavailable(
          `The app cannot write claim state: HTTP 403 on the claim-ledger repo. Install the app on ${ledgerOwner}/${ledgerRepo} with contents write (see docs/APP-RUNBOOK.md).`
        );
      }
      throw httpError(502, "ledger-write-failed", `Claim-ledger GitHub call failed: HTTP ${res.status} ${text.slice(0, 160)}`);
    }
    return res.json();
  }

  async function resolveLedgerInstallation() {
    if (config.ledgerInstallationId) return config.ledgerInstallationId;
    const installations = await appAuth.listInstallations();
    const match = (installations || []).find(
      (i) => i.account && i.account.login && i.account.login.toLowerCase() === String(ledgerOwner).toLowerCase()
    );
    if (!match) {
      throw stateUnavailable(
        `The app is not installed on the ${ledgerOwner} account, so claim state has nowhere durable to go. Install it per docs/APP-RUNBOOK.md.`
      );
    }
    return String(match.id);
  }

  async function read(path, fallback) {
    const data = await gh(`contents/${path}?ref=main`);
    if (!data || !data.content) return typeof fallback === "function" ? fallback() : fallback;
    try {
      return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
    } catch {
      return typeof fallback === "function" ? fallback() : fallback;
    }
  }

  async function write(path, value) {
    const message = `claim-app: update ${path}`;
    const existing = await gh(`contents/${path}?ref=main`);
    const body = {
      message,
      content: Buffer.from(JSON.stringify(value, null, 2), "utf8").toString("base64"),
    };
    if (existing && existing.sha) body.sha = existing.sha;
    const result = await gh(`contents/${path}`, { method: "PUT", body });
    if (!result || !result.commit) throw httpError(502, "ledger-write-failed", "Claim-ledger write returned no commit.");
  }

  return {
    kind: "ledger",
    read,
    write,
    async listRepos() {
      const idx = await read(REPOS_INDEX_PATH, null);
      return idx && Array.isArray(idx.repos) ? idx.repos : [];
    },
    async noteRepo(owner, repo) {
      const idx = (await read(REPOS_INDEX_PATH, null)) || { updated_at: new Date().toISOString(), repos: [] };
      if (!idx.repos.some((r) => r.owner === owner && r.repo === repo)) {
        idx.repos.push({ owner, repo });
        idx.updated_at = new Date().toISOString();
        await write(REPOS_INDEX_PATH, idx);
      }
    },
  };
}

// ------------------------------------------------------------------ store ---

export function createAppStore({ config, appAuth, fetchImpl = fetch, now = () => new Date(), fsImpl } = {}) {
  const mode = config.stateMode || "ledger";
  const backend =
    mode === "memory"
      ? createMemoryBackend()
      : mode === "local"
        ? createLocalBackend({ stateDir: config.stateDir, ...(fsImpl ? { fs: fsImpl } : {}) })
        : createLedgerBackend({ config, appAuth, fetchImpl });

  function dayOf(d) {
    return d.toISOString().slice(0, 10);
  }

  return {
    kind: backend.kind,

    async getRepoState(owner, repo) {
      return backend.read(claimsPath(owner, repo), emptyRepoState);
    },

    async putRepoState(owner, repo, state) {
      const stamped = { ...state, updated_at: now().toISOString() };
      await backend.write(claimsPath(owner, repo), stamped);
      await backend.noteRepo(owner, repo);
    },

    async listRepos() {
      return backend.listRepos();
    },

    async getInstallations() {
      return backend.read(INSTALLATIONS_PATH, emptyInstallations);
    },

    async putInstallations(data) {
      await backend.write(INSTALLATIONS_PATH, { ...data, updated_at: now().toISOString() });
    },

    async deliverySeen(day, id) {
      const doc = await backend.read(deliveryPath(day || dayOf(now())), null);
      return !!doc && Array.isArray(doc.ids) && doc.ids.includes(id);
    },

    async recordDelivery(day, id) {
      const d = day || dayOf(now());
      const doc = (await backend.read(deliveryPath(d), null)) || { day: d, ids: [] };
      if (!doc.ids.includes(id)) {
        doc.ids.push(id);
        while (doc.ids.length > MAX_DELIVERY_IDS) doc.ids.shift();
        await backend.write(deliveryPath(d), doc);
      }
    },
  };
}
