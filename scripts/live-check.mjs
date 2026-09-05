import { chromium } from "playwright";
const URL = process.argv[2] ?? "https://aetherchatt.netlify.app";
const browser = await chromium.launch();
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
page.on("requestfailed", (r) => errors.push(`netfail: ${r.url().slice(0, 120)}`));
await page.goto(URL, { waitUntil: "networkidle", timeout: 45000 }).catch((e) => errors.push(`goto: ${e.message.slice(0, 120)}`));
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/live-desktop.png" });
/* mobile too */
const m = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await m.goto(URL, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
await m.waitForTimeout(2500);
await m.screenshot({ path: "/tmp/live-mobile.png" });
console.log("TITLE:", await page.title().catch(() => "?"));
console.log("ERRORS:", errors.length ? errors.slice(0, 8).join(" | ") : "none");
await browser.close();
