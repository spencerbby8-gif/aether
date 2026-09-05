#!/usr/bin/env node
/**
 * LIVE PROOF the engine WAKE switch can no longer hang forever.
 * This reproduces the exact reported bug: engine is OFF, the user clicks the
 * power button, and the wake request never settles (host-killed function).
 * Verifies the button recovers and the page stays interactive.
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3000";
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => { console.log(`[FAIL] ${m}`); process.exitCode = 1; };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text().slice(0, 120)));
page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));

/* Force the engine to read as OFFLINE before the app loads, so the power
   button is in the "Engine off → click to wake" state (the bug scenario). */
await page.route("**/api/netlify/engine-status", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ state: "offline", alive: false, url: null, model: null, checked: 0, waking: false, latencyMs: 1 }),
}));
/* Make the WAKE endpoint hang forever — the request never settles. */
await page.route("**/api/netlify/ensure-alive", () => new Promise(() => {}));

await page.goto(BASE, { waitUntil: "networkidle", timeout: 45000 });
await page.locator("textarea").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(2500);

const powerBtn = page.locator('button[aria-label*="engine" i]').first();
const beforeLabel = await powerBtn.textContent();
const beforeAria = await powerBtn.getAttribute("aria-label");
console.log(`Initial state: label="${beforeLabel?.trim()}" aria="${beforeAria}"`);
if (!/off/i.test(beforeLabel ?? "")) {
  console.log("  (button not in off state — continuing anyway)");
}

/* Click the power button: fires a WAKE that will never get a response. */
await powerBtn.click();
console.log("Clicked WAKE with a hanging server response (the reported bug)...");
const clickTime = Date.now();

/* The button must become usable again — the original bug left it spinning forever. */
let recovered = false;
let recoveredAt = 0;
while (Date.now() - clickTime < 30_000) {
  const disabled = await powerBtn.isDisabled().catch(() => true);
  if (!disabled) { recovered = true; recoveredAt = Date.now() - clickTime; break; }
  await page.waitForTimeout(250);
}

if (recovered) {
  pass(`WAKE button recovered after ${recoveredAt}ms (previously: stuck forever).`);
} else {
  fail("WAKE button stayed disabled 30s+ — STILL HANGS.");
}

/* Page must remain interactive. */
if (await page.locator("textarea").first().isEnabled().catch(() => false)) pass("Page remains interactive.");
else fail("Page froze.");

const labelAfter = await powerBtn.textContent().catch(() => "");
console.log(`Button label while hung: "${labelAfter?.trim()}"`);
await page.screenshot({ path: "/tmp/switch-wake-hang.png" });

/* Unblock and verify normal operation resumes. */
await page.unroute("**/api/netlify/ensure-alive");
await page.unroute("**/api/netlify/engine-status");
await page.waitForTimeout(5000);
const liveLabel = await powerBtn.textContent().catch(() => "");
console.log(`Button label after unblocking: "${liveLabel?.trim()}"`);
if (/live/i.test(liveLabel ?? "")) pass("Status returned to the real live state after unblocking.");
else console.log("  (status after unblocking: still settling)");

if (errors.length === 0) pass("No console/page errors.");
else console.log(`Console errors: ${errors.slice(0, 3).join(" | ")}`);

await browser.close();
console.log(`\nRESULT: ${process.exitCode ? "FAILED" : "PASS"}`);
