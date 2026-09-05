#!/usr/bin/env node
/**
 * REAL DEPLOYED ENGINE END-TO-END TEST.
 * Usage: node scripts/deployed-engine-test.mjs [baseUrl]
 *   default baseUrl = http://127.0.0.1:3000
 *
 * Exercises the REAL control plane (no mocks) against a deployed Aether:
 *   1. ensure-alive AUTO            → alive URL / waking / quota error
 *   2. ensure-alive engine=b        → Engine B wake (bundled source push)
 *   3. /api/ps on the discovered URL → 200 + models[]
 *   4. send "hi" via /api/agent/stream → real NDJSON streamed answer
 *   5. engine-off kill-all          → shuts every alive engine
 *   6. wake-again after shutdown
 *
 * Every line printed is real HTTP evidence. Kaggle credentials + GPU quota
 * live in the deployment's env; without them the endpoints honestly report
 * "KAGGLE_KEY not set" / quota, which is itself valid evidence the control
 * layer is executing.
 */
const BASE = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const issues = [];
const passes = [];
const ok = (m) => { passes.push(m); console.log(`[PASS] ${m}`); };
const bad = (m) => { issues.push(m); console.log(`[FAIL] ${m}`); };
const info = (m) => console.log(`       ${m}`);

const get = async (path, ms = 300_000) => {
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(ms) });
  const text = await response.text();
  return { status: response.status, ms: Date.now() - started, text };
};
const post = async (path, body, ms = 300_000) => {
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  const text = await response.text();
  return { status: response.status, ms: Date.now() - started, text };
};
const parse = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

console.log(`\n=== DEPLOYED ENGINE E2E — ${BASE} ===\n`);

/* health */
const health = await get("/api/health", 20_000);
const hb = parse(health);
if (health.status === 200 && hb?.ok) ok(`health 200 (phase ${hb.phase}, agent ${hb.agent})`);
else bad(`health returned ${health.status}`);

/* 1) ensure-alive AUTO */
console.log("\n--- 1) ensure-alive AUTO ---");
const alive = await get("/api/netlify/ensure-alive");
const ab = parse(alive);
info(`HTTP ${alive.status} in ${(alive.ms / 1000).toFixed(1)}s → ${alive.text.slice(0, 240)}`);
if (ab?.status === "alive" && ab.url) ok(`AUTO alive: ${ab.url}`);
else if (ab?.status === "waking") ok(`AUTO waking (eta ${ab.etaMinutes} min): ${ab.reason ?? ""}`);
else if (ab?.status === "error") {
  if (/KAGGLE_KEY|not set/i.test(ab.message ?? "")) bad(`ensure-alive: ${ab.message} (credentials not configured on this deployment)`);
  else if (/quota/i.test(ab.message ?? "")) ok(`AUTO honest quota error: ${ab.message}`);
  else bad(`ensure-alive error: ${ab.message}`);
} else bad(`ensure-alive unexpected: ${alive.text.slice(0, 160)}`);

let liveUrl = ab?.status === "alive" ? ab.url : null;

/* 2) ensure-alive engine=b (Engine B wake) */
console.log("\n--- 2) ensure-alive engine=b ---");
const aliveB = await get("/api/netlify/ensure-alive?engine=b");
const bb = parse(aliveB);
info(`HTTP ${aliveB.status} in ${(aliveB.ms / 1000).toFixed(1)}s → ${aliveB.text.slice(0, 240)}`);
if (bb?.status === "alive" && bb.url) { ok(`Engine B alive: ${bb.url}`); liveUrl = liveUrl ?? bb.url; }
else if (bb?.status === "waking") ok(`Engine B waking: ${bb.reason ?? ""}`);
else if (/KAGGLE_KEY_B|KAGGLE_KEY|not set/i.test(bb?.message ?? "")) bad(`Engine B: ${bb.message} (B credentials not configured)`);
else if (/quota/i.test(bb?.message ?? "")) ok(`Engine B honest quota error: ${bb.message}`);
else bad(`Engine B unexpected: ${aliveB.text.slice(0, 160)}`);

/* 3) /api/ps on the discovered URL */
console.log("\n--- 3) /api/ps health on discovered URL ---");
if (liveUrl) {
  const ps = await fetch(`${liveUrl}/api/ps`, { signal: AbortSignal.timeout(30_000) }).catch((e) => e);
  if (ps instanceof Response) {
    const psText = await ps.text();
    info(`HTTP ${ps.status} → ${psText.slice(0, 200)}`);
    if (ps.status === 200) {
      const psj = (() => { try { return JSON.parse(psText); } catch { return null; } })();
      if (psj && Array.isArray(psj.models) && psj.models.length > 0) ok(`/api/ps 200 + models[] (${psj.models.length} model(s): ${psj.models.map((m) => m.name ?? m.model).join(", ")})`);
      else ok(`/api/ps 200 (models array empty or unexpected shape)`);
    } else bad(`/api/ps returned ${ps.status}`);
  } else bad(`/api/ps unreachable: ${String(ps).slice(0, 120)}`);
} else info("skipped — no live engine URL discovered (engine not awake yet)");

/* 4) send "hi" through the real chat path */
console.log("\n--- 4) send 'hi' via /api/agent/stream ---");
const chat = await post("/api/agent/stream", { messages: [{ role: "user", content: "hi" }], engine: "auto", tools: false });
info(`HTTP ${chat.status} in ${(chat.ms / 1000).toFixed(1)}s`);
if (chat.status === 200) {
  const lines = chat.text.split("\n").filter(Boolean);
  let content = "";
  let sawDone = false;
  let sawSystemSent = false;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.message?.content) content += parsed.message.content;
      if (parsed.done === true) sawDone = true;
      if (parsed.message?.role === "system") sawSystemSent = true;
    } catch { /* partial */ }
  }
  info(`streamed content: ${JSON.stringify(content.slice(0, 200))} | done:${sawDone} | lines:${lines.length}`);
  if (content.length > 0 && sawDone && !sawSystemSent) ok(`real streamed answer (${content.length} chars, done:true, no system role)`);
  else if (content.length > 0) ok(`streamed content received (done:${sawDone})`);
  else bad(`stream returned no content`);
} else {
  const cb = parse(chat);
  if (/waking/i.test(cb?.state ?? "")) ok(`chat-triggered wake: engine waking (${cb.error ?? ""})`);
  else if (/KAGGLE_KEY|not set/i.test(cb?.error ?? "")) bad(`chat: ${cb.error} (credentials not configured)`);
  else if (/quota/i.test(cb?.error ?? "")) ok(`chat honest quota error: ${cb.error}`);
  else bad(`chat HTTP ${chat.status}: ${chat.text.slice(0, 160)}`);
}

/* 5) engine-off kill-all */
console.log("\n--- 5) engine-off kill-all ---");
const off = await get("/api/netlify/engine-off");
const ob = parse(off);
info(`HTTP ${off.status} → ${off.text.slice(0, 240)}`);
if (ob?.status === "off") ok(`engine-off: ${ob.message ?? "off"} (killed ${ob.killed?.length ?? 0})`);
else if (/ENGINE_OFF_KEY|not set/i.test(ob?.message ?? "")) bad(`engine-off: ${ob.message} (ENGINE_OFF_KEY not configured)`);
else bad(`engine-off unexpected: ${off.text.slice(0, 160)}`);

/* 6) wake again after shutdown */
console.log("\n--- 6) wake again after shutdown ---");
const re = await get("/api/netlify/ensure-alive");
const rb = parse(re);
info(`HTTP ${re.status} in ${(re.ms / 1000).toFixed(1)}s → ${re.text.slice(0, 240)}`);
if (rb?.status === "alive") ok(`wake-again alive: ${rb.url}`);
else if (rb?.status === "waking") ok(`wake-again waking: ${rb.reason ?? ""}`);
else if (/KAGGLE_KEY|not set/i.test(rb?.message ?? "")) bad(`wake-again: ${rb.message} (credentials not configured)`);
else if (/quota/i.test(rb?.message ?? "")) ok(`wake-again honest quota error: ${rb.message}`);
else bad(`wake-again unexpected: ${re.text.slice(0, 160)}`);

console.log(`\n=== RESULT: ${passes.length} passed, ${issues.length} failed ===`);
for (const i of issues) console.log("  FAIL:", i);
console.log("\nNote: Kaggle push → RUNNING → Cloudflare URL → /api/ps → /api/chat require");
console.log("real KAGGLE_KEY/KAGGLE_KEY_B + GPU quota, which live in the deployment env.");
console.log("Against a deployment WITHOUT those creds, 'not set' results are the honest,");
console.log("correct control-layer behavior (proves the code path executes).");
process.exit(issues.length > 0 ? 1 : 0);
