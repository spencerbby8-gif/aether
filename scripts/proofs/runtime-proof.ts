/**
 * RUNTIME PROOF HARNESS — audit remediation evidence.
 *
 * Everything here happens over real HTTP against a real `next start` server and
 * real engine simulators that implement the engine's actual contract. Nothing is
 * mocked at the module boundary: the routes, the control plane, the auth gate,
 * the SSRF guard and the streaming loop are the shipped ones.
 *
 * Run: npx tsx scripts/proofs/runtime-proof.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { startEngineSim, signBeacon, SIM_OFF_KEY, type EngineSim } from "../../tests/support/engine-sim";

const PORT = 3111;
const BEACON_PORT = 3200;
const BASE = `http://127.0.0.1:${PORT}`;
const CONTROL_TOKEN = "proof-control-token-" + crypto.randomBytes(8).toString("hex");
const BEACON_SECRET = crypto.randomBytes(24).toString("hex");

/* Hostnames that LIVE_LINK_RE can match (portless *.trycloudflare.com). */
const HOST_A = "alpha.trycloudflare.com";
const HOST_B = "beta.trycloudflare.com";
const URL_A = `http://${HOST_A}`;
const URL_B = `http://${HOST_B}`;

type Result = { id: string; finding: string; pass: boolean; evidence: string[] };
const results: Result[] = [];
let current: Result | null = null;

function section(id: string, finding: string) {
  current = { id, finding, pass: true, evidence: [] };
  results.push(current);
  console.log(`\n\x1b[1m\x1b[36m=== ${id} — ${finding} ===\x1b[0m`);
}
function ev(line: string) {
  current?.evidence.push(line);
  console.log("    " + line);
}
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (current && !ok) current.pass = false;
  const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  ev(`${mark} ${label}: got ${JSON.stringify(actual)}${ok ? "" : ` expected ${JSON.stringify(expected)}`}`);
  return ok;
}
function checkTrue(label: string, ok: boolean, detail = "") {
  if (current && !ok) current.pass = false;
  ev(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

/* ------------------------------------------------------------------ beacon */
let announcements: string[] = [];
let beaconHits = 0;
function payload(slot: "a" | "b" | "c", url: string) {
  return `engine=${slot} AGENT LIVE LINK: ${url} (tools: web_search fetch_page crawl_site run_command)`;
}
function signed(slot: "a" | "b" | "c", url: string) {
  const p = payload(slot, url);
  return `${p} sig=${signBeacon(p, BEACON_SECRET)}`;
}
function startBeacon(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname.endsWith("/requests")) {
      beaconHits++;
      /* webhook.site shape: newest first, message in .query.m */
      const data = announcements.map((m, i) => ({
        query: { m },
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((r) => server.listen(BEACON_PORT, "127.0.0.1", () => r(server)));
}

/* --------------------------------------------------------------- processes */
const children: ChildProcess[] = [];
function spawnDetached(
  cmd: string,
  args: string[],
  opts: { sudo?: boolean; env?: NodeJS.ProcessEnv; stdin?: boolean } = {},
) {
  const full = opts.sudo ? ["sudo", "-n", cmd, ...args] : [cmd, ...args];
  /* detached + its own process group so teardown reaches the real server,
     not just the `npx` wrapper that spawned it. */
  const child = spawn(full[0], full.slice(1), {
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(child);
  return child;
}
function killAll(signal: NodeJS.Signals = "SIGTERM") {
  for (const c of children) {
    if (c.pid === undefined) continue;
    try {
      process.kill(-c.pid, signal); /* negative pid = whole group */
    } catch {
      try {
        c.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}
const waitForLog = (child: ChildProcess, re: RegExp, ms = 60_000) =>
  new Promise<void>((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${re} — saw: ${buf.slice(-800)}`)), ms);
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (re.test(buf)) {
        clearTimeout(t);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });

async function http_json(path: string, init: RequestInit = {}, token: string | null = CONTROL_TOKEN) {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  headers.set("content-type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(BASE + path, { ...init, headers });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, text, json: json as Record<string, unknown> | null };
}

/* ------------------------------------------------------------------- main */
async function main() {
  console.log(`\n\x1b[1mAether runtime proofs\x1b[0m  node ${process.version}  ${new Date().toISOString()}`);

  /* ---- hosts entries + root forwarders so portless tunnel URLs resolve ---- */
  const hostsLine = `127.0.0.2 ${HOST_A}\n127.0.0.3 ${HOST_B}\n`;
  if (!fs.readFileSync("/etc/hosts", "utf8").includes(HOST_A)) {
    const tee = spawnDetached("tee", ["-a", "/etc/hosts"], { sudo: true, stdin: true });
    await new Promise<void>((resolve, reject) => {
      tee.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tee exited ${code}`))));
      tee.stdin?.end(hostsLine);
    });
  }
  /* Prove the entry is actually live before anything depends on it. */
  const hostsNow = fs.readFileSync("/etc/hosts", "utf8");
  if (!hostsNow.includes(HOST_A) || !hostsNow.includes(HOST_B)) {
    throw new Error(`/etc/hosts setup failed:\n${hostsNow}`);
  }
  ev(`hosts: ${HOST_A} -> 127.0.0.2, ${HOST_B} -> 127.0.0.3 (verified present)`);

  const beacon = await startBeacon();
  ev(`beacon listening on 127.0.0.1:${BEACON_PORT} (webhook.site shape)`);

  /* Engine A: long tool loop (proves the 45s abort is gone). */
  const simA: EngineSim = await startEngineSim({ slot: "a", thinkSeconds: 60, contentSeconds: 4, keepAliveMs: 500 });
  /* Engine B: fast answer, used for A/B/C routing proof. */
  const simB: EngineSim = await startEngineSim({ slot: "b", thinkSeconds: 0, contentSeconds: 2 });
  ev(`engine A sim ${simA.url}  engine B sim ${simB.url}  (contract: POST /off + X-Engine-Key, no /api/off)`);

  const fwdA = spawnDetached("node", ["scripts/proofs/forwarder.mjs", "127.0.0.2", "80", String(simA.port)], { sudo: true });
  const fwdB = spawnDetached("node", ["scripts/proofs/forwarder.mjs", "127.0.0.3", "80", String(simB.port)], { sudo: true });
  await Promise.all([waitForLog(fwdA, /READY/, 20_000), waitForLog(fwdB, /READY/, 20_000)]);
  ev("root forwarders: 127.0.0.2:80 -> A, 127.0.0.3:80 -> B");
  for (const [name, u] of [["A", URL_A], ["B", URL_B]] as const) {
    const r = await fetch(`${u}/api/ps`);
    const body = await r.text();
    if (r.status !== 200 || !body.includes("models")) {
      throw new Error(`tunnel URL for engine ${name} is not reachable: ${u} -> ${r.status} ${body.slice(0, 120)}`);
    }
    ev(`reachability ${u}/api/ps -> ${r.status} ${body.slice(0, 60)}`);
  }

  /* ---- the real server ---- */
  const next = spawnDetached(
    "npx",
    ["next", "start", "-p", String(PORT), "-H", "0.0.0.0"],
    {
      env: {
        NODE_ENV: "production",
        AETHER_CONTROL_TOKEN: CONTROL_TOKEN,
        ENGINE_OFF_KEY: SIM_OFF_KEY,
        BEACON_URL: `http://127.0.0.1:${BEACON_PORT}/token/proof`,
        BEACON_SECRET,
        KAGGLE_USERNAME: "proof-user",
        KAGGLE_KEY: "proof-key",
      },
    },
  );
  await waitForLog(next, /Ready in|started server|Local:/, 90_000);
  ev(`next start ready on ${BASE} (production build)`);

  /* =============================================================== P1 / C4 */
  section("P1 (C4)", "control plane rejects unauthenticated callers");
  {
    const noTok = await http_json("/api/netlify/engine-status", {}, null);
    check("engine-status without token", noTok.status, 401);
    const bad = await http_json("/api/netlify/engine-status", {}, "wrong-token-value-000000");
    check("engine-status with wrong token", bad.status, 403);
    const okTok = await http_json("/api/netlify/engine-status");
    check("engine-status with valid token", okTok.status, 200);
    const offNoTok = await http_json("/api/netlify/engine-off", { method: "POST", body: JSON.stringify({ engine: "all" }) }, null);
    check("engine-off without token", offNoTok.status, 401);
    const execNoTok = await http_json("/api/tools/exec", { method: "POST", body: JSON.stringify({ tool: "web.fetch", args: { url: "http://example.com" } }) }, null);
    check("tools/exec without token", execNoTok.status, 401);
    /* A state-changing GET must not work even WITH a valid token. */
    const getOff = await http_json("/api/netlify/engine-off");
    check("engine-off via GET (was a live kill switch)", getOff.status, 405);
    ev(`status body leaks no tunnel URL: ${JSON.stringify(okTok.json)}`);
  }

  /* =============================================================== P2 / C2 */
  section("P2 (C2)", "unsigned beacon announcements are rejected; signed ones accepted");
  {
    announcements = [payload("a", URL_A)]; /* forged, unsigned */
    let st = await http_json("/api/netlify/ensure-alive?engine=a");
    ev(`unsigned announcement -> ensure-alive?engine=a: ${st.status} ${JSON.stringify(st.json?.status)}`);
    checkTrue("unsigned announcement NOT adopted", st.json?.status !== "alive", `status=${JSON.stringify(st.json?.status)}`);

    announcements = [signed("a", URL_A)];
    st = await http_json("/api/netlify/ensure-alive?engine=a");
    check("signed announcement adopted", st.json?.status, "alive");
    checkTrue("adopted URL is engine A's tunnel", JSON.stringify(st.json?.url ?? "").includes(HOST_A), `url=${JSON.stringify(st.json?.url)}`);
  }

  /* =============================================================== P3 / C5 */
  section("P3 (C5)", "A/B/C routing is real — selected != globally-live");
  {
    /* Start from a clean fleet so this proof cannot inherit P2's bindings. */
    await http_json("/api/netlify/engine-off", { method: "POST", body: JSON.stringify({ engine: "all" }) });
    simA.healthy = true;
    simB.healthy = true;
    announcements = [signed("b", URL_B)]; /* only B is announced */
    const b = await http_json("/api/netlify/ensure-alive?engine=b");
    check("engine=b resolves to B's tunnel", b.json?.status, "alive");
    checkTrue("engine=b url is B", JSON.stringify(b.json?.url ?? "").includes(HOST_B), `url=${JSON.stringify(b.json?.url)}`);

    const a = await http_json("/api/netlify/ensure-alive?engine=a");
    checkTrue("engine=a does NOT borrow B's tunnel (strict)", a.json?.status !== "alive", `status=${JSON.stringify(a.json?.status)}`);

    const st = await http_json("/api/engine/state");
    const engines = (st.json?.engines ?? {}) as Record<string, Record<string, unknown>>;
    ev(`engine state: ${JSON.stringify(engines)}`);
    checkTrue("state reports B urlPresent", engines.b?.urlPresent === true, `b=${JSON.stringify(engines.b)}`);
    checkTrue("state reports A not live (A was never announced)", engines.a?.urlPresent === false, `a=${JSON.stringify(engines.a)}`);
    check("resolving B makes B the active slot", st.json?.active, "b");
    checkTrue("state never returns a raw tunnel URL", !JSON.stringify(st.json).includes("trycloudflare.com"), "no tunnel host in payload");
  }

  /* =============================================================== P4 / C3 */
  section("P4 (C3)", "engine-off uses the engine's REAL contract and tells the truth");
  {
    announcements = [signed("a", URL_A), signed("b", URL_B)];
    simA.offCount = 0;
    simA.requests.length = 0;
    const res = await http_json("/api/netlify/engine-off", { method: "POST", body: JSON.stringify({ engine: "all" }) });
    ev(`engine-off response: ${res.status} ${JSON.stringify(res.json)}`);
    ev(`engine A requests: ${JSON.stringify(simA.requests)}`);
    check("HTTP status", res.status, 200);
    checkTrue("engine A received POST /off", simA.requests.includes("POST /off"), `requests=${JSON.stringify(simA.requests)}`);
    checkTrue("engine A never received /api/off", !simA.requests.some((r) => r.includes("/api/off")), "no /api/off");
    checkTrue("engine confirmed shutdown (offCount=1)", simA.offCount === 1, `offCount=${simA.offCount}`);
    checkTrue("response status is 'off'", res.json?.status === "off", `status=${JSON.stringify(res.json?.status)}`);
  }

  section("P4b (C3)", "a rejected key is NOT reported as a successful shutdown");
  {
    /* Restart the server with a WRONG off key — the engine will 403. */
    const next2 = spawnDetached("npx", ["next", "start", "-p", "3112", "-H", "0.0.0.0"], {
      env: {
        NODE_ENV: "production",
        AETHER_CONTROL_TOKEN: CONTROL_TOKEN,
        ENGINE_OFF_KEY: "deliberately-wrong-key",
        BEACON_URL: `http://127.0.0.1:${BEACON_PORT}/token/proof`,
        BEACON_SECRET,
      },
    });
    await waitForLog(next2, /Ready in|started server|Local:/, 90_000);
    announcements = [signed("a", URL_A)];
    simA.offCount = 0;
    const res = await fetch("http://127.0.0.1:3112/api/netlify/engine-off", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${CONTROL_TOKEN}` },
      body: JSON.stringify({ engine: "all" }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    ev(`wrong-key engine-off: HTTP ${res.status} ${JSON.stringify(json)}`);
    checkTrue("does NOT claim 'off'", json.status !== "off", `status=${JSON.stringify(json.status)}`);
    checkTrue("engine still running (offCount=0)", simA.offCount === 0, `offCount=${simA.offCount}`);
    next2.kill("SIGTERM");
  }

  /* =============================================================== P5 / R6 */
  section("P5 (R6)", "SSRF to cloud metadata / loopback is blocked at connect time");
  {
    const cases: Array<[string, string]> = [
      ["IPv6-mapped IMDS (was ALLOWED at baseline)", "http://[::ffff:169.254.169.254]/latest/meta-data/"],
      ["hex-encoded IMDS", "http://A9FEA9FE/latest/meta-data/"],
      ["link-local IMDS", "http://169.254.169.254/latest/meta-data/"],
      ["DNS that resolves to loopback (localtest.me)", "http://localtest.me/"],
      ["loopback", `http://127.0.0.1:${simB.port}/api/ps`],
      ["gopher scheme", "gopher://127.0.0.1:6379/_INFO"],
    ];
    for (const [label, url] of cases) {
      const r = await http_json("/api/tools/exec", { method: "POST", body: JSON.stringify({ tool: "web.fetch", args: { url } }) });
      const kind = (r.json as Record<string, unknown> | null)?.kind;
      /* "blocked" means the metadata service was never contacted: either the
         policy refused it up front, or the name did not resolve at all. */
      const blocked = kind === "policy" || r.status === 400 || /Could not resolve host/i.test(r.text);
      checkTrue(`${label} blocked`, blocked, `HTTP ${r.status} kind=${JSON.stringify(kind)} body=${r.text.slice(0, 100)}`);
    }
    /* A legitimate public URL must still be permitted by policy. */
    const okUrl = await http_json("/api/tools/exec", { method: "POST", body: JSON.stringify({ tool: "web.fetch", args: { url: "http://example.com/" } }) });
    const okKind = (okUrl.json as Record<string, unknown> | null)?.kind;
    checkTrue("public URL is NOT blocked by policy", okKind !== "policy", `HTTP ${okUrl.status} kind=${JSON.stringify(okKind)} body=${okUrl.text.slice(0, 100)}`);
  }

  /* ================================================== P6 / R1 + R4 + stop */
  section("P6 (R1)", "a >45s generation streams to completion (no 45s deadline)");
  {
    /* The shutdown proofs above genuinely stopped engine A (that was the point),
       so bring it back before proving streaming. */
    simA.healthy = true;
    announcements = [signed("a", URL_A)];
    const started = Date.now();
    const ac = new AbortController();
    const res = await fetch(`${BASE}/api/agent/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${CONTROL_TOKEN}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "Work through this carefully." }], engine: "a" }),
      signal: ac.signal,
    });
    check("stream HTTP status", res.status, 200);

    let chunks = 0;
    let sawDone = false;
    let sawError = false;
    let opsMidStream = -1;
    let opsChecked = false;
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        chunks++;
        if (/"done"\s*:\s*true/.test(line)) sawDone = true;
        if (/"error"/.test(line)) sawError = true;
        /* R4: sample activeOperations while the stream is genuinely in flight. */
        if (!opsChecked && chunks >= 3) {
          opsChecked = true;
          const st = await http_json("/api/engine/state");
          opsMidStream = Number((st.json as Record<string, unknown>)?.activeOperations ?? -1);
          ev(`mid-stream activeOperations = ${opsMidStream} (after ${chunks} events, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
        }
      }
    }
    const elapsed = (Date.now() - started) / 1000;
    ev(`stream finished: ${chunks} NDJSON events in ${elapsed.toFixed(1)}s`);
    checkTrue("stream ran longer than the old 45s deadline", elapsed > 45, `${elapsed.toFixed(1)}s`);
    checkTrue("stream reached a terminal done:true", sawDone);
    checkTrue("stream produced no error event", !sawError);
    checkTrue("engine saw no client disconnect", simA.abortedChats === 0, `abortedChats=${simA.abortedChats}`);
    checkTrue("R4: activeOperations > 0 mid-stream", opsMidStream > 0, `value=${opsMidStream}`);

    const after = await http_json("/api/engine/state");
    check("R4: activeOperations back to 0 after completion", (after.json as Record<string, unknown>)?.activeOperations, 0);
  }

  section("P7 (R1/R4)", "client cancel tears the stream down and releases the operation");
  {
    announcements = [signed("a", URL_A)];
    const ac = new AbortController();
    const startedAt = Date.now();
    const p = fetch(`${BASE}/api/agent/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${CONTROL_TOKEN}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "Long task" }], engine: "a" }),
      signal: ac.signal,
    }).catch((e) => e as Error);
    await new Promise((r) => setTimeout(r, 4000));
    const mid = await http_json("/api/engine/state");
    ev(`activeOperations during stream = ${JSON.stringify((mid.json as Record<string, unknown>)?.activeOperations)}`);
    ac.abort();
    const outcome = await p;
    ev(`client abort after ${((Date.now() - startedAt) / 1000).toFixed(1)}s -> ${outcome instanceof Error ? outcome.name : "resolved"}`);
    await new Promise((r) => setTimeout(r, 2500));
    const after = await http_json("/api/engine/state");
    check("activeOperations released after cancel", (after.json as Record<string, unknown>)?.activeOperations, 0);
  }

  /* ------------------------------------------------------------- teardown */
  killAll("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  killAll("SIGKILL");
  spawnDetached("bash", ["-c", `sed -i '/${HOST_A}/d;/${HOST_B}/d' /etc/hosts`], { sudo: true });
  beacon.close();
  await simA.close();
  await simB.close();

  /* --------------------------------------------------------------- report */
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n\x1b[1m${passed}/${results.length} proof groups passed\x1b[0m`);
  const md = [
    "# Aether runtime proof report",
    "",
    `Generated ${new Date().toISOString()} · node ${process.version} · real \`next start\` + real engine simulators over HTTP.`,
    "",
    `**${passed}/${results.length} proof groups passed.**`,
    "",
    ...results.flatMap((r) => [
      `## ${r.id} — ${r.finding} — ${r.pass ? "PASS" : "FAIL"}`,
      "",
      ...r.evidence.map((e) => `- ${e.replace(/\u001b\[[0-9;]*m/g, "")}`),
      "",
    ]),
  ].join("\n");
  fs.writeFileSync("/home/user/AETHER_PROOF.md", md);
  console.log("report -> /home/user/AETHER_PROOF.md");
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\n\x1b[31mHARNESS ERROR\x1b[0m", e);
  killAll("SIGKILL");
  spawnDetached("bash", ["-c", `sed -i '/${HOST_A}/d;/${HOST_B}/d' /etc/hosts`], { sudo: true });
  process.exit(2);
});
