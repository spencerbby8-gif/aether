/**
 * Aether final production audit — drives the REAL app in headless Chromium.
 * Collects console errors, failed/duplicate network requests, hydration
 * issues, broken buttons, and workflow failures as actionable findings.
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3000";
const issues = [];
const notes = [];
const note = (m) => { notes.push(m); console.log(`[audit] ${m}`); };
const issue = (m) => { issues.push(m); console.log(`[ISSUE] ${m}`); };

function attachWatchers(page, tag) {
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      /* 503 from engine endpoints is an honest lifecycle state, not a defect. */
      if (/status of 503/.test(text)) notes.push(`${tag} honest engine 503 surfaced in UI`);
      else issue(`${tag} console error: ${text.slice(0, 200)}`);
    }
    if (msg.type() === "warning" && /hydrat/i.test(msg.text())) issue(`${tag} hydration warning: ${msg.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => issue(`${tag} page error: ${String(e).slice(0, 200)}`));
  const requests = new Map();
  page.on("request", (r) => {
    const url = r.url();
    if (url.startsWith(BASE)) requests.set(url, (requests.get(url) ?? 0) + 1);
    /* blob: URLs are local object URLs, not external traffic. */
    if (!url.startsWith(BASE) && !url.startsWith("blob:") && !url.includes("fonts.googleapis") && !url.includes("fonts.gstatic")) {
      issue(`${tag} unexpected external request: ${url.slice(0, 160)}`);
    }
  });
  page.on("response", (res) => {
    if (res.url().startsWith(BASE) && res.status() >= 400 && res.status() !== 404) {
      // 503 from engine endpoints is an honest state, not a bug — record as note
      if (res.status() === 503 && /engine|agent\/stream/.test(res.url())) {
        notes.push(`${tag} honest 503: ${res.url()}`);
      } else {
        issue(`${tag} HTTP ${res.status()}: ${res.url()}`);
      }
    }
  });
  return requests;
}

const browser = await chromium.launch();

/* ================= DESKTOP AUDIT ================= */
{
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const requests = attachWatchers(page, "desktop");

  note("1. initial load");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByText("What should we build today?").waitFor({ timeout: 15_000 });

  note("2. mock chat roundtrip");
  const ta = page.locator("textarea").first();
  await ta.fill("Hello Aether, give me a short table of two storage options.");
  await ta.press("Enter");
  await page.locator(".md table").first().waitFor({ timeout: 20_000 }).catch(() => issue("chat: markdown table did not render"));
  const mdTables = await page.locator(".md table").count();
  if (mdTables > 0) note(`chat rendered with ${mdTables} table(s)`);

  note("3. copy button on assistant message");
  const copyBtn = page.locator('button[title="Copy"]').first();
  await copyBtn.waitFor({ timeout: 5_000 }).catch(() => issue("chat: no copy action on assistant message"));
  if (await copyBtn.count()) { await copyBtn.click(); note("copy action fired"); }

  note("4. agent task with real steps");
  await page.getByRole("button", { name: "New chat" }).first().click();
  await ta.fill("/task Write a Node script that prints numbers and run it");
  await ta.press("Enter");
  await page.getByText("Task complete.").first().waitFor({ timeout: 60_000 });
  await page.getByText("Agent plan").first().waitFor({ timeout: 5_000 }).catch(() => issue("task: plan panel missing"));
  await page.waitForFunction(() => /Ready/.test(document.querySelector("header")?.textContent ?? ""), undefined, { timeout: 30_000 });

  note("5. media generation + workspace media tab + lightbox");
  await page.getByRole("button", { name: "New chat" }).first().click();
  await page.waitForFunction(() => /Ready/.test(document.querySelector("header")?.textContent ?? ""), undefined, { timeout: 10_000 });
  await ta.fill("/task Draw an abstract ember artwork");
  await ta.press("Enter");
  await page.getByText("Task complete.").first().waitFor({ timeout: 60_000 });
  const genImg = page.locator('button img[src^="blob:"]').first();
  await genImg.waitFor({ timeout: 10_000 }).catch(() => issue("media: generated image not in chat"));
  await genImg.click();
  await page.getByRole("dialog", { name: "Media viewer" }).waitFor({ timeout: 5_000 }).catch(() => issue("media: lightbox did not open"));
  const downloadHref = await page.locator('a[download]').first().getAttribute("href").catch(() => null);
  if (!downloadHref?.startsWith("blob:")) issue("media: lightbox download link missing/invalid");
  await page.keyboard.press("Escape");

  note("6. workspace tabs");
  await page.getByRole("button", { name: "Workspace" }).click();
  await page.getByRole("button", { name: "Media", exact: true }).click();
  await page.getByText("Media jobs", { exact: true }).first().waitFor({ timeout: 5_000 }).catch(() => issue("workspace: media tab broken"));
  await page.getByRole("button", { name: "Memory" }).click();
  await page.getByText("Facts & decisions").waitFor({ timeout: 5_000 }).catch(() => issue("workspace: memory tab broken"));
  await page.getByRole("button", { name: "Overview" }).click();
  await page.getByText("Media assets").waitFor({ timeout: 5_000 }).catch(() => issue("workspace: overview media card missing"));

  note("7. settings: providers, engine panel, toggles");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText("Engine power · two Kaggle GPUs").waitFor({ timeout: 5_000 }).catch(() => issue("settings: engine panel missing"));
  await page.getByText("Real engine (Kaggle GPUs)").click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Close settings" }).click();

  note("8. engine chat honest error + retry affordance");
  await page.getByRole("button", { name: "New chat" }).first().click();
  await ta.fill("Hello real engine");
  await ta.press("Enter");
  await page.getByText(/Engine unavailable/i).first().waitFor({ timeout: 30_000 }).catch(() => issue("engine: honest unavailable state missing"));
  const retryBtn = page.locator('button:has-text("Retry")').first();
  await retryBtn.waitFor({ timeout: 5_000 }).catch(() => issue("engine: error message missing Retry action"));
  if (await retryBtn.count()) note("error path shows Retry action");
  /* Back to the mock provider for the remaining checks. */
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText("Aether server", { exact: false }).first().click();
  await page.getByRole("button", { name: "Close settings" }).click();

  note("9. search modal");
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Search conversations and messages…").waitFor({ timeout: 5_000 }).catch(() => issue("search: modal did not open"));
  await page.getByPlaceholder("Search conversations and messages…").fill("storage");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");

  note("10. attachment upload roundtrip");
  await page.getByRole("button", { name: "New chat" }).first().click();
  const pngBase64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 64; c.height = 64;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#e2b161"; ctx.fillRect(0, 0, 64, 64);
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"]').setInputFiles({ name: "audit.png", mimeType: "image/png", buffer: Buffer.from(pngBase64, "base64") });
  await page.waitForTimeout(400);
  const chip = page.locator(".group.relative img, img[alt='audit.png']").first();
  if (!(await chip.count().catch(() => 0))) issue("attachments: uploaded chip not visible");
  await ta.fill("What is attached?");
  await ta.press("Enter");
  await page.waitForFunction(() => /Ready/.test(document.querySelector("header")?.textContent ?? ""), undefined, { timeout: 30_000 });

  note("11. duplicate-control scan");
  const newChatButtons = await page.getByRole("button", { name: "New chat" }).count();
  note(`New chat controls present: ${newChatButtons} (sidebar + workspace CTA)`);

  note("11b. persistence across reload");
  const conversationTitle = await page.locator("aside button span").first().textContent().catch(() => null);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("textarea").first().waitFor({ timeout: 15_000 });
  const sidebarAfter = await page.locator("aside").textContent().catch(() => "");
  if (conversationTitle && sidebarAfter?.includes(conversationTitle.trim())) {
    note(`conversation "${conversationTitle?.trim()}" persisted across reload`);
  } else {
    issue("persistence: sidebar conversations missing after reload");
  }

  note("12. request fan-out (same-origin counts)");
  const top = [...requests.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  note(`top requests: ${top.map(([u, n]) => `${n}×${u.replace(BASE, "")}`).join(", ")}`);
  for (const [url, count] of requests) {
    if (/api\/engine\/state/.test(url) && count > 60) issue(`excessive polling: ${url} ×${count}`);
  }
}

/* ================= MOBILE AUDIT ================= */
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  attachWatchers(page, "mobile");
  note("mobile: load + drawer + chat + tasks panel");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator("textarea").first().waitFor({ timeout: 15_000 });
  await page.locator('button[aria-label="Open menu"]').click();
  await page.getByText("Conversations").first().waitFor({ timeout: 8_000 }).catch(() => issue("mobile: drawer missing"));
  await page.locator('button[aria-label="Close menu"]').first().click();
  const ta = page.locator("textarea").first();
  await ta.fill("Mobile check");
  await ta.press("Enter");
  await page.waitForFunction(() => /Ready/.test(document.querySelector("header")?.textContent ?? ""), undefined, { timeout: 30_000 });
  const composerVisible = await page.locator("textarea").first().isVisible();
  if (!composerVisible) issue("mobile: composer not visible after reply");
  await page.locator('button[aria-label="Agent tasks"]').click();
  await page.getByText("Agent tasks", { exact: true }).waitFor({ timeout: 5_000 }).catch(() => issue("mobile: tasks panel broken"));
}

await browser.close();
console.log(`\nAUDIT DONE — issues: ${issues.length}`);
for (const i of issues) console.log(" -", i);
import("node:fs").then((fs) => fs.writeFileSync("/tmp/audit-findings.json", JSON.stringify({ issues, notes }, null, 2)));
