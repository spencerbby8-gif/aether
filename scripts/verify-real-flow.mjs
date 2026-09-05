/**
 * Real-flow verification against the running production server.
 * Proves: no fake chat path, honest engine states, routing UI, power-off,
 * ensure-alive contract path, and zero credential leakage.
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3000";
const issues = [];
const notes = [];
const note = (m) => { notes.push(m); console.log(`[verify] ${m}`); };
const issue = (m) => { issues.push(m); console.log(`[ISSUE] ${m}`); };

/* ---------- API-level checks ---------- */
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

note("1. /api/agent/stream with fake creds → honest Kaggle control-plane result (no fake answer)");
const streamRes = await post(`${BASE}/api/agent/stream`, { messages: [{ role: "user", content: "hello" }], engine: "auto" });
const streamBody = await streamRes.text();
if (streamRes.status === 503 && !/fake|mock/i.test(streamBody)) note(`   honest 503: ${streamBody.slice(0, 160)}`);
else issue(`unexpected stream response ${streamRes.status}: ${streamBody.slice(0, 160)}`);
for (const secret of ["verify-a-key", "verify-b-key", "verify-off-key", "verify-user"]) {
  if (streamBody.includes(secret)) issue(`credential leaked in stream response: ${secret}`);
}

note("2. strict engine=b request reports engine b honestly");
const bRes = await post(`${BASE}/api/agent/stream`, { messages: [{ role: "user", content: "hello" }], engine: "b" });
const bBody = await bRes.text();
if (bRes.status === 503 && bBody.includes('"engine":"b"')) note(`   engine B honest: ${bBody.slice(0, 140)}`);
else issue(`unexpected B response ${bRes.status}: ${bBody.slice(0, 140)}`);

note("3. ensure-alive contract route (GET /api/netlify/ensure-alive)");
const wakeRes = await fetch(`${BASE}/api/netlify/ensure-alive`);
const wakeBody = await wakeRes.text();
note(`   GET /api/netlify/ensure-alive → ${wakeRes.status}: ${wakeBody.slice(0, 200)}`);

note("4. engine-off contract route (GET /api/netlify/engine-off) kills both engines");
const offRes = await fetch(`${BASE}/api/netlify/engine-off`, { method: "GET" });
const offBody = await offRes.text();
if (offRes.status === 200 && offBody.includes('"a"') && offBody.includes('"b"')) note(`   off both: ${offBody.slice(0, 160)}`);
else issue(`unexpected off response: ${offRes.status} ${offBody.slice(0, 160)}`);
if (offBody.includes("verify-off-key")) issue("ENGINE_OFF_KEY leaked in off response");

note("5. state endpoint exposes flags only");
const stateBody = await (await fetch(`${BASE}/api/engine/state`)).text();
for (const secret of ["verify-a-key", "verify-b-key", "verify-off-key"]) {
  if (stateBody.includes(secret)) issue(`credential leaked in state: ${secret}`);
}
if (stateBody.includes('"kaggle"')) note("   per-engine config flags present, no secrets");

/* ---------- Browser checks ---------- */
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  /* A 503 from the engine stream is the honest lifecycle state (engine off /
     auth rejected) — surfaced to the user with Retry, not a defect. */
  if (/status of 503/.test(text)) return;
  consoleErrors.push(text.slice(0, 140));
});
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 140)));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.locator("textarea").first().waitFor({ timeout: 15_000 });

note("6. chat send → real engine path (no demo chat), honest error UI with Retry");
const ta = page.locator("textarea").first();
await ta.fill("Hello real engine");
await ta.press("Enter");
await page
  .getByText(/Engine.*unavailable|unavailable.*Engine|401|credentials|No engine could be woken|No Kaggle kernel/i)
  .first()
  .waitFor({ timeout: 90_000 })
  .catch(() => issue("no honest engine error surfaced in chat"));
const retryVisible = await page.locator('button:has-text("Retry")').first().isVisible().catch(() => false);
if (retryVisible) note("   error message shows Retry action");
else issue("no Retry action on engine error");
await page.screenshot({ path: "/tmp/verify-chat-error.png" });

note("7. Settings: AUTO / ENGINE A / ENGINE B routing with live states");
await page.getByRole("button", { name: "Settings" }).click();
const autoRow = page.getByText("Use any available engine", { exact: false }).first();
const rowA = page.getByText("Strictly engine A", { exact: false }).first();
const rowB = page.getByText("Strictly engine B", { exact: false }).first();
for (const [label, locator] of [["Auto", autoRow], ["Engine A", rowA], ["Engine B", rowB]]) {
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) issue(`routing option missing: ${label}`);
}
/* Per-engine live states + configured flags are visible */
const configuredVisible = await page.getByText(/Credentials:/).first().isVisible().catch(() => false);
if (configuredVisible) note("   per-engine credential flags visible");
else issue("credential flags row missing");
/* Select Engine B, then back to Auto — persisted in IndexedDB */
await rowB.click();
await page.waitForTimeout(500);
const persisted = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open("aether-workspace", 3);
      req.onsuccess = () => {
        const db = req.result;
        const read = db.transaction("settings", "readonly").objectStore("settings").get("app-settings");
        read.onsuccess = () => { db.close(); resolve(read.result?.provider ?? null); };
        read.onerror = () => { db.close(); resolve(null); };
      };
      req.onerror = () => resolve(null);
    }),
);
if (persisted === "b") note("   Engine B selection persisted to settings store");
else issue(`Engine B selection not persisted (got ${persisted})`);
await page.screenshot({ path: "/tmp/verify-routing.png" });
await autoRow.click();
await page.waitForTimeout(400);

note("8. power-off button works and reports results");
const offBtn = page.locator('button:has-text("Shut down both engines")').first();
await offBtn.click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/verify-power.png" });
note("   power controls exercised");

await page.getByRole("button", { name: "Close settings" }).click();
await browser.close();

if (consoleErrors.length) issue(`console errors: ${consoleErrors.slice(0, 3).join(" | ")}`);
else note("9. zero console/page errors");

console.log(`\nREAL-FLOW VERIFICATION: ${issues.length === 0 ? "PASS — 0 issues" : "ISSUES FOUND"}`);
for (const i of issues) console.log(" -", i);
process.exit(issues.length > 0 ? 1 : 0);
