import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineManager } from "@/server/engine/manager";
import {
  DEFAULT_IDLE_MINUTES,
  idleMinutes,
  ENGINE_SELF_IDLE_MINUTES,
} from "@/server/engine/contract";

const BEACON = "https://beacon.test/token";
const BEACON_BACKUP = "https://ntfy.test/topic/json?poll=1";
const TUNNEL_A = "https://alpha.trycloudflare.com";
const TUNNEL_B = "https://beta.trycloudflare.com";
const TUNNEL_C = "https://gamma.trycloudflare.com";

/**
 * Unified shutdown vocabulary (audit B1): both the manager and killAllEngines
 * now report "shutdown" | "rejected-key" | "http-N" | "unreachable" |
 * "already-off" from the single shutdownEngineUrl() implementation.
 *
 * Scripted fetch: beacons + engine health + the engine's REAL shutdown contract
 * (POST /off with X-Engine-Key). There is deliberately no `/api/off` handler —
 * the real engine proxies unknown paths to ollama and returns 502, so any code
 * calling `/api/off` fails here exactly as it fails in production.
 */
function scriptedFetch(routes: {
  healthy?: string[];
  beacon?: { liveUrl?: string; off?: boolean; tag?: "a" | "b" | "c" | null } | "error";
  offKey?: string | null;
}) {
  const calls: string[] = [];
  const offRequests: Array<{ url: string; key: string | null }> = [];
  const expectedKey = routes.offKey ?? "test-off-key";

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as URL).href ?? (input as Request).url);
    calls.push(url);

    if (url.startsWith(`${BEACON}/requests`)) {
      if (routes.beacon === "error") return new Response("boom", { status: 500 });
      const beacon = routes.beacon;
      const tag = beacon?.tag ?? "a";
      const data = beacon?.liveUrl
        ? [
            {
              url: `https://beacon.test/x?m=${encodeURIComponent(
                `${tag ? `engine=${tag} ` : ""}alive: ${beacon.liveUrl} (idle 0 min)`,
              )}`,
              created_at: new Date().toISOString(),
            },
          ]
        : beacon?.off
          ? [{ url: "https://beacon.test/x?m=ENGINE+OFF+via+UI", created_at: new Date().toISOString() }]
          : [];
      return Response.json({ data });
    }
    if (url === BEACON_BACKUP) return new Response("", { status: 200 });

    if (url.endsWith("/api/ps")) {
      const base = url.slice(0, -"/api/ps".length);
      const ok = routes.healthy?.includes(base) ?? false;
      /* A real healthy engine reports a LOADED model, not an empty list. */
      return new Response(ok ? '{"models":[{"name":"m","size":1}]}' : "nope", { status: ok ? 200 : 503 });
    }

    if (url.endsWith("/off")) {
      const key = (init?.headers as Record<string, string> | undefined)?.["X-Engine-Key"] ?? null;
      offRequests.push({ url, key });
      if (key !== expectedKey) return new Response('{"status":"forbidden"}', { status: 403 });
      return new Response('{"status":"shutting down"}', { status: 200 });
    }

    /* Anything else is proxied to ollama by the real engine -> 502. */
    return new Response("proxied to ollama: no such route", { status: 502 });
  }) as typeof fetch;

  return { impl, calls, offRequests };
}

beforeEach(() => {
  process.env.BEACON_URL = BEACON;
  process.env.BEACON_BACKUP_URL = BEACON_BACKUP;
  process.env.ENGINE_OFF_KEY = "test-off-key";
  delete process.env.BEACON_SECRET;
  delete process.env.ENGINE_URL_A;
  delete process.env.ENGINE_URL_B;
  delete process.env.ENGINE_URL_C;
  delete process.env.ENGINE_STALE_MS;
});

afterEach(() => {
  delete process.env.BEACON_URL;
  delete process.env.BEACON_BACKUP_URL;
  delete process.env.ENGINE_OFF_KEY;
});

describe("EngineManager — resolution", () => {
  it("resolves through the beacon when no cached URL is healthy", async () => {
    const { impl, calls } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    const result = await manager.resolve();
    expect(result.state).toBe("alive");
    expect(result.url).toBe(TUNNEL_A);
    expect(calls.some((c) => c.startsWith(BEACON))).toBe(true);
    expect(calls.some((c) => c === `${TUNNEL_A}/api/ps`)).toBe(true);
  });

  it("reports off when the beacon's latest lifecycle event is a shutdown", async () => {
    const { impl } = scriptedFetch({ healthy: [], beacon: { off: true } });
    const manager = new EngineManager({ fetchImpl: impl });
    const result = await manager.resolve();
    expect(result.state).toBe("off");
    expect(result.url).toBeNull();
  });

  it("reports unreachable when the announced tunnel fails /api/ps (rotating URL)", async () => {
    const { impl } = scriptedFetch({ healthy: [], beacon: { liveUrl: "https://dead.trycloudflare.com" } });
    const manager = new EngineManager({ fetchImpl: impl });
    const result = await manager.resolve();
    expect(result.state).toBe("unreachable");
  });

  it("does NOT treat an engine with no loaded model as alive", async () => {
    /* /api/ps returns 200 but models:[] — the old manager accepted this. */
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(BEACON)) {
        return Response.json({
          data: [{ url: `https://beacon.test/x?m=${encodeURIComponent(`alive: ${TUNNEL_A} (idle 0 min)`)}`, created_at: new Date().toISOString() }],
        });
      }
      if (url.endsWith("/api/ps")) return new Response('{"models":[]}', { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const manager = new EngineManager({ fetchImpl: impl });
    const result = await manager.resolve();
    expect(result.state).not.toBe("alive");
  });
});

describe("EngineManager — strict A/B/C routing (audit C5)", () => {
  it("an untagged announcement cannot satisfy a strict Engine B request", async () => {
    /* Beacon announces a live engine with NO engine= tag. */
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A, tag: null } });
    const manager = new EngineManager({ fetchImpl: impl });
    const strictB = await manager.resolve({ engine: "b", strict: true });
    expect(strictB.state).not.toBe("alive");
    expect(strictB.url).toBeNull();
    /* AUTO may adopt it. */
    const auto = await manager.resolve({ engine: "b", strict: false });
    expect(auto.state).toBe("alive");
    expect(auto.url).toBe(TUNNEL_A);
  });

  it("a tagged announcement satisfies exactly its own slot", async () => {
    const { impl } = scriptedFetch({ healthy: [TUNNEL_B], beacon: { liveUrl: TUNNEL_B, tag: "b" } });
    const manager = new EngineManager({ fetchImpl: impl });
    expect((await manager.resolve({ engine: "b", strict: true })).url).toBe(TUNNEL_B);
    expect((await manager.resolve({ engine: "a", strict: true })).url).toBeNull();
    expect((await manager.resolve({ engine: "c", strict: true })).url).toBeNull();
  });

  it("ENGINE_URL_<slot> overrides are authoritative per slot", async () => {
    process.env.ENGINE_URL_A = TUNNEL_A;
    process.env.ENGINE_URL_C = TUNNEL_C;
    const { impl, calls } = scriptedFetch({ healthy: [TUNNEL_A, TUNNEL_C], beacon: { liveUrl: TUNNEL_B, tag: "b" } });
    const manager = new EngineManager({ fetchImpl: impl });
    expect((await manager.resolve({ engine: "a" })).url).toBe(TUNNEL_A);
    expect((await manager.resolve({ engine: "c" })).url).toBe(TUNNEL_C);
    /* No beacon consultation was needed for the overridden slots. */
    expect(calls.filter((c) => c.startsWith(BEACON)).length).toBe(0);
  });
});

describe("EngineManager — wake and deterministic failover", () => {
  it("wake resolves an already-alive engine without touching Kaggle", async () => {
    const { impl, calls } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    const result = await manager.wake("a", 1_000);
    expect(result.state).toBe("alive");
    expect(result.url).toBe(TUNNEL_A);
    expect(calls.some((c) => c.includes("kaggle.com"))).toBe(false);
  });

  it("failover advances exactly one slot in A→B→C→D→A order", async () => {
    const { impl } = scriptedFetch({ healthy: [TUNNEL_B, TUNNEL_C], beacon: { liveUrl: TUNNEL_B, tag: "b" } });
    const manager = new EngineManager({ fetchImpl: impl });
    const first = await manager.failover("a");
    expect(first.slot).toBe("b");
    const second = await manager.failover("b");
    expect(second.slot).toBe("c");
    /* C no longer wraps to A: D sits between them now. */
    const third = await manager.failover("c");
    expect(third.slot).toBe("d");
    const fourth = await manager.failover("d");
    expect(fourth.slot).toBe("a");
  });

  it("reportFailure evicts the stale URL so it is not reused", async () => {
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    await manager.resolve({ engine: "a" });
    expect(manager.snapshot().engines.a.url).toBe(TUNNEL_A);
    manager.reportFailure("a");
    expect(manager.snapshot().engines.a.state).toBe("unreachable");
    expect(manager.snapshot().engines.a.url).toBeNull();
  });
});

describe("EngineManager — shutdown uses the engine's REAL contract (audit C3)", () => {
  it("POSTs {url}/off with X-Engine-Key, never /api/off", async () => {
    const { impl, calls, offRequests } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    await manager.resolve({ engine: "a" });
    const result = await manager.off("all");
    expect(result.ok).toBe(true);
    expect(result.results.a).toBe("shutdown");
    expect(calls).toContain(`${TUNNEL_A}/off`);
    expect(calls.some((c) => c.endsWith("/api/off"))).toBe(false);
    expect(offRequests[0]?.key).toBe("test-off-key");
    expect(manager.snapshot().engines.a.state).toBe("off");
  });

  it("does NOT claim off when the engine rejects the key (403)", async () => {
    process.env.ENGINE_OFF_KEY = "wrong-key";
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    await manager.resolve({ engine: "a" });
    const result = await manager.off("all");
    expect(result.ok).toBe(false);
    expect(result.results.a).toBe("rejected-key");
    /* The engine is still running — the state must say so. */
    expect(manager.snapshot().engines.a.state).toBe("alive");
    expect(manager.snapshot().engines.a.url).toBe(TUNNEL_A);
  });

  it("does NOT claim off when the engine returns 502 (wrong path / proxied to ollama)", async () => {
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    await manager.resolve({ engine: "a" });
    /* Simulate the old broken path by pointing at an unroutable endpoint. */
    const broken = new EngineManager({
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/off")) return new Response("proxied to ollama", { status: 502 });
        return impl(input, init);
      }) as typeof fetch,
    });
    await broken.resolve({ engine: "a" });
    const result = await broken.off("all");
    expect(result.ok).toBe(false);
    expect(result.results.a).toBe("http-502");
    expect(broken.snapshot().engines.a.state).toBe("alive");
  });

  it("refuses shutdown while an operation is active, then succeeds", async () => {
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    await manager.resolve({ engine: "a" });
    manager.beginOperation();
    const refused = await manager.off("all");
    expect(refused.ok).toBe(false);
    expect(refused.detail).toMatch(/operation is active/i);
    manager.endOperation();
    const accepted = await manager.off("all");
    expect(accepted.ok).toBe(true);
    expect(accepted.results.a).toMatch(/shutdown|no-url|already-off/);
  });

  it("refuses shutdown entirely when ENGINE_OFF_KEY is not configured", async () => {
    delete process.env.ENGINE_OFF_KEY;
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    await manager.resolve({ engine: "a" });
    const result = await manager.off("all");
    expect(result.ok).toBe(false);
    expect(result.results.a).toBe("no-off-key");
  });
});

describe("EngineManager — idle shutdown", () => {
  afterEach(() => {
    delete process.env.ENGINE_IDLE_MINUTES;
  });

  /*
   * FIX (audit D2): the server used to default to 20 minutes while the engine's
   * own watchdog (IDLE_LIMIT = 3600 in the shipped notebook) allowed 60, so the
   * two disagreed and the server always fired first — the engine's watchdog was
   * dead code and engines died 40 minutes before either side intended.
   */
  it("defaults to the engine's own 60-minute watchdog and honours the override", () => {
    expect(ENGINE_SELF_IDLE_MINUTES).toBe(60);
    expect(DEFAULT_IDLE_MINUTES).toBe(ENGINE_SELF_IDLE_MINUTES);
    expect(idleMinutes()).toBe(60);
    process.env.ENGINE_IDLE_MINUTES = "5";
    expect(idleMinutes()).toBe(5);
    delete process.env.ENGINE_IDLE_MINUTES;
  });

  it("never idles out while an operation is in flight", async () => {
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    let now = 1_000_000;
    const manager = new EngineManager({ fetchImpl: impl, now: () => now });
    await manager.resolve({ engine: "a" });
    manager.beginOperation();
    now += 60 * 60_000; // an hour later
    expect(await manager.idleCheck()).toBe(false);
    manager.endOperation();
  });
});

describe("degraded-engine detection — an engine that is up but unreliable", () => {
  /* Measured on a live engine: 40 health probes two seconds apart returned 22
     successes and 18 failures — a 55% success rate, longest outage about six
     seconds. Every individual failure looked transient, so nothing tripped the
     failover path and the user got an engine that kept dropping mid-turn. A
     rate is the only signal that separates that from ordinary noise. */

  function mgr() {
    return new EngineManager({
      beaconUrl: BEACON,
      beaconBackupUrl: BEACON_BACKUP,
      fetchImpl: scriptedFetch({ healthy: [] }),
    } as never);
  }

  it("does not condemn an engine on one or two bad probes", () => {
    const m = mgr();
    m.noteOutcome("a", false);
    expect(m.isDegraded("a")).toBe(false); // only 1 sample
    m.noteOutcome("a", true);
    m.noteOutcome("a", false);
    m.noteOutcome("a", true);
    // 2 failures in 4 = 50%, above the 25% threshold
    expect(m.isDegraded("a")).toBe(true);
  });

  it("tolerates an occasional blip on an otherwise healthy engine", () => {
    const m = mgr();
    for (const ok of [true, true, false, true, true, true, true, true]) {
      m.noteOutcome("b", ok);
    }
    expect(m.isDegraded("b")).toBe(false);
  });

  it("flags the measured 55%-success engine as degraded", () => {
    const m = mgr();
    // The observed pattern, condensed: roughly half failing.
    for (const ok of [false, false, true, true, false, true, false, true]) {
      m.noteOutcome("c", ok);
    }
    expect(m.isDegraded("c")).toBe(true);
  });

  it("reinstates an engine only after a demonstrated recovery", () => {
    const m = mgr();
    for (const ok of [false, false, false, false]) m.noteOutcome("d", ok);
    expect(m.isDegraded("d")).toBe(true);
    /* Recovery rule: 4 CONSECUTIVE successes reinstate immediately. The old
       behaviour let the fixed window dilute failures slowly (3-in-8 needed
       six successes to clear 25%), so a recovered engine stayed excluded
       about twice as long as it was broken. One, two or three lucky probes
       still do not bring back a flapping engine. */
    m.noteOutcome("d", true);
    m.noteOutcome("d", true);
    m.noteOutcome("d", true);
    expect(m.isDegraded("d")).toBe(true); // 3 in a row: not yet
    m.noteOutcome("d", true);
    expect(m.isDegraded("d")).toBe(false); // 4th in a row: recovered
  });

  it("an interleaved success does not count as recovery", () => {
    const m = mgr();
    for (const ok of [false, false, false, false]) m.noteOutcome("d", ok);
    // t f t t t: the failure resets the streak, and 3/8 failures is still >25%
    for (const ok of [true, false, true, true, true]) m.noteOutcome("d", ok);
    expect(m.isDegraded("d")).toBe(true);
  });

  it("clearOutcomes resets the history, e.g. after a restart", () => {
    const m = mgr();
    for (const ok of [false, false, false, false]) m.noteOutcome("a", ok);
    expect(m.isDegraded("a")).toBe(true);
    m.clearOutcomes("a");
    expect(m.isDegraded("a")).toBe(false);
  });

  it("reportFailure counts as a failed outcome", () => {
    const m = mgr();
    m.reportFailure("a");
    m.reportFailure("a");
    m.reportFailure("a");
    m.reportFailure("a");
    expect(m.isDegraded("a")).toBe(true);
  });
});

describe("latency-aware AUTO routing — fastest healthy engine wins", () => {
  /* Was: pickEngine() returned the first alive, non-degraded slot in
     ENGINE_IDS order — "first available", so AUTO always landed on A even
     when C probed 3x faster (live spread this session: 0.13s–0.65s medians).
     Latency samples ride on the health probes the state route already runs;
     routing itself never probes. */

  function mgr() {
    return new EngineManager({
      beaconUrl: BEACON,
      beaconBackupUrl: BEACON_BACKUP,
      fetchImpl: scriptedFetch({ healthy: [] }),
    } as never);
  }

  function alive(m: ReturnType<typeof mgr>, slots: Array<"a" | "b" | "c" | "d">) {
    for (const s of slots) m.noteAlive(s, `https://${s}.trycloudflare.com`);
  }

  it("stays on the active engine when nothing is measured", () => {
    const m = mgr();
    alive(m, ["a", "b", "c"]);
    m.noteAlive("b", "https://b.trycloudflare.com"); // sets active = b
    expect(m.pickEngine()).toBe("b");
  });

  it("routes to a decisively faster healthy engine", () => {
    const m = mgr();
    alive(m, ["a", "b", "c"]);
    m.noteAlive("a", "https://a.trycloudflare.com"); // active = a
    for (let i = 0; i < 5; i++) {
      m.noteLatency("a", 620);
      m.noteLatency("b", 140);
    }
    expect(m.pickEngine()).toBe("b");
  });

  it("does not flap on sub-margin differences", () => {
    const m = mgr();
    alive(m, ["a", "b"]);
    m.noteAlive("a", "https://a.trycloudflare.com"); // active = a
    for (let i = 0; i < 5; i++) {
      m.noteLatency("a", 300);
      m.noteLatency("b", 220); // 80ms faster: inside the 150ms margin
    }
    expect(m.pickEngine()).toBe("a");
  });

  it("never displaces a measured engine with an unmeasured one", () => {
    const m = mgr();
    alive(m, ["a", "b"]);
    m.noteAlive("a", "https://a.trycloudflare.com");
    for (let i = 0; i < 3; i++) m.noteLatency("a", 900); // slow, but measured
    expect(m.pickEngine()).toBe("a");
  });

  it("median, not mean: one timeout does not outweigh seven fast probes", () => {
    const m = mgr();
    for (const ms of [200, 210, 190, 5000, 205, 195, 200, 210]) m.noteLatency("a", ms);
    const med = m.medianLatency("a");
    expect(med).not.toBeNull();
    expect(med as number).toBeLessThan(300);
  });

  it("fails over to the FASTEST healthy engine, not the first slot", () => {
    const m = mgr();
    alive(m, ["a", "b", "c"]);
    m.noteAlive("a", "https://a.trycloudflare.com"); // active = a
    // kill a
    for (let i = 0; i < 4; i++) m.noteOutcome("a", false);
    for (let i = 0; i < 3; i++) {
      m.noteLatency("b", 500);
      m.noteLatency("c", 160);
    }
    expect(m.pickEngine()).toBe("c");
  });

  it("a degraded engine is skipped even when it is the fastest", () => {
    const m = mgr();
    alive(m, ["a", "b"]);
    m.noteAlive("a", "https://a.trycloudflare.com");
    for (let i = 0; i < 4; i++) m.noteOutcome("b", false); // b degraded
    for (let i = 0; i < 3; i++) {
      m.noteLatency("a", 800);
      m.noteLatency("b", 100); // fastest, but degraded
    }
    expect(m.pickEngine()).toBe("a");
  });

  it("reportFailure drops the dead tunnel's latencies", () => {
    const m = mgr();
    alive(m, ["a"]);
    for (let i = 0; i < 3; i++) m.noteLatency("a", 120);
    m.reportFailure("a");
    expect(m.medianLatency("a")).toBeNull();
  });

  it("rejects nonsense latency samples", () => {
    const m = mgr();
    m.noteLatency("a", -5);
    m.noteLatency("a", Number.NaN);
    expect(m.medianLatency("a")).toBeNull();
  });
});
