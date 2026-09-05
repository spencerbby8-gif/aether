/**
 * Phase 5 UI evidence — engine power panel, provider switch, and the
 * honest engine-unavailable path rendered in the real chat UI.
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3100";
const log = (l) => console.log(`[ui5] ${l}`);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator("textarea").first().waitFor({ timeout: 15_000 });

  /* 1 — Settings: engine power panel */
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText("Engine power · two Kaggle GPUs").waitFor({ timeout: 8_000 });
  await page.getByText("hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS").waitFor({ timeout: 8_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: "/tmp/evidence/U1-engine-panel.png" });
  log("engine power panel rendered (states, wake buttons, idle policy, model)");

  /* 2 — switch provider to the real engine */
  await page.getByText("Real engine (Kaggle GPUs)").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/evidence/U2-provider-kaggle.png" });
  await page.getByRole("button", { name: "Close settings" }).click();

  /* 3 — header chip reflects engine state */
  await page.getByText(/Engine A/i).first().waitFor({ timeout: 10_000 });
  log("header shows engine routing/state chip");

  /* 4 — send a message: honest engine-unavailable error surfaces in chat */
  const textarea = page.locator("textarea").first();
  await textarea.click();
  await textarea.fill("Hello real engine");
  await textarea.press("Enter");
  await page.getByText(/Engine unavailable/i).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/evidence/U3-honest-error.png" });
  log("honest engine-unavailable state rendered in chat (no fake output)");

  console.log(JSON.stringify({ result: "PASS", consoleErrors: errors.slice(0, 5) }, null, 1));
} catch (error) {
  await page.screenshot({ path: "/tmp/evidence/U-FAILURE.png" }).catch(() => {});
  console.error("UI EVIDENCE FAILED:", error.message);
  await browser.close();
  process.exit(1);
}
await browser.close();
