/**
 * Latency-chain instrumentation.
 *
 * Every number here is a wall-clock measurement of the REAL production module,
 * imported from src/ -- not a reimplementation. Run it before a change and
 * after it and diff the tables; that diff is the evidence.
 *
 *   npx --yes tsx scripts/perf/latency-chain.mts [--json out.json] [--engine URL]
 *
 * Stages measured
 *   beacon      getEngineLinks()            ntfy round trip + HMAC verify + parse
 *   discover    discoverAlive()             cold (cache reset) and warm
 *   resolve     resolveEngine()             the full path a chat request takes
 *   health      probeFleetHealth()          cold and cached
 *   alive       isEngineAlive(url)          one /api/ps probe
 *   ndjson      readNdjson()                event-parsing throughput
 *   reuse       two sequential fetches      TCP+TLS setup vs. reused socket
 */
import { writeFileSync } from "node:fs";

import {
  discoverAlive,
  getEngineLinks,
  isEngineAlive,
  probeFleetHealth,
  resetDiscoveryCache,
  resetHealthCache,
  resolveEngine,
} from "../../src/server/engine/resolve";
import { readNdjson } from "../../src/lib/engine-client";

/* ------------------------------------------------------------------ utils */

interface Sample {
  stage: string;
  label: string;
  ms: number;
  detail: string;
}

const samples: Sample[] = [];

function record(stage: string, label: string, ms: number, detail: string) {
  samples.push({ stage, label, ms: Math.round(ms * 10) / 10, detail });
}

async function time<T>(
  stage: string,
  label: string,
  fn: () => Promise<T>,
  detail: (r: T) => string,
): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  record(stage, label, performance.now() - t0, detail(r));
  return r;
}

function stats(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0] ?? 0,
    median: s[Math.floor(s.length / 2)] ?? 0,
    mean: s.length ? sum / s.length : 0,
    p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] ?? 0,
    max: s[s.length - 1] ?? 0,
  };
}

/* ------------------------------------------------- realistic NDJSON corpus */

/**
 * A corpus shaped like a real engine turn: a long run of small content deltas,
 * interleaved tool events, thinking lines, citations and a terminal done.
 * Chunked the way a Cloudflare tunnel actually delivers it -- small, uneven
 * writes, not one big buffer -- because that is what stresses the parser.
 */
function ndjsonCorpus() {
  const lines: string[] = [];
  lines.push(JSON.stringify({ message: { thinking: "Considering the question" } }));
  for (let i = 0; i < 6; i++) {
    lines.push(JSON.stringify({ tool: { id: `t${i}`, name: "web_search", state: "running", detail: `query ${i}` } }));
    lines.push(JSON.stringify({ tool: { id: `t${i}`, name: "web_search", state: "done", detail: "7 results" } }));
  }
  for (let i = 0; i < 1200; i++) {
    lines.push(JSON.stringify({ message: { content: ` token${i}` } }));
  }
  lines.push(JSON.stringify({ citations: [{ title: "Lagos - Wikipedia", url: "https://en.wikipedia.org/wiki/Lagos" }] }));
  lines.push(JSON.stringify({ done: true }));
  return lines.map((l) => l + "\n").join("");
}

async function measureNdjson(passes: number) {
  const payload = ndjsonCorpus();
  const bytes = Buffer.byteLength(payload);
  const lines = payload.split("\n").filter(Boolean).length;
  const CHUNK = 1400; // ~ one MTU, so lines straddle chunk boundaries

  for (let p = 0; p < passes; p++) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const buf = Buffer.from(payload);
        for (let i = 0; i < buf.length; i += CHUNK) {
          controller.enqueue(new Uint8Array(buf.subarray(i, i + CHUNK)));
        }
        controller.close();
      },
    });
    const response = new Response(stream);
    const t0 = performance.now();
    let count = 0;
    for await (const _ of readNdjson(response, new AbortController().signal)) count++;
    const ms = performance.now() - t0;
    record(
      "ndjson",
      `parse pass ${p + 1}`,
      ms,
      `${count} events / ${lines} lines / ${bytes} B`,
    );
    if (count !== lines) throw new Error(`readNdjson yielded ${count} events, expected ${lines}`);
  }
  return { bytes, lines };
}

/* ------------------------------------------------ connection-reuse probing */

/**
 * Is a socket actually being reused between engine requests? Node's global
 * fetch pools per origin, but a header or a dispatcher change silently kills
 * that, and the cost is a full TLS handshake on every single engine call.
 * Measure the gap instead of assuming: first request pays setup, the next
 * should be materially cheaper if reuse is working.
 */
async function measureReuse(origin: string, passes: number) {
  const out: number[] = [];
  for (let i = 0; i < passes; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch(`${origin}/api/ps`, { signal: AbortSignal.timeout(15_000) });
      await r.text();
    } catch {
      /* unreachable origin still measures the failure path, which is data */
    }
    out.push(performance.now() - t0);
  }
  out.forEach((ms, i) => record("reuse", `GET ${origin} #${i + 1}`, ms, i === 0 ? "cold" : "should reuse socket"));
  return out;
}

/* ------------------------------------------------------------------- main */

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
  const engine = args.includes("--engine") ? args[args.indexOf("--engine") + 1] : null;
  const REPEAT = Number(process.env.PERF_REPEAT ?? 5);

  console.log(`latency-chain: ${REPEAT} repeats per stage`);

  /* --- beacon: the ntfy round trip behind every discovery --- */
  for (let i = 0; i < REPEAT; i++) {
    await time("beacon", `getEngineLinks #${i + 1}`, () => getEngineLinks(), (r) => `${r.length} links`);
  }

  /* --- discovery, cold and warm --- */
  for (let i = 0; i < REPEAT; i++) {
    resetDiscoveryCache();
    await time("discover", `discoverAlive cold #${i + 1}`, () => discoverAlive(), (r) =>
      `alive=${r.alive} checked=${r.checked} waking=${r.waking} reported=${r.latencyMs}ms`,
    );
    await time("discover", `discoverAlive warm #${i + 1}`, () => discoverAlive(), (r) =>
      `alive=${r.alive} reported=${r.latencyMs}ms`,
    );
  }

  /* --- the full resolve a chat request actually performs --- */
  for (let i = 0; i < REPEAT; i++) {
    resetDiscoveryCache();
    await time("resolve", `resolveEngine #${i + 1}`, () => resolveEngine(), (r) =>
      `${r.status}${r.slot ? ` slot=${r.slot}` : ""}${r.reason ? ` reason=${r.reason}` : ""}`,
    );
  }

  /* --- fleet health, cold and cached --- */
  const healthShape = (r: Record<string, { state: string; latencyMs: number | null }>) =>
    Object.entries(r)
      .map(([k, v]) => `${k}=${v.state}${v.latencyMs != null ? `(${v.latencyMs}ms)` : ""}`)
      .join(" ");
  resetHealthCache();
  await time("health", "probeFleetHealth cold", () => probeFleetHealth(), healthShape);
  await time("health", "probeFleetHealth cached", () => probeFleetHealth(), healthShape);

  /* --- event parsing --- */
  const corpus = await measureNdjson(REPEAT);
  console.log(`  ndjson corpus: ${corpus.lines} lines / ${corpus.bytes} B`);

  /* --- connection reuse against a real origin --- */
  const reuseOrigin = engine ?? "https://ntfy.sh";
  await measureReuse(reuseOrigin, 4);

  /* --- a live engine, when one is up --- */
  if (engine) {
    for (let i = 0; i < REPEAT; i++) {
      await time("alive", `isEngineAlive #${i + 1}`, () => isEngineAlive(engine), (r) => `alive=${r}`);
    }
  }

  /* ------------------------------------------------------------- report */
  const byStage = new Map<string, Sample[]>();
  for (const s of samples) {
    if (!byStage.has(s.stage)) byStage.set(s.stage, []);
    byStage.get(s.stage)!.push(s);
  }

  console.log(
    "\n" +
      `${"stage".padEnd(10)} ${"n".padStart(3)} ${"min".padStart(9)} ${"median".padStart(9)}` +
      ` ${"mean".padStart(9)} ${"p90".padStart(9)} ${"max".padStart(9)}   detail`,
  );
  const rows: Array<Record<string, string | number>> = [];
  for (const [stage, list] of byStage) {
    const s = stats(list.map((x) => x.ms));
    const f = (v: number) => `${Math.round(v * 10) / 10}ms`;
    console.log(
      `${stage.padEnd(10)} ${String(s.n).padStart(3)} ${f(s.min).padStart(9)} ${f(s.median).padStart(9)}` +
        ` ${f(s.mean).padStart(9)} ${f(s.p90).padStart(9)} ${f(s.max).padStart(9)}   ${list[0].detail}`,
    );
    rows.push({ stage, ...s, detail: list[0].detail });
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), rows, samples }, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }
}

main().catch((e) => {
  console.error("latency-chain FAILED:", e);
  process.exit(1);
});
