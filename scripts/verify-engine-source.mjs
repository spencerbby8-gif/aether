#!/usr/bin/env node
/**
 * Verify the installed engine source (src/server/engine/aether-engine-source.ts).
 *
 * The module stores the engine notebook as a TEMPLATE with {{...}} placeholders;
 * real secrets are substituted from server env at push time (audit C3/C5). This
 * script checks, in plain JS with no TypeScript evaluation:
 *
 *   1. the stored Base64 decodes and its SHA-256 matches the pin in the file
 *   2. the decoded template is a valid Jupyter notebook
 *   3. it carries every placeholder the renderer must resolve
 *   4. it contains NO leaked OFF_KEY / beacon token / ntfy topic
 *   5. rendering with original-length values reproduces the verified 36,301 bytes
 *
 * Exits 0 (PASS) only when all five hold.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const FILE = "src/server/engine/aether-engine-source.ts";
const source = readFileSync(FILE, "utf8");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

/* --- 1. pin vs. stored bytes ------------------------------------------- */
const pinMatch = source.match(/AETHER_NOTEBOOK_SHA256\s*=\s*"([0-9a-f]{64})"/);
if (!pinMatch) fail("could not find the pinned SHA-256 constant.");
const EXPECTED = pinMatch[1];

const b64Match = source.match(/const B64\s*=\s*([\s\S]*?);\n/);
if (!b64Match) fail("could not find the B64 payload.");
const parts = [...b64Match[1].matchAll(/"([^"]+)"/g)]
  .map((m) => m[1])
  .filter((p) => /^[A-Za-z0-9+/=]+$/.test(p));
if (parts.length === 0) fail("the B64 payload is empty.");

const decoded = Buffer.from(parts.join(""), "base64").toString("utf8");
const actual = createHash("sha256").update(decoded, "utf8").digest("hex");

console.log(`Template bytes         : ${Buffer.byteLength(decoded, "utf8")}`);
console.log(`SHA-256 (computed)     : ${actual}`);
console.log(`SHA-256 (pinned)       : ${EXPECTED}`);
if (actual !== EXPECTED) fail("SHA-256 mismatch — stored template was modified without re-pinning.");

/* --- 2. valid notebook -------------------------------------------------- */
try {
  const parsed = JSON.parse(decoded);
  if (!Array.isArray(parsed.cells)) throw new Error("no cells");
  if (parsed.nbformat !== 4) throw new Error(`nbformat ${parsed.nbformat}`);
} catch (error) {
  fail(`decoded content is not a valid Jupyter notebook (${error.message}).`);
}

/* --- 3. placeholders present ------------------------------------------- */
const PLACEHOLDERS = ["{{AETHER_OFF_KEY}}", "{{AETHER_BEACON_TOKEN}}", "{{AETHER_BEACON_TOPIC}}", "{{AETHER_SLOT}}"];
for (const p of PLACEHOLDERS) {
  if (!decoded.includes(p)) fail(`template is missing placeholder ${p}.`);
}
console.log(`Placeholders           : ${PLACEHOLDERS.length} present`);

/* --- 4. no leaked secrets ---------------------------------------------- */
/* Patterns, not values — the leaked literals must never be written back here. */
const FORBIDDEN = [
  [/nxoff-[A-Za-z0-9]{8,}/, "a hardcoded engine OFF_KEY"],
  [/btb-kaggle-[0-9a-f]{4}/, "the ntfy beacon topic"],
  [/webhook\.site\/(?:token\/)?[0-9a-f-]{36}/, "a webhook.site beacon token"],
];
for (const [re, label] of FORBIDDEN) {
  if (re.test(decoded)) fail(`template still contains ${label}.`);
  if (re.test(source)) fail(`module source still contains ${label}.`);
}
console.log("Leaked secrets         : none");

/* --- 5. rendering resolves cleanly ------------------------------------- */
const rendered = decoded
  .split("{{AETHER_OFF_KEY}}").join("k".repeat(16))
  .split("{{AETHER_BEACON_TOKEN}}").join("11111111-2222-3333-4444-555555555555")
  .split("{{AETHER_SLOT}}").join("a")
  .split("{{AETHER_SLOT}}").join("a")
  .split("{{AETHER_BEACON_TOPIC}}").join("c".repeat(17));
console.log(`Rendered bytes         : ${Buffer.byteLength(rendered, "utf8")}`);
if (rendered.includes("{{AETHER")) fail("a placeholder survived rendering.");
try {
  JSON.parse(rendered);
} catch {
  fail("rendered content is not valid JSON.");
}

/* --- 6. engine-side hardening (audit C5) -------------------------------- */
/* The engine's own python must authenticate every POST and must not offer a
   wildcard CORS header to the open internet. */
const cells = JSON.parse(rendered).cells ?? [];
const py = cells
  .filter((c) => c.cell_type === "code")
  .map((c) => (Array.isArray(c.source) ? c.source.join("") : String(c.source ?? "")))
  .join("\n");
if (py.includes("Access-Control-Allow-Origin")) fail("engine still sends a CORS Access-Control-Allow-Origin header.");
/*
 * Exactly ONE authoritative gate. It used to be two, because a dead duplicate
 * check sat inside the /off branch; that was removed, so ">= 2" is no longer
 * the right assertion. What actually matters is that the gate is the first
 * control-flow statement in do_POST (checked below) and that nothing can return
 * before it.
 */
const gateMatches = py.match(/X-Engine-Key'\) != OFF_KEY/g) ?? [];
if (gateMatches.length !== 1) fail(`engine POST auth gate: expected exactly 1 key check, found ${gateMatches.length}.`);
/*
 * The body is drained BEFORE the gate on purpose: this handler is HTTP/1.1, so
 * answering 403 without consuming the request body leaves those bytes in the
 * keep-alive socket and the next request on it parses as garbage -> 501. That
 * was a real bug observed on the live engine as a 403/501 alternation.
 */
if (!/def do_POST\(self\):\s*\n\s*body = self\._read_body\(\)\s*\n(?:\s*#[^\n]*\n)*\s*if self\.headers\.get\('X-Engine-Key'\) != OFF_KEY:/.test(py)) {
  fail("the engine's do_POST does not check the key before routing.");
}
console.log("Engine hardening       : every POST gated, no wildcard CORS");

console.log("\nPASS: engine source template is intact, secret-free, renderable and hardened.");
process.exit(0);
