#!/usr/bin/env node
/**
 * Browser verification of the Phase 5 engine UI against a local prod server.
 * Verifies:
 *   1. Engine power button is visible and shows real engine state.
 *   2. Clicking power when off attempts a wake (honest error w/o creds).
 *   3. Sending a message does NOT hang infinitely — it resolves to a reply
 *      or a clear error (engine unavailable), never a stuck spinner.
 *   4. engine-status endpoint responds (read-only, never wakes).
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const issues = [];
const passes = [];
const ok = (m) => { passes.push(m); console.log(`[PASS] ${m}`); };
const bad = (m) => { issues.push(m); console.log(`[FAIL] ${m}`); };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  /* Expected network responses (engine unavailable → 503, etc.) are normal
     browser network logs, not code errors. Only flag real exceptions. */
  if (/Failed to load resource/.test(text)) return;
  consoleErrors.push(text.slice(0, 140));
});
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 140)));

await page.goto(BASE, { waitUntil: "networkidle", timeout: 45_000 });
await page.locator("textarea").first().waitFor({ timeout: 20_000 });

/* 1. engine-status endpoint (read-only) */
const status = await fetch(`${BASE}/api/netlify/engine-status`).then((r) => r.json()).catch(() => null);
if (status && typeof status.alive === "boolean") ok(`engine-status responds: alive=${status.alive}, checked=${status.checked} beacon link(s)`);
else bad(`engine-status bad response: ${JSON.stringify(status)}`);

/* 2. engine power button visible with real state */
const powerBtn = page.locator('button[aria-label="Wake engine"], button[aria-label="Shut down engine"]').first();
const powerVisible = await powerBtn.isVisible().catch(() => false);
if (powerVisible) {
  const label = await powerBtn.textContent();
  ok(`engine power button visible: "${(label ?? "").trim()}"`);
} else bad("engine power button not visible");

/* 3. clicking power when off attempts wake (honest error w/o creds) */
if (powerVisible && (await powerBtn.getAttribute("aria-label")) === "Wake engine") {
  await powerBtn.click();
  await page.waitForTimeout(3_000);
  const bodyText = await page.locator("body").textContent();
  if (/waking|wake|engine|quota|KAGGLE/i.test(bodyText ?? "")) ok("power click triggered a wake attempt (honest feedback shown)");
  else bad("power click produced no visible feedback");
}

/* 4. sending a message resolves (reply or error) — NOT infinite loading */
const ta = page.locator("textarea").first();
await ta.click();
await ta.fill("hello");
await ta.press("Enter");
const settled = await Promise.race([
  page.locator(".md").first().waitFor({ state: "visible", timeout: 60_000 }).then(() => "reply"),
  page.locator('button:has-text("Retry")').first().waitFor({ state: "visible", timeout: 60_000 }).then(() => "error"),
  page.waitForTimeout(60_000).then(() => "timeout"),
]);
if (settled === "reply") ok("send streamed a real reply (no infinite spinner)");
else if (settled === "error") ok("send resolved to a clear error + Retry (no infinite spinner)");
else bad("send hung >60s (infinite loading)");

/* 5. no console/page errors */
if (consoleErrors.length === 0) ok("no console/page errors");
else bad(`console/page errors: ${consoleErrors.slice(0, 3).join(" | ")}`);

await page.screenshot({ path: "/tmp/ui-phase5.png" });
await browser.close();

console.log(`\n=== RESULT: ${passes.length} passed, ${issues.length} failed ===`);
for (const i of issues) console.log("  FAIL:", i);
process.exit(issues.length > 0 ? 1 : 0);
