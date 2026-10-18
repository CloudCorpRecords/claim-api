/**
 * Gate check for the app backend: before a claim is accepted as valid, the
 * repo's policy sources are scanned with Greenlight's gate detection.
 *
 * Sources (fetched with the installation token): CONTRIBUTING.md, AGENTS.md,
 * CLAUDE.md, .github/CONTRIBUTING.md, docs/CONTRIBUTING.md, plus
 * .github/workflows files (close-external-PR automation). Any hard gate
 * (assignment_required, vouch_required, collaborators_only,
 * unsolicited_prs_paused, external_prs_closed) or an explicit AI-generated
 * contribution ban marks the claim valid:false with the gate evidence, and
 * the verdict is GATED. Claims are never silently dropped.
 *
 * Results are cached per repo for one hour.
 */

import {
  parseGatesFromSources,
  hardGates,
  detectWorkflowGates,
} from "@reneturcios/greenlight/dist/gates.js";

const POLICY_FILES = [
  "CONTRIBUTING.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
];
const GATES_CACHE_TTL_MS = 3600_000;
const MAX_WORKFLOWS = 12;

const AI_BAN_PATTERNS = [
  /ai[\s-]?generated\s+(pull requests?|prs?|contributions?|code)\s+(are\s+|will\s+be\s+)?(not\s+accepted|rejected|closed|banned|prohibited|not\s+welcome)/i,
  /(we\s+do\s+not|don't|do\s+not)\s+accept\s+ai[\s-]?generated\s+(pull requests?|prs?|contributions?)/i,
  /no\s+ai[\s-]?generated\s+(pull requests?|prs?|contributions?)/i,
  /pull requests?\s+(created|written|authored)\s+(by|with)\s+ai\s+(will\s+be|are\s+)?(closed|rejected|not\s+accepted)/i,
];

export function detectAiContributionBan(text) {
  if (!text) return { detected: false, evidence: null };
  for (const re of AI_BAN_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const start = Math.max(0, m.index - 80);
      const snippet = text.slice(start, m.index + m[0].length + 80).replace(/\s+/g, " ").trim();
      return { detected: true, evidence: `...${snippet}...` };
    }
  }
  return { detected: false, evidence: null };
}

async function readTextFile(github, owner, repo, path) {
  try {
    const data = await github.getContents(owner, repo, path);
    if (!data || !data.content) return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export async function checkRepoGates({ github, owner, repo, cache }) {
  const cacheKey = `appgates:${owner}/${repo}`;
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }

  const sources = [];
  for (const file of POLICY_FILES) {
    const text = await readTextFile(github, owner, repo, file);
    if (text) sources.push({ file, text });
  }

  const gates = parseGatesFromSources(sources);
  const hard = hardGates(gates).map((g) => ({
    kind: g.kind,
    evidence: g.evidence || null,
    file: g.file || null,
  }));

  try {
    const dir = await github.listDir(owner, repo, ".github/workflows");
    const wfFiles = [];
    if (Array.isArray(dir)) {
      for (const entry of dir) {
        if (wfFiles.length >= MAX_WORKFLOWS) break;
        const name = entry && entry.name;
        if (!name || !/\.(ya?ml)$/i.test(name)) continue;
        const text = await readTextFile(github, owner, repo, `.github/workflows/${name}`);
        if (text) wfFiles.push({ name, content: text });
      }
    }
    for (const g of detectWorkflowGates(wfFiles)) {
      if (!hard.some((h) => h.kind === g.kind)) {
        hard.push({ kind: g.kind, evidence: g.evidence || null, file: g.file || ".github/workflows" });
      }
    }
  } catch {
    // Workflow listing is best effort; policy-file gates still apply.
  }

  const combined = sources.map((s) => s.text).join("\n");
  const aiBan = detectAiContributionBan(combined);

  const result = {
    gates: gates.map((g) => ({ kind: g.kind, detected: !!g.detected })),
    hard,
    aiBan: aiBan.detected ? { kind: "ai_generated_banned", evidence: aiBan.evidence } : null,
    verdict: hard.length > 0 || aiBan.detected ? "GATED" : "GO",
    checked_at: new Date().toISOString(),
  };
  if (cache) cache.set(cacheKey, result, GATES_CACHE_TTL_MS);
  return result;
}
