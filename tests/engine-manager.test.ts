import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineManager } from "@/server/engine/manager";
import { DEFAULT_IDLE_MINUTES, idleMinutes } from "@/server/engine/contract";

const BEACON = "https://beacon.test/token";
const BEACON_BACKUP = "https://ntfy.test/topic/json?poll=1";
const TUNNEL_A = "https://alpha.trycloudflare.com";
const TUNNEL_B = "https://beta.trycloudflare.com";
const TUNNEL_C = "https://gamma.trycloudflare.com";

/**
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

  it("failover advances exactly one slot in A→B→C→A order", async () => {
    const { impl } = scriptedFetch({ healthy: [TUNNEL_B, TUNNEL_C], beacon: { liveUrl: TUNNEL_B, tag: "b" } });
    const manager = new EngineManager({ fetchImpl: impl });
    const first = await manager.failover("a");
    expect(first.slot).toBe("b");
    const second = await manager.failover("b");
    expect(second.slot).toBe("c");
    const third = await manager.failover("c");
    expect(third.slot).toBe("a");
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
    expect(result.results.a).toBe("off-accepted");
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
    expect(result.results.a).toBe("off-rejected-key");
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
    expect(result.results.a).toBe("off-http-502");
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
    expect(accepted.results.a).toMatch(/off-accepted|no-url|already-off/);
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

  it("defaults to 20 minutes and honours the override", () => {
    expect(DEFAULT_IDLE_MINUTES).toBe(20);
    expect(idleMinutes()).toBe(20);
    process.env.ENGINE_IDLE_MINUTES = "5";
    expect(idleMinutes()).toBe(5);
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
