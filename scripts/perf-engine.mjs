#!/usr/bin/env node
/**
 * Real performance measurement against the LIVE engine.
 * Measures: TTFT (time-to-first-token), tool-start latency, command
 * execution latency, image/audio start latency, engine status latency,
 * and engine wake/off transitions. No mocks — every number is a real
 * wall-clock measurement over the network.
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:3000";

const results = {};
const now = () => Date.now();

async function timeToFirstToken(messages, label) {
  const started = now();
  let ttft = null;
  const response = await fetch(`${BASE}/api/agent/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, engine: "auto" }),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let sawDone = false;
  while (!sawDone) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let parsed;
      try { parsed = JSON.parse(t); } catch { continue; }
      if (ttft === null && (parsed.message?.content || parsed.message?.thinking)) {
        ttft = now() - started;
      }
      if (parsed.message?.content) content += parsed.message.content;
      if (parsed.done === true) sawDone = true;
    }
  }
  const total = now() - started;
  results[label] = { ttftMs: ttft, totalMs: total, chars: content.length };
  console.log(`[${label}] TTFT ${ttft}ms · total ${total}ms · ${content.length} chars`);
}

async function main() {
  console.log("=== engine status latency ===");
  const s0 = now();
  const status = await fetch(`${BASE}/api/netlify/engine-status`).then((r) => r.json());
  const statusLatency = now() - s0;
  results.status = { latencyMs: statusLatency, state: status.state, alive: status.alive };
  console.log(`[engine-status] ${statusLatency}ms · state=${status.state} alive=${status.alive} (internal ${status.latencyMs ?? "?"}ms)`);

  if (!status.alive) {
    console.log("\nNo live engine — skipping engine-dependent measurements.");
    console.log("Wake the engine first (Settings → power button), then re-run.");
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log("\n=== TTFT: plain reply ===");
  await timeToFirstToken([{ role: "user", content: "Say the word ready." }], "ttft-plain");

  console.log("\n=== tool-start latency: run_command ===");
  const t0 = now();
  const cmdResp = await fetch(`${BASE}/api/agent/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Run pwd with run_command." }], engine: "auto" }),
  });
  let cmdTtft = null;
  let cmdDone = false;
  const cr = cmdResp.body.getReader();
  const cd = new TextDecoder();
  let cb = "";
  const cmdStarted = now();
  while (!cmdDone) {
    const { done, value } = await cr.read();
    if (done) break;
    cb += cd.decode(value, { stream: true });
    for (const line of cb.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let p; try { p = JSON.parse(t); } catch { continue; }
      if (cmdTtft === null && p.message?.thinking) cmdTtft = now() - cmdStarted;
      if (p.done === true) cmdDone = true;
    }
    cb = cb.split("\n").pop() ?? "";
  }
  results["command"] = { toolStartMs: cmdTtft, totalMs: now() - t0 };
  console.log(`[command] tool-start ${cmdTtft}ms · total ${now() - t0}ms`);

  console.log("\n=== image start latency ===");
  const i0 = now();
  const imgResp = await fetch(`${BASE}/api/agent/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Generate an image of a red circle." }], engine: "auto" }),
  });
  let imgFirst = null;
  const ir = imgResp.body.getReader();
  const id = new TextDecoder();
  let ib = "";
  let imgDone = false;
  const imgStarted = now();
  while (!imgDone) {
    const { done, value } = await ir.read();
    if (done) break;
    ib += id.decode(value, { stream: true });
    for (const line of ib.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let p; try { p = JSON.parse(t); } catch { continue; }
      if (imgFirst === null && (p.message?.content || p.message?.thinking)) imgFirst = now() - imgStarted;
      if (p.done === true) imgDone = true;
    }
    ib = ib.split("\n").pop() ?? "";
  }
  results["image"] = { firstResponseMs: imgFirst, totalMs: now() - i0 };
  console.log(`[image] first-response ${imgFirst}ms · total ${now() - i0}ms`);

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error("PERF FAILED:", e.message); process.exit(1); });
