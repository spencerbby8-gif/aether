/**
 * Aether Phase 5 — hard-evidence run against the REAL systems.
 * Inspects actual HTTP responses, beacon data, engine lifecycle states,
 * NDJSON stream attempts, idle configuration, and the client bundle.
 */
import { execSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:3100";
const evidence = { checks: {} };
const record = (name, data) => {
  evidence.checks[name] = data;
  console.log(`\n=== ${name} ===`);
  console.log(typeof data === "string" ? data : JSON.stringify(data, null, 1).slice(0, 1500));
};

const get = async (url, opts = {}) => {
  const started = Date.now();
  try {
    const response = await fetch(url, opts);
    const text = await response.text();
    return { status: response.status, ms: Date.now() - started, text: text.slice(0, 900) };
  } catch (error) {
    return { status: "error", ms: Date.now() - started, text: String(error?.message ?? error) };
  }
};

/* ---------- 1. WAKE_URL contract path ---------- */
record("WAKE_URL /.netlify/functions/ensure-alive (GET)", await get(`${BASE}/.netlify/functions/ensure-alive`));

/* ---------- 2. Engine state (beacon-driven) ---------- */
record("GET /api/engine/state", await get(`${BASE}/api/engine/state`));

/* ---------- 3. OFF_URL contract path ---------- */
record("OFF_URL GET refused", await get(`${BASE}/.netlify/functions/engine-off`));
record(
  "OFF_URL POST both engines",
  await get(`${BASE}/.netlify/functions/engine-off`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "both" }),
  }),
);

/* ---------- 4. Real NDJSON chat attempt ---------- */
record(
  "POST /api/agent/stream (real chat attempt)",
  await get(`${BASE}/api/agent/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Say hello from the real engine." }], tools: true }),
  }),
);

/* ---------- 5. Real tool execution attempt ---------- */
record(
  "POST /api/engine/tools web_search",
  await get(`${BASE}/api/engine/tools`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "web_search", args: { query: "aether engine test" } }),
  }),
);
record("GET /api/engine/tools (six tool schemas)", await get(`${BASE}/api/engine/tools`));

/* ---------- 6. Wake after shutdown ---------- */
record("POST /api/engine/wake (wake after shutdown)", await get(`${BASE}/api/engine/wake`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ engine: "a" }),
}));
record("state after wake attempt (lifecycle log)", await get(`${BASE}/api/engine/state`));

/* ---------- 7. Rotating-URL /api/ps health check on the last beacon URL ---------- */
const stateBody = await (await fetch(`${BASE}/api/engine/state`)).json().catch(() => null);
const lastUrl = stateBody?.events?.map((e) => e.text).join(" | ") ?? "";
const tunnelMatch = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/.exec(lastUrl);
if (tunnelMatch) {
  record("GET /api/ps on rotating tunnel URL", await get(`${tunnelMatch[1]}/api/ps`));
} else {
  record("GET /api/ps on rotating tunnel URL", "No tunnel URL found in lifecycle log (engines off).");
}

/* ---------- 8. Idle interval: controlled short instance vs production ---------- */
record("production idleLimitMinutes (must be 20)", {
  value: stateBody?.idleLimitMinutes,
  ok: stateBody?.idleLimitMinutes === 20,
});

const shortServer = spawn("npx", ["next", "start", "-p", "3101"], {
  env: { ...process.env, ENGINE_IDLE_MINUTES: "0.02" },
  stdio: "ignore",
  detached: false,
});
await new Promise((r) => setTimeout(r, 4000));
const shortState = await get("http://127.0.0.1:3101/api/engine/state");
record("controlled short-interval server (ENGINE_IDLE_MINUTES=0.02)", shortState);
shortServer.kill("SIGTERM");

/* ---------- 9. Client bundle secret scan ---------- */
const scanRoot = ".next/static";
const findings = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) {
      const content = readFileSync(full, "utf-8");
      /*
       * Patterns, never the literal leaked values (audit C3). The previous list
       * embedded the real webhook.site token and ntfy topic, which re-published
       * the very secrets the scan exists to catch.
       */
      for (const re of [
        /KAGGLE_KEY/,
        /KAGGLE_USERNAME/,
        /kaggle\.com\/api/,
        /ENGINE_KERNEL_/,
        /webhook\.site\/(?:token\/)?[0-9a-f-]{36}/,
        /ntfy\.sh\/[A-Za-z0-9_-]{4,}/,
        /nxoff-[A-Za-z0-9]{8,}/,
        /Basic /,
      ]) {
        if (re.test(content)) findings.push({ file: full, pattern: String(re) });
      }
    }
  }
};
walk(scanRoot);
record("client-bundle secret scan (.next/static)", { scanned: scanRoot, findings, clean: findings.length === 0 });

/* server-side chunks may legitimately reference model/wake paths — verify they stay server-side */
const serverScan = execSync('grep -rl "KAGGLE_KEY" .next/server 2>/dev/null | head -5 || true').toString().trim();
record("KAGGLE_KEY referenced only server-side (build output)", serverScan || "not present in build output (read from process.env at runtime)");

writeFileSync("/tmp/aether-phase5-evidence.json", JSON.stringify(evidence, null, 2));
console.log("\nEVIDENCE WRITTEN to /tmp/aether-phase5-evidence.json");
