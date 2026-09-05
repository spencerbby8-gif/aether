/**
 * Brings the proof stack up and leaves it running: beacon + engine sims +
 * root port-80 forwarders + a real `next start`. Writes endpoints to
 * /tmp/proof-env.json. Used for interactive probing while debugging the proofs.
 */
import { startEngineSim, signBeacon, SIM_OFF_KEY } from "/home/user/aether/tests/support/engine-sim";
import http from "node:http";
import fs from "node:fs";

const BEACON_SECRET = "proof-beacon-secret-fixed";
const CONTROL_TOKEN = "proof-control-token-fixed";
let announcements: string[] = [];

const beacon = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname.endsWith("/requests")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: announcements.map((m, i) => ({ query: { m }, created_at: new Date(Date.now() - i * 1000).toISOString() })) }));
    return;
  }
  /* Admin endpoint the probes use to change what the beacon announces. */
  if (u.pathname === "/__set") {
    announcements = JSON.parse(u.searchParams.get("m") ?? "[]");
    res.writeHead(200);
    res.end("ok");
    return;
  }
  res.writeHead(200);
  res.end("{}");
});
await new Promise((r) => beacon.listen(3200, "127.0.0.1", r));

const simA = await startEngineSim({ slot: "a", thinkSeconds: 60, contentSeconds: 4, keepAliveMs: 500 });
const simB = await startEngineSim({ slot: "b", thinkSeconds: 0, contentSeconds: 2 });

function signed(slot, url) {
  const p = `engine=${slot} AGENT LIVE LINK: ${url} (tools: web_search fetch_page crawl_site run_command)`;
  return `${p} sig=${signBeacon(p, BEACON_SECRET)}`;
}
announcements = [signed("a", "http://alpha.trycloudflare.com"), signed("b", "http://beta.trycloudflare.com")];

/* Root port-80 forwarders, so the portless tunnel URLs actually resolve. */
import { spawn } from "node:child_process";
for (const [ip, sim] of [["127.0.0.2", simA], ["127.0.0.3", simB]]) {
  const f = spawn("sudo", ["-n", "node", "scripts/proofs/forwarder.mjs", ip, "80", String(sim.port)], {
    cwd: "/home/user/aether",
    stdio: ["ignore", "pipe", "pipe"],
  });
  f.stdout.on("data", (d) => process.stdout.write(`[fwd] ${d}`));
  f.stderr.on("data", (d) => process.stdout.write(`[fwd!] ${d}`));
}

/* Expose the sims so the forwarders can find them, then report state. */
const state = { simA: simA.url, simB: simB.url, BEACON_SECRET, CONTROL_TOKEN, OFF_KEY: SIM_OFF_KEY };
fs.writeFileSync("/tmp/proof-env.json", JSON.stringify(state, null, 2));
console.log("STACK UP", JSON.stringify(state));
console.log("beacon announce endpoint: http://127.0.0.1:3200/__set?m=<json array>");
globalThis.__sims = { simA, simB };
setInterval(() => {
  /* Live counters so probes can read them. */
  fs.writeFileSync("/tmp/proof-sims.json", JSON.stringify({
    a: { requests: simA.requests, offCount: simA.offCount, abortedChats: simA.abortedChats, chatCount: simA.chatCount, healthy: simA.healthy },
    b: { requests: simB.requests, offCount: simB.offCount, abortedChats: simB.abortedChats, chatCount: simB.chatCount, healthy: simB.healthy },
  }, null, 2));
}, 500);
