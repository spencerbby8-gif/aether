#!/usr/bin/env node
/**
 * Hard evidence for REAL image + audio generation rendered in the UI.
 * Requests an image and audio from normal chat, waits for the engine, and
 * verifies an <img> / <audio> element is actually rendered (not just a link).
 */
import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3000";
const results = {};
const log = (m) => console.log(m);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text().slice(0, 120)));
page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));

await page.goto(BASE, { waitUntil: "networkidle", timeout: 45000 });
await page.locator("textarea").first().waitFor({ timeout: 20000 });
const ta = page.locator("textarea").first();

async function waitUntilReady(timeoutMs = 240000) {
  const start = Date.now();
  // Phase 1: wait for streaming to begin (stop button appears), up to 60s.
  let sawStreaming = false;
  while (Date.now() - start < 60000) {
    if (await page.locator('button[aria-label="Stop generating"]').isVisible().catch(() => false)) {
      sawStreaming = true;
      break;
    }
    // If a reply already rendered, the response may have completed very fast.
    if (await page.locator(".md").last().isVisible().catch(() => false)) {
      const stopVisible = await page.locator('button[aria-label="Stop generating"]').isVisible().catch(() => false);
      if (!stopVisible) return true; // already done
    }
    await page.waitForTimeout(300);
  }
  // Phase 2: wait for streaming to finish (stop button disappears).
  while (Date.now() - start < timeoutMs) {
    if (!await page.locator('button[aria-label="Stop generating"]').isVisible().catch(() => false)) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

log("=== ITEM 6: IMAGE GENERATION (rendered inline) ===");
await ta.click();
await ta.fill("Generate an image of a red sports car.");
await ta.press("Enter");
await waitUntilReady(240000);
// Look for a rendered image in the latest assistant message.
const imgCount = await page.locator(".md img").count();
const imgSrc = imgCount > 0 ? await page.locator(".md img").last().getAttribute("src") : null;
log(`  Rendered <img> elements: ${imgCount}`);
log(`  Image src: ${imgSrc}`);
results.item6_imageRendered = imgCount > 0;
results.item6_src = imgSrc;
// If an image rendered, verify it actually loads (naturalWidth > 0).
if (imgCount > 0) {
  const dims = await page.locator(".md img").last().evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight }));
  log(`  Image natural dimensions: ${dims.w}x${dims.h} (valid=${dims.w > 0 && dims.h > 0})`);
  results.item6_validImage = dims.w > 0 && dims.h > 0;
}
await page.screenshot({ path: "/tmp/e2e-item6-image.png" });

log("\n=== ITEM 7: AUDIO GENERATION (rendered inline) ===");
await page.getByRole("button", { name: "New chat" }).first().click().catch(() => {});
await page.waitForTimeout(800);
await ta.click();
await ta.fill("Use generate_voice to say hello there as speech audio.");
await ta.press("Enter");
await waitUntilReady(240000);
const audioCount = await page.locator(".md audio").count();
const audioSrc = audioCount > 0 ? await page.locator(".md audio").last().getAttribute("src") : null;
log(`  Rendered <audio> elements: ${audioCount}`);
log(`  Audio src: ${audioSrc}`);
results.item7_audioRendered = audioCount > 0;
results.item7_src = audioSrc;
await page.screenshot({ path: "/tmp/e2e-item7-audio.png" });

log("\n=== SUMMARY ===");
log(JSON.stringify(results, null, 2));
log(`Console/page errors: ${errors.length === 0 ? "NONE" : errors.slice(0, 3).join(" | ")}`);
await browser.close();
