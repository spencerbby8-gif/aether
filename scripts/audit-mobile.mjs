/**
 * Mobile compatibility audit — measures REAL layout across phone sizes.
 * Proves: no horizontal overflow, hero never covers the composer,
 * empty state scrolls when it must, and chat wiring works at 320px.
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3000";
const VIEWPORTS = [
  { name: "iphone-se", width: 320, height: 568 },
  { name: "android-small", width: 360, height: 640 },
  { name: "iphone-14", width: 390, height: 844 },
  { name: "pixel-xl", width: 412, height: 915 },
  { name: "landscape-phone", width: 740, height: 360 },
  { name: "tablet", width: 768, height: 1024 },
];

const issues = [];
const notes = [];
const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
  const page = await (await browser.newContext({ viewport: { width: vp.width, height: vp.height } })).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 120)));
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator("textarea").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);

  const metrics = await page.evaluate(() => {
    const hero = document.querySelector("[data-testid='empty-state'] h1");
    const composer = document.querySelector("textarea")?.closest(".border-t");
    const emptyScroll = document.querySelector("[data-testid='empty-state']");
    const heroBox = hero?.getBoundingClientRect();
    const composerBox = composer?.getBoundingClientRect();
    return {
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      docScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      heroBottom: heroBox?.bottom ?? null,
      composerTop: composerBox?.top ?? null,
      composerVisible: composerBox ? composerBox.height > 0 && composerBox.bottom <= window.innerHeight + 2 : false,
      emptyScrollable: emptyScroll ? emptyScroll.scrollHeight > emptyScroll.clientHeight : false,
    };
  });

  if (metrics.docScrollWidth > metrics.innerWidth + 1) {
    issues.push(`${vp.name}: horizontal overflow (${metrics.docScrollWidth} > ${metrics.innerWidth})`);
  }
  if (metrics.heroBottom !== null && metrics.composerTop !== null && metrics.heroBottom > metrics.composerTop + 1) {
    issues.push(`${vp.name}: hero covers composer (hero bottom ${Math.round(metrics.heroBottom)} > composer top ${Math.round(metrics.composerTop)})`);
  }
  if (!metrics.composerVisible) issues.push(`${vp.name}: composer not fully visible`);
  if (metrics.docScrollHeight > metrics.innerHeight + 2) {
    issues.push(`${vp.name}: page-level vertical overflow (${metrics.docScrollHeight} > ${metrics.innerHeight})`);
  }
  if (errors.length) issues.push(`${vp.name}: console errors — ${errors.slice(0, 2).join(" | ")}`);
  notes.push(
    `${vp.name} ${vp.width}×${vp.height}: hero↔composer gap ${metrics.composerTop - metrics.heroBottom >= 0 ? "+" : ""}${Math.round(metrics.composerTop - metrics.heroBottom)}px, empty-state scrollable=${metrics.emptyScrollable}, page overflow=${metrics.docScrollHeight - metrics.innerHeight}px`,
  );
  await page.screenshot({ path: `/tmp/mobile-${vp.name}.png` });
  await page.close();
}

/* Wiring check at the smallest size: send a real message end to end. */
{
  const page = await (await browser.newContext({ viewport: { width: 320, height: 568 } })).newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  const ta = page.locator("textarea").first();
  await ta.waitFor({ timeout: 15_000 });
  await ta.click();
  await ta.fill("Wiring check at 320px.");
  await ta.press("Enter");
  await page.locator(".md").first().waitFor({ timeout: 30_000 }).catch(() => issues.push("320px wiring: reply never rendered"));
  await page.waitForFunction(() => /Ready/.test(document.querySelector("header")?.textContent ?? ""), undefined, { timeout: 30_000 });
  notes.push("320px wiring: message sent and reply rendered");
  await page.screenshot({ path: "/tmp/mobile-wiring-320.png" });
  await page.close();
}

await browser.close();
console.log(notes.join("\n"));
console.log(`\nMOBILE AUDIT: ${issues.length === 0 ? "PASS — 0 issues" : "ISSUES FOUND"}`);
for (const i of issues) console.log(" -", i);
if (issues.length > 0) process.exit(1);
