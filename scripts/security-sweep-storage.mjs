/** Dump browser-side storage and scan for credential patterns. */
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto("http://127.0.0.1:3000", { waitUntil: "networkidle" });
await page.locator("textarea").first().waitFor({ timeout: 15_000 });
/* Exercise the app a little so stores are populated. */
const ta = page.locator("textarea").first();
await ta.fill("security sweep probe");
await ta.press("Enter");
await page.waitForFunction(() => /Ready/.test(document.querySelector("header")?.textContent ?? ""), undefined, { timeout: 30_000 });
await page.waitForTimeout(500);

const dump = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const out = { stores: {}, localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } };
      const request = indexedDB.open("aether-workspace", 3);
      request.onsuccess = () => {
        const db = request.result;
        const names = Array.from(db.objectStoreNames);
        let pending = names.length;
        if (pending === 0) { db.close(); resolve(out); return; }
        for (const name of names) {
          const read = db.transaction(name, "readonly").objectStore(name).getAll();
          read.onsuccess = () => {
            out.stores[name] = (read.result ?? []).map((r) => {
              const clone = { ...r };
              if (clone.blob) clone.blob = `<Blob ${clone.blob.size}B ${clone.blob.type}>`;
              return clone;
            });
            pending -= 1;
            if (pending === 0) { db.close(); resolve(out); }
          };
          read.onerror = () => { pending -= 1; if (pending === 0) { db.close(); resolve(out); } };
        }
      };
      request.onerror = () => resolve(out);
    }),
);
await browser.close();

const serialized = JSON.stringify(dump);
const patterns = [
  /KAGGLE_KEY/i,
  /KAGGLE_USERNAME/i,
  /ENGINE_KERNEL_[AB]/i,
  /kaggle\.com\/api/i,
  /Basic [A-Za-z0-9+/=]{20,}/i,
  /ENGINE_OFF_KEY/i,
  /test-a-123|test-b-456|off-key-789|verify-a-key|verify-b-key|verify-off-key/i, // fake values injected for this proof
];
const findings = patterns.filter((p) => p.test(serialized));
console.log("IndexedDB stores:", Object.keys(dump.stores).join(", "));
console.log("localStorage keys:", Object.keys(dump.localStorage).join(", ") || "(empty)");
console.log("sessionStorage keys:", Object.keys(dump.sessionStorage).join(", ") || "(empty)");
console.log("credential patterns found:", findings.length === 0 ? "NONE — browser storage is clean" : findings.map(String).join(", "));
if (findings.length > 0) process.exit(1);
