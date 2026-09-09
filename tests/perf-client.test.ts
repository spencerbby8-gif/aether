// @vitest-environment jsdom
/**
 * Client-side latency harness.
 *
 * Drives the REAL runEngineChat() from src/providers/engine-chat.ts against a
 * local NDJSON server that replays a captured engine stream with the recorded
 * inter-event gaps. Nothing about the client is mocked except the network hop:
 * parsing, event dispatch, artifact handling and timing are all production
 * code. Run it before and after a change and diff the numbers.
 *
 *   npx vitest run tests/perf-client.test.ts
 */
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runEngineChat, saveArtifact } from "@/providers/engine-chat";
import { readNdjson } from "@/lib/engine-client";

const CAPTURE = "scripts/perf/output/captured-stream.ndjson";

/* A corpus shaped like a real agent turn when no capture is available yet. */
function syntheticStream(): Array<{ gapMs: number; line: string }> {
  const out: Array<{ gapMs: number; line: string }> = [];
  for (let i = 0; i < 12; i++) {
    out.push({ gapMs: 60, line: JSON.stringify({ message: { thinking: `agent step ${i}: inspecting result ${i}` } }) });
  }
  for (let i = 0; i < 5; i++) {
    out.push({ gapMs: 200, line: JSON.stringify({ tool: { id: `t${i}`, name: "web_search", state: "running", detail: `q${i}` } }) });
    out.push({ gapMs: 900, line: JSON.stringify({ tool: { id: `t${i}`, name: "web_search", state: "done", detail: "7 results" } }) });
  }
  for (let i = 0; i < 800; i++) {
    out.push({ gapMs: 8, line: JSON.stringify({ message: { content: ` token${i}` } }) });
  }
  out.push({ gapMs: 10, line: JSON.stringify({ done: true }) });
  return out;
}

function loadStream(): Array<{ gapMs: number; line: string }> {
  if (existsSync(CAPTURE)) {
    const parsed = readFileSync(CAPTURE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as { gapMs: number; line: string };
        } catch {
          return null;
        }
      })
      .filter((x): x is { gapMs: number; line: string } => !!x);
    if (parsed.length > 5) return parsed;
  }
  return syntheticStream();
}

let server: Server;
let port = 0;
let servedFrom: string;

function start(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/api/agent/stream") {
        const events = loadStream();
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        let i = 0;
        const tick = () => {
          if (i >= events.length) {
            res.end();
            return;
          }
          const e = events[i++];
          res.write(e.line + "\n");
          setTimeout(tick, e.gapMs);
        };
        tick();
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

beforeAll(async () => {
  port = await start();
  servedFrom = `http://127.0.0.1:${port}`;
  const realFetch = globalThis.fetch;
  // Only the network hop is redirected; every relative URL the client uses is
  // served by the local replay server so the real handler code runs.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("/")) return realFetch(`${servedFrom}${url}`, init);
    return realFetch(input as never, init);
  }) as typeof fetch;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

function run(fn: () => unknown, reps = 5): number[] {
  const out: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return out;
}

function stats(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  return {
    n: s.length,
    median: s[Math.floor(s.length / 2)] ?? 0,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0,
    max: s[s.length - 1] ?? 0,
  };
}

describe("client latency chain", () => {
  it("measures the real runEngineChat event chain", async () => {
    const events: Array<{ type: string; at: number; bytes: number }> = [];
    const t0 = performance.now();
    const outcome = await runEngineChat({
      turns: [{ role: "user", content: "Research the population of Lagos." }],
      signal: new AbortController().signal,
      streaming: true,
      mode: "auto",
      onEvent: (e) => {
        events.push({
          type: e.type,
          at: performance.now() - t0,
          bytes: e.type === "delta" || e.type === "thinking" ? e.text.length : 0,
        });
      },
    });
    const total = performance.now() - t0;

    const first = (t: string) => events.find((e) => e.type === t)?.at ?? null;
    const counts = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    }, {});
    const thinkingBytes = events
      .filter((e) => e.type === "thinking")
      .reduce((a, e) => a + e.bytes, 0);
    const thinkingFinal = Math.max(0, ...events.filter((e) => e.type === "thinking").map((e) => e.bytes));

    const row = {
      status: outcome.status,
      totalMs: Math.round(total),
      firstThinkingMs: first("thinking"),
      firstToolMs: first("tool"),
      firstDeltaMs: first("delta"),
      counts,
      thinkingEvents: counts.thinking ?? 0,
      thinkingBytesPushed: thinkingBytes,
      thinkingFinalBytes: thinkingFinal,
      thinkingAmplification: thinkingFinal > 0 ? Math.round((thinkingBytes / thinkingFinal) * 10) / 10 : 0,
      outputChars: outcome.text.length,
    };
    console.log("CLIENT CHAIN", JSON.stringify(row, null, 2));
    expect(outcome.status).toBe("complete");
    expect(counts.delta ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it("artifact decode: the old per-char callback vs the indexed loop", () => {
    // A realistic generated PNG payload: ~1.2 MB of base64 (~900 KB binary).
    const bytes = new Uint8Array(900_000);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 0xff;
    const base64 = Buffer.from(bytes).toString("base64");

    const oldWay = () => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const newWay = () => {
      const binary = atob(base64);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    };

    const a = stats(run(oldWay));
    const b = stats(run(newWay));
    // Same bytes out — the speedup must not come from doing less work.
    expect(Buffer.from(newWay()).equals(Buffer.from(oldWay()))).toBe(true);

    console.log(
      "ARTIFACT DECODE",
      JSON.stringify({
        base64Chars: base64.length,
        oldMedianMs: Math.round(a.median * 10) / 10,
        newMedianMs: Math.round(b.median * 10) / 10,
        speedup: b.median > 0 ? Math.round((a.median / b.median) * 10) / 10 : null,
      }),
    );
    expect(b.median).toBeLessThan(a.median);
  }, 60_000);

  it("measures saveArtifact end to end (decode + AssetStore write)", async () => {
    const bytes = new Uint8Array(900_000);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 0xff;
    const base64 = Buffer.from(bytes).toString("base64");
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await saveArtifact({ name: `perf-${i}.png`, mimeType: "image/png", base64 });
      runs.push(performance.now() - t0);
    }
    const st = stats(runs);
    console.log(
      "ARTIFACT SAVE total",
      JSON.stringify({ medianMs: Math.round(st.median * 10) / 10, maxMs: Math.round(st.max * 10) / 10 }),
    );
    expect(runs.length).toBe(5);
  }, 60_000);

  it("measures readNdjson against a large real-shaped payload", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) lines.push(JSON.stringify({ message: { content: ` token${i}` } }));
    const payload = lines.map((l) => l + "\n").join("");
    const runs: number[] = [];
    for (let p = 0; p < 5; p++) {
      const buf = Buffer.from(payload);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < buf.length; i += 1400) c.enqueue(new Uint8Array(buf.subarray(i, i + 1400)));
          c.close();
        },
      });
      const t0 = performance.now();
      let n = 0;
      for await (const _ of readNdjson(new Response(stream), new AbortController().signal)) n++;
      runs.push(performance.now() - t0);
      expect(n).toBe(lines.length);
    }
    const st = stats(runs);
    console.log(
      "NDJSON PARSE",
      JSON.stringify({
        lines: lines.length,
        bytes: Buffer.byteLength(payload),
        medianMs: Math.round(st.median * 10) / 10,
        maxMs: Math.round(st.max * 10) / 10,
      }),
    );
    expect(st.median).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
