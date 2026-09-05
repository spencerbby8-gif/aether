/**
 * Aether Phase 3 — hard-evidence E2E for REAL tools and execution.
 * Runs against the production build in headless Chromium:
 *   P1. agent writes a script, executes it in the sandbox, real stdout surfaces
 *   P2. agent fetches a live web page and reports its content
 *   P3. agent screenshots a page; the artifact image renders in the chat
 * Captures /api/tools/exec calls, screenshots, and IndexedDB task records.
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:3100";
const EVIDENCE = { scenarios: {}, toolCalls: [], consoleErrors: [], pageErrors: [] };

const log = (l) => console.log(`[e2e3] ${l}`);

async function waitReady(page, timeoutMs = 90_000) {
  await page
    .waitForFunction(() => /Ready/.test(document.querySelector("header")?.textContent ?? ""), undefined, {
      timeout: timeoutMs,
    })
    .catch(() => {});
}

async function sendTask(page, goal) {
  const textarea = page.locator("textarea").first();
  await textarea.click();
  await textarea.fill(`/task ${goal}`);
  await textarea.press("Enter");
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "", undefined, { timeout: 3_000 });
}

async function dumpDb(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("aether-workspace", 2);
        request.onsuccess = () => {
          const db = request.result;
          const out = {};
          const stores = ["tasks", "memory", "messages"];
          let pending = stores.length;
          for (const store of stores) {
            const read = db.transaction(store, "readonly").objectStore(store).getAll();
            read.onsuccess = () => {
              out[store] = read.result;
              pending -= 1;
              if (pending === 0) {
                db.close();
                resolve(out);
              }
            };
            read.onerror = () => reject(read.error);
          }
        };
        request.onerror = () => reject(request.error);
      }),
  );
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

page.on("console", (m) => m.type() === "error" && EVIDENCE.consoleErrors.push(m.text()));
page.on("pageerror", (e) => EVIDENCE.pageErrors.push(String(e)));
page.on("request", (r) => {
  if (r.url().includes("/api/tools/exec")) {
    try {
      EVIDENCE.toolCalls.push(JSON.parse(r.postData() ?? "{}").tool);
    } catch {
      EVIDENCE.toolCalls.push("unparsed");
    }
  }
});

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator("textarea").first().waitFor({ timeout: 15_000 });

  /* ================= P1 — real code execution ================= */
  log("P1 — agent writes + executes a Node script in the sandbox");
  await sendTask(page, "Create a Node script that prints the first 10 Fibonacci numbers, run it, and show the output");
  await page.getByText("Task complete.").first().waitFor({ timeout: 90_000 });
  await waitReady(page);

  const db1 = await dumpDb(page);
  const task1 = db1.tasks.find((t) => t.goal.includes("Fibonacci"));
  if (!task1) throw new Error("P1: task not persisted");
  const writeStep = task1.steps.find((s) => s.tool === "fs.write");
  const runStep = task1.steps.find((s) => s.tool === "shell.run");
  const stdoutInChat = await page.getByText("0 1 1 2 3 5 8 13 21 34").first().isVisible().catch(() => false);
  if (!writeStep || writeStep.state !== "done") throw new Error("P1: fs.write step not done");
  if (!runStep || runStep.state !== "done") throw new Error("P1: shell.run step not done");
  if (!/exit=0/.test(runStep.result ?? "")) throw new Error(`P1: unexpected run result: ${runStep.result}`);
  if (!stdoutInChat) throw new Error("P1: real stdout not rendered in the chat");
  await page.screenshot({ path: "/tmp/evidence/P1-real-execution.png" });
  EVIDENCE.scenarios.P1 = {
    result: "PASS",
    steps: task1.steps.map((s) => `${s.tool ?? "answer"}:${s.state}`),
    runResult: runStep.result.slice(0, 160),
    stdoutRenderedInChat: stdoutInChat,
  };
  log(`P1 PASS — steps: ${EVIDENCE.scenarios.P1.steps.join(", ")}`);

  /* ================= P2 — live web fetch ================= */
  log("P2 — agent fetches a live page");
  await page.getByRole("button", { name: "New chat" }).click();
  await waitReady(page, 5_000);
  await sendTask(page, "Fetch https://example.com and summarize what the page says");
  await page.getByText("Task complete.").first().waitFor({ timeout: 60_000 });
  await waitReady(page);
  const db2 = await dumpDb(page);
  const task2 = db2.tasks.find((t) => t.goal.includes("example.com"));
  const fetchStep = task2?.steps.find((s) => s.tool === "web.fetch");
  if (!fetchStep || fetchStep.state !== "done") throw new Error("P2: web.fetch step not done");
  if (!/Example Domain/.test(fetchStep.result ?? "")) throw new Error("P2: fetched content missing");
  await page.screenshot({ path: "/tmp/evidence/P2-web-fetch.png" });
  EVIDENCE.scenarios.P2 = { result: "PASS", fetchResult: fetchStep.result.slice(0, 160) };
  log("P2 PASS — live page fetched and content surfaced");

  /* ================= P3 — screenshot artifact ================= */
  log("P3 — agent screenshots a page; artifact renders in chat");
  await page.getByRole("button", { name: "New chat" }).click();
  await waitReady(page, 5_000);
  await sendTask(page, "Take a screenshot of https://example.com");
  await page.getByText("Task complete.").first().waitFor({ timeout: 120_000 });
  await waitReady(page);
  const artifactImg = page.locator('img[src*="/api/tools/artifact"]').first();
  await artifactImg.waitFor({ timeout: 15_000 });
  const artifactSrc = await artifactImg.getAttribute("src");
  const db3 = await dumpDb(page);
  const task3 = db3.tasks.find((t) => t.goal.includes("screenshot"));
  const shotStep = task3?.steps.find((s) => s.tool === "web.screenshot");
  if (!shotStep || shotStep.state !== "done") throw new Error("P3: web.screenshot step not done");
  if (!(task3.artifacts?.length > 0)) throw new Error("P3: no artifact recorded on the task");
  await page.screenshot({ path: "/tmp/evidence/P3-screenshot-artifact.png" });
  EVIDENCE.scenarios.P3 = { result: "PASS", artifactSrc, taskArtifacts: task3.artifacts };
  log(`P3 PASS — artifact ${artifactSrc} rendered in chat`);

  EVIDENCE.toolCallSummary = EVIDENCE.toolCalls;
  writeFileSync("/tmp/aether-phase3-evidence.json", JSON.stringify(EVIDENCE, null, 2));
  log("ALL PHASE 3 SCENARIOS COMPLETE");
  console.log(JSON.stringify(EVIDENCE.scenarios, null, 2));
  console.log("Tool endpoint calls:", EVIDENCE.toolCalls.join(", "));
  console.log("Console errors:", EVIDENCE.consoleErrors.length, "| Page errors:", EVIDENCE.pageErrors.length);
} catch (error) {
  writeFileSync("/tmp/aether-phase3-evidence.json", JSON.stringify(EVIDENCE, null, 2));
  await page.screenshot({ path: "/tmp/evidence/P-FAILURE.png" }).catch(() => {});
  console.error("PHASE 3 E2E FAILED:", error.message);
  await browser.close();
  process.exit(1);
}

await browser.close();
