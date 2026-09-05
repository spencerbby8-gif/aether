#!/usr/bin/env node
/**
 * Verify the installed verified engine source (src/server/engine/aether-engine-source.ts).
 * Strips the minimal TypeScript annotations, evaluates the module, calls
 * getAetherNotebook(), and checks the decoded notebook's SHA-256 against the
 * pinned AETHER_NOTEBOOK_SHA256. Exits 0 (PASS) only when they match — i.e.
 * the real verified notebook from the handoff is correctly installed.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

const FILE = "src/server/engine/aether-engine-source.ts";
const EXPECTED = "3dc068d15a4c745db14c8c42ba841eca5862406761bff9b0633385848c561ddd";

let source = readFileSync(FILE, "utf8");

/* Minimal TS→JS strip for this specific module (exports + `: string` types). */
source = source
  .replace(/^export const /gm, "const ")
  .replace(/^export function /gm, "function ")
  .replace(/\): string \{/g, ") {")
  + "\n;module.exports = { getAetherNotebook, AETHER_NOTEBOOK_SHA256 };\n";

let mod;
try {
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function("module", "exports", "require", source);
  fn(m, m.exports, nodeRequire);
  mod = m.exports;
} catch (error) {
  console.error("FAIL: could not evaluate aether-engine-source.ts:", error.message);
  process.exit(1);
}

const { getAetherNotebook, AETHER_NOTEBOOK_SHA256 } = mod;

if (AETHER_NOTEBOOK_SHA256 !== EXPECTED) {
  console.error(`FAIL: pinned hash ${AETHER_NOTEBOOK_SHA256} !== expected ${EXPECTED}`);
  process.exit(1);
}

let notebook;
try {
  notebook = getAetherNotebook(); // throws if B64 empty / hash mismatch / not JSON
} catch (error) {
  console.error(`FAIL: getAetherNotebook() threw: ${error.message}`);
  console.error("The B64 payload is not installed or does not match the pinned hash.");
  process.exit(1);
}

const actual = createHash("sha256").update(notebook, "utf8").digest("hex");
const bytes = Buffer.byteLength(notebook, "utf8");
console.log(`Decoded notebook bytes : ${bytes}`);
console.log(`SHA-256 (computed)     : ${actual}`);
console.log(`SHA-256 (pinned)       : ${AETHER_NOTEBOOK_SHA256}`);

if (actual !== EXPECTED) {
  console.error("\nFAIL: SHA-256 mismatch — installed source is NOT the verified notebook.");
  process.exit(1);
}
try {
  const parsed = JSON.parse(notebook);
  if (!Array.isArray(parsed.cells)) throw new Error("no cells");
} catch {
  console.error("\nFAIL: decoded content is not a valid Jupyter notebook.");
  process.exit(1);
}

console.log("\nPASS: verified engine source is correctly installed. Wake will push it.");
process.exit(0);
