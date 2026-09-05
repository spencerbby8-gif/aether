import { afterEach, describe, expect, it } from "vitest";
import { EngineManager } from "@/server/engine/manager";
import { BEACON_BACKUP, BEACON_URL, DEFAULT_IDLE_MINUTES, idleMinutes } from "@/server/engine/contract";

/** Scripted fetch: health checks + beacons + engine off endpoints. */
function scriptedFetch(routes: {
  healthy?: string[]; // URLs whose /api/ps returns 200
  beacon?: { liveUrl?: string; off?: boolean; tag?: "a" | "b" } | "error";
}) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(`${BEACON_URL}/requests`)) {
      if (routes.beacon === "error") return new Response("boom", { status: 500 });
      const beacon = routes.beacon;
      const tag = beacon?.tag ?? "a";
      const data = beacon?.liveUrl
        ? [{ url: `https://webhook.site/x?m=${encodeURIComponent(`engine=${tag} alive: ${beacon.liveUrl} (idle 0 min)`)}`, created_at: new Date().toISOString() }]
        : beacon?.off
          ? [{ url: "https://webhook.site/x?m=ENGINE+OFF+via+UI", created_at: new Date().toISOString() }]
          : [];
      return Response.json({ data });
    }
    if (url === BEACON_BACKUP) return new Response("", { status: 200 });
    if (url.endsWith("/api/ps")) {
      const base = url.slice(0, -"/api/ps".length);
      return new Response(routes.healthy?.includes(base) ? '{"models":[]}' : "nope", {
        status: routes.healthy?.includes(base) ? 200 : 503,
      });
    }
    if (url.endsWith("/api/off")) return new Response("{}", { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const TUNNEL_A = "https://alpha.trycloudflare.com";
const TUNNEL_B = "https://beta.trycloudflare.com";

describe("EngineManager — resolution (the contract order)", () => {
  it("resolves through the beacon when no cached URL is healthy", async () => {
    const { impl, calls } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    const result = await manager.resolve();
    expect(result.state).toBe("alive");
    expect(result.url).toBe(TUNNEL_A);
    expect(calls.some((c) => c.startsWith(BEACON_URL))).toBe(true);
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
});

describe("EngineManager — wake, failover, shutdown", () => {
  it("wake resolves an already-alive engine without touching Kaggle", async () => {
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    const result = await manager.wake("a");
    expect(result.state).toBe("alive");
    expect(result.url).toBe(TUNNEL_A);
  });

  it("wake reports the honest error state when the control plane lacks credentials", async () => {
    const { impl } = scriptedFetch({ healthy: [], beacon: { off: true } });
    const manager = new EngineManager({ fetchImpl: impl });
    const result = await manager.wake("a");
    expect(["error", "off"]).toContain(result.state);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("fails over to the other engine when the active one is dead", async () => {
    /* Two-phase world: A announces and is healthy; then A dies and B announces. */
    let healthy = [TUNNEL_A];
    let beaconMsg = `engine=a alive: ${TUNNEL_A} (idle 0 min)`;
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`${BEACON_URL}/requests`)) {
        return Response.json({ data: [{ url: `https://webhook.site/x?m=${encodeURIComponent(beaconMsg)}`, created_at: new Date().toISOString() }] });
      }
      if (url === BEACON_BACKUP) return new Response("", { status: 200 });
      if (url.endsWith("/api/ps")) {
        const base = url.slice(0, -"/api/ps".length);
        return new Response(healthy.includes(base) ? '{"models":[]}' : "nope", { status: healthy.includes(base) ? 200 : 503 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const manager = new EngineManager({ fetchImpl: impl });
    const first = await manager.resolve();
    expect(first.state).toBe("alive");
    expect(first.url).toBe(TUNNEL_A);

    /* A's tunnel dies; B announces a fresh tagged tunnel. */
    healthy = [TUNNEL_B];
    beaconMsg = `engine=b alive: ${TUNNEL_B} (idle 0 min)`;
    manager.reportFailure("a");
    const failover = await manager.failover("a");
    expect(failover.state).toBe("alive");
    expect(failover.url).toBe(TUNNEL_B);
    expect(failover.slot).toBe("b");
    expect(manager.snapshot().active).toBe("b");
  });

  it("refuses shutdown while an operation is active", async () => {
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    await manager.resolve();
    manager.beginOperation();
    const refused = await manager.off("both");
    expect(refused.ok).toBe(false);
    manager.endOperation();
    const accepted = await manager.off("both");
    expect(accepted.ok).toBe(true);
    expect(accepted.results.a).toMatch(/off-accepted|no-url|already-off/);
    expect(manager.snapshot().engines.a.state).toBe("off");
    expect(manager.snapshot().engines.b.state).toBe("off");
  });

  it("shuts down both engines at once and records the results", async () => {
    const { impl, calls } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl });
    await manager.resolve();
    const result = await manager.off("both");
    expect(result.ok).toBe(true);
    expect(Object.keys(result.results)).toEqual(["a", "b", "c"]);
    expect(calls.some((c) => c === `${TUNNEL_A}/api/off`)).toBe(true);
  });
});

describe("EngineManager — idle shutdown", () => {
  afterEach(() => {
    delete process.env.ENGINE_IDLE_MINUTES;
  });

  it("production default is exactly 20 minutes", () => {
    expect(DEFAULT_IDLE_MINUTES).toBe(20);
    expect(idleMinutes()).toBe(20);
  });

  it("auto-shuts down both engines after the idle limit of true inactivity", async () => {
    process.env.ENGINE_IDLE_MINUTES = "1"; // controlled short interval (60s)
    let clock = 1_000_000;
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl, now: () => clock });
    await manager.resolve();
    expect(manager.snapshot().engines.a.state).toBe("alive");

    /* No activity, time advances past the limit → idle-off fires. */
    clock += 60_000;
    const fired = await manager.idleCheck();
    expect(fired).toBe(true);
    expect(manager.snapshot().engines.a.state).toBe("off");
  });

  it("meaningful activity resets the idle timer; state reads do not matter", async () => {
    process.env.ENGINE_IDLE_MINUTES = "1"; // controlled: 60s limit
    let clock = 1_000_000;
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl, now: () => clock });
    await manager.resolve();
    clock += 30_000;
    manager.touch(); // chat/tool activity
    clock += 30_000;
    const fired = await manager.idleCheck();
    expect(fired).toBe(false); // 30s since last activity < 60s limit
    expect(manager.snapshot().engines.a.state).toBe("alive");
    clock += 61_000;
    const firedLater = await manager.idleCheck();
    expect(firedLater).toBe(true); // now past the limit → shutdown
  });

  it("never idle-shuts down while an operation is in flight", async () => {
    process.env.ENGINE_IDLE_MINUTES = "1";
    let clock = 1_000_000;
    const { impl } = scriptedFetch({ healthy: [TUNNEL_A], beacon: { liveUrl: TUNNEL_A } });
    const manager = new EngineManager({ fetchImpl: impl, now: () => clock });
    await manager.resolve();
    manager.beginOperation();
    clock += 999_000;
    const fired = await manager.idleCheck();
    expect(fired).toBe(false);
    expect(manager.snapshot().engines.a.state).toBe("alive");
    manager.endOperation();
  });
});
