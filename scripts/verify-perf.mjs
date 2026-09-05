/**
 * Performance evidence: startup time, per-reply latency across a growing
 * conversation, streaming responsiveness, and render load of long history.
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3000";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const results = { startupMs: null, replies: [], messageBubbles: 0 };

const t0 = Date.now();
await page.goto(BASE, { waitUntil: "networkidle" });
await page.locator("textarea").first().waitFor({ timeout: 15_000 });
results.startupMs = Date.now() - t0;

const ta = page.locator("textarea").first();
const headerText = () => page.evaluate(() => document.querySelector("header")?.textContent ?? "");
for (let i = 0; i < 8; i += 1) {
  const t1 = Date.now();
  await ta.click();
  await ta.fill(`Reply check ${i + 1}: give one short bullet about storage.`);
  await ta.press("Enter");
  /* Cycle started: the phase must leave Ready (Thinking/Responding). */
  await page.waitForFunction(
    () => !/Ready/.test(document.querySelector("header")?.textContent ?? ""),
    undefined,
    { timeout: 10_000 },
  );
  /* Cycle completed: phase returns to Ready — which only flips after the
     final message is committed. */
  await page.waitForFunction(
    () => /Ready/.test(document.querySelector("header")?.textContent ?? ""),
    undefined,
    { timeout: 30_000 },
  );
  results.replies.push(Date.now() - t1);
}

results.assistantMessages = await page.locator(".md").count();
results.headerAfter = await headerText();
/* Scroll the full history once to force layout of everything. */
const t2 = Date.now();
await page.evaluate(() => {
  const el = document.querySelector(".overflow-y-auto");
  if (el) { el.scrollTop = 0; el.scrollTop = el.scrollHeight; }
});
results.fullScrollMs = Date.now() - t2;

await browser.close();
console.log(JSON.stringify(results, null, 1));
const slow = results.replies.filter((r) => r > 4000);
console.log(slow.length === 0 ? "PERF OK — every reply < 4s" : `PERF ISSUE — slow replies: ${slow.join(", ")}`);
