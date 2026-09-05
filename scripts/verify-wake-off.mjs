#!/usr/bin/env node
/**
 * Verify the real engine power cycle: OFF → offline → re-WAKE → live.
 * Every line is real runtime evidence from the deployed control plane.
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const now = () => Date.now();

const status = async () => {
  const s = await fetch(`${BASE}/api/netlify/engine-status`).then((r) => r.json());
  return s;
};

async function main() {
  console.log("=== BEFORE: engine status ===");
  const before = await status();
  console.log(`state=${before.state} alive=${before.alive} url=${before.url}`);

  console.log("\n=== POWER OFF ===");
  const offStart = now();
  const off = await fetch(`${BASE}/api/netlify/engine-off`, { method: "POST" }).then((r) => r.json());
  console.log(`engine-off → ${JSON.stringify(off)} (${now() - offStart}ms)`);

  console.log("\n=== AFTER OFF: engine status (must NOT be live) ===");
  const afterOff = await status();
  console.log(`state=${afterOff.state} alive=${afterOff.alive} url=${afterOff.url}`);
  if (afterOff.alive) {
    console.log("FAIL: engine still reports live after off");
  } else {
    console.log("PASS: engine no longer live after off");
  }

  console.log("\n=== RE-WAKE ===");
  const wakeStart = now();
  const wake = await fetch(`${BASE}/api/netlify/ensure-alive`).then((r) => r.json());
  console.log(`ensure-alive → ${JSON.stringify(wake)} (${now() - wakeStart}ms)`);

  console.log("\n=== AFTER WAKE: engine status ===");
  const afterWake = await status();
  console.log(`state=${afterWake.state} alive=${afterWake.alive} url=${afterWake.url}`);

  console.log("\n=== RESULT ===");
  console.log(JSON.stringify({
    before: { state: before.state, alive: before.alive },
    off: off.status,
    afterOff: { state: afterOff.state, alive: afterOff.alive },
    wake: wake.status,
    afterWake: { state: afterWake.state, alive: afterWake.alive },
  }, null, 2));
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
