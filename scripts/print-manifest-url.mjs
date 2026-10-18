/**
 * Prints the GitHub App manifest URL for the Greenlight Claims registration tap.
 *
 * Usage: node scripts/print-manifest-url.mjs
 *
 * Open the printed URL in a browser signed in as CloudCorpRecords, review the
 * prefilled values, and click "Create GitHub App". See docs/APP-RUNBOOK.md
 * for the full tap. This script touches no secrets: the manifest carries
 * only public configuration.
 */

import { readFileSync } from "node:fs";

const manifestPath = new URL("../app-manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const url =
  "https://github.com/settings/apps/new?manifest=" +
  encodeURIComponent(JSON.stringify(manifest));

console.log("Open this URL in a browser signed in as CloudCorpRecords:\n");
console.log(url);
console.log("\nThen follow docs/APP-RUNBOOK.md.");
