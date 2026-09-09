#!/usr/bin/env node
/**
 * Regenerate the Base64 engine notebook in src/server/engine/aether-engine-source.ts
 * from android/app/src/main/assets/aether-notebook-template.json.
 *
 * WHY THIS EXISTS. The engine notebook was stored twice:
 *
 *   android/.../assets/aether-notebook-template.json   what the APK pushes
 *   src/server/engine/aether-engine-source.ts (B64)    what the web app pushes
 *
 * Every patch script in scripts/ edits the JSON asset. But bake-credentials.sh
 * writes that asset FROM the Base64 blob, and scripts/proofs/wake-engines.py
 * pushes the blob. So a fix applied to the asset reached the APK and nothing
 * else -- and the next bake would have wiped it. Verified this turn: the asset
 * carried a num_predict cap the blob did not, so no engine ever ran it.
 *
 * The asset is now the single source of truth. Run this after any patch script,
 * then re-pin the rendered byte length in tests/kaggle-wake-source.test.ts.
 *
 * Usage: node scripts/sync-engine-source.mjs [--check]
 *   --check   report drift and exit 1 without writing
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ASSET = "android/app/src/main/assets/aether-notebook-template.json";
const TS = "src/server/engine/aether-engine-source.ts";
const CHECK = process.argv.includes("--check");

const template = readFileSync(ASSET, "utf8");

// JSON.parse then re-stringify compactly, so the blob is canonical regardless
// of how the asset happens to be formatted on disk.
const canonical = JSON.stringify(JSON.parse(template));

// The pin covers what the blob DECODES to -- that is what
// verify-engine-source.mjs and the test suite hash -- not the asset's bytes on
// disk, which may carry different whitespace.
const sha = createHash("sha256").update(canonical, "utf8").digest("hex");
if (canonical !== template) {
  console.log(
    `note: asset is not byte-canonical (${template.length} vs ${canonical.length}); ` +
      "the blob stores the canonical form",
  );
}
const b64 = Buffer.from(canonical, "utf8").toString("base64");
const chunks = b64.match(/.{1,76}/g) ?? [];

let source = readFileSync(TS, "utf8");

const pinRe = /(AETHER_NOTEBOOK_SHA256\s*=\s*")([0-9a-f]{64})(")/;
if (!pinRe.test(source)) {
  console.error("FAIL: could not find the pinned SHA-256 constant");
  process.exit(1);
}
const b64Re = /const B64\s*=\s*[\s\S]*?;\n/;
if (!b64Re.test(source)) {
  console.error("FAIL: could not find the B64 payload");
  process.exit(1);
}

const currentPin = source.match(pinRe)[2];
const currentB64 = [...(source.match(b64Re)[0].matchAll(/"([^"]+)"/g))]
  .map((m) => m[1])
  .filter((p) => /^[A-Za-z0-9+/=]+$/.test(p))
  .join("");

// Also treat the old concatenated layout as drift: it is what made the file
// unlintable, so an in-sync file in the old shape still needs rewriting.
const flat = /const B64 = \[/.test(source);

if (currentPin === sha && currentB64 === b64 && flat) {
  console.log(`in sync  sha256=${sha.slice(0, 16)}…  ${chunks.length} chunks`);
  process.exit(0);
}
if (currentPin === sha && currentB64 === b64 && !flat) {
  console.log("content in sync, rewriting the payload into the flat array form");
}

console.log(`drift    blob sha256=${currentPin.slice(0, 16)}…  asset sha256=${sha.slice(0, 16)}…`);
if (CHECK) {
  console.error("FAIL: the Base64 blob does not match the notebook asset.");
  console.error("      run: node scripts/sync-engine-source.mjs");
  process.exit(1);
}

// An array joined at runtime, NOT "a" + "b" + "c" ... . Concatenating 1400+
// literals builds a left-nested BinaryExpression that many levels deep and
// eslint's parser dies on it with "Maximum call stack size exceeded" -- the
// file had been unlintable for exactly this reason. An array literal is flat.
const payload =
  "const B64 = [\n" +
  chunks.map((c) => `  "${c}",`).join("\n") +
  '\n].join("");\n';

source = source.replace(pinRe, `$1${sha}$3`).replace(b64Re, payload);
writeFileSync(TS, source);

// Verify from disk, not from what we just wrote.
const back = readFileSync(TS, "utf8");
const roundTrip = Buffer.from(
  [...(back.match(b64Re)[0].matchAll(/"([^"]+)"/g))]
    .map((m) => m[1])
    .filter((p) => /^[A-Za-z0-9+/=]+$/.test(p))
    .join(""),
  "base64",
).toString("utf8");
const ok =
  back.match(pinRe)[2] === sha &&
  JSON.stringify(JSON.parse(roundTrip)) === canonical;

console.log(
  `${ok ? "synced" : "FAIL"}  sha256=${sha.slice(0, 16)}…  ` +
    `${chunks.length} chunks  round-trip ${ok ? "exact" : "MISMATCH"}`,
);
process.exit(ok ? 0 : 1);
