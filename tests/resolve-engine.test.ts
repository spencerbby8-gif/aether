import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverAlive,
  getEngineLinks,
  isEngineAlive,
  killAllEngines,
  resetDiscoveryCache,
  resolveEngine,
} from "@/server/engine/resolve";

/**
 * Tests for resolve.ts — the faithful control layer (port of the verified
 * ensure-alive.js / engine-off.js). Uses a mocked global fetch so no real
 * Kaggle/beacon traffic is generated; the fetch surface matches what
 * resolve.ts actually calls (webhook.site + ntfy beacons, /api/ps, Kaggle
 * kernels/status + kernels/push, and {engineUrl}/off).
 */

const REAL_ENV = { ...process.env };

const LIVE_URL = "https://alive-engine.trycloudflare.com";
const LIVE_URL_B = "https://beta-engine.trycloudflare.com";

/* Beacon payload in the shape resolve.ts parses (webhook.site request list). */
function beaconWith(liveUrl: string | null) {
  if (!liveUrl) return { data: [] };
  return {
    data: [
      {
        query: { m: `AGENT LIVE LINK: ${liveUrl} (tools: web_search fetch_page crawl_site run_command)` },
        created_at: new Date().toISOString(),
      },
    ],
  };
}

interface MockOptions {
  aliveUrls?: string[]; // urls whose /api/ps returns 200 + models[]
  beaconUrl?: string | null; // LIVE LINK advertised on the beacons
  kernelStatus?: string | null; // Kaggle kernels/status .status
  pushOutcome?: "ok" | "quota" | "error"; // Kaggle kernels/push result
}

function installFetch(opts: MockOptions) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);

    if (url.startsWith("https://webhook.site/")) {
      return new Response(JSON.stringify(beaconWith(opts.beaconUrl ?? null)), { status: 200 });
    }
    if (url.startsWith("https://ntfy.sh/")) {
      return new Response("", { status: 200 });
    }
    if (url.endsWith("/api/ps")) {
      const alive = (opts.aliveUrls ?? []).some((u) => url.startsWith(u));
      return alive
        ? new Response(JSON.stringify({ models: [{ name: "model" }] }), { status: 200 })
        : new Response("{}", { status: 503 });
    }
    if (url.includes("/kernels/status")) {
      return new Response(JSON.stringify({ status: opts.kernelStatus ?? "complete" }), { status: 200 });
    }
    if (url.includes("/kernels/push")) {
      if (opts.pushOutcome === "quota") {
        return new Response(JSON.stringify({ error: "Maximum weekly GPU quota reached" }), { status: 403 });
      }
      if (opts.pushOutcome === "error") {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return new Response(JSON.stringify({ url: "kaggle.kernel/ok" }), { status: 200 });
    }
    if (url.endsWith("/off")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function setEnv(a = true, b = true) {
  if (a) {
    process.env.KAGGLE_USERNAME = "user-a";
    process.env.KAGGLE_KEY = "key-a";
  } else {
    delete process.env.KAGGLE_USERNAME;
    delete process.env.KAGGLE_KEY;
  }
  if (b) {
    process.env.KAGGLE_USERNAME_B = "user-b";
    process.env.KAGGLE_KEY_B = "key-b";
  } else {
    delete process.env.KAGGLE_USERNAME_B;
    delete process.env.KAGGLE_KEY_B;
  }
}

beforeEach(() => {
  setEnv(true, true);
  /* Beacons are env-configured now (audit C2); point them at the stubbed hosts. */
  process.env.BEACON_URL = "https://webhook.site/token/test";
  process.env.BEACON_BACKUP_URL = "https://ntfy.sh/test/json?poll=1";
  delete process.env.BEACON_SECRET;
  delete process.env.ENGINE_URL_A;
  delete process.env.ENGINE_URL_B;
  delete process.env.ENGINE_URL_C;
  vi.unstubAllGlobals();
  resetDiscoveryCache(); // never let one scenario's discovery leak into the next
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in REAL_ENV)) delete process.env[key];
  Object.assign(process.env, REAL_ENV);
  vi.unstubAllGlobals();
});

describe("resolveEngine — discovery + wake", () => {
  it("returns an already-alive engine without pushing", async () => {
    const calls = installFetch({ aliveUrls: [LIVE_URL], beaconUrl: LIVE_URL });
    const result = await resolveEngine();
    expect(result.status).toBe("alive");
    expect(result.url).toBe(LIVE_URL);
    expect(calls.some((c) => c.includes("/api/ps"))).toBe(true);
    expect(calls.some((c) => c.includes("/kernels/push"))).toBe(false); // no wake needed
  });

  it("wakes when nothing is alive (push sent, status waking)", async () => {
    const calls = installFetch({ aliveUrls: [], beaconUrl: null, pushOutcome: "ok", kernelStatus: "complete" });
    const result = await resolveEngine();
    expect(result.status).toBe("waking");
    expect(calls.some((c) => c.includes("/kernels/push"))).toBe(true);
  });

  it("reports waking when a kernel is already queued", async () => {
    installFetch({ aliveUrls: [], beaconUrl: null, kernelStatus: "queued" });
    const result = await resolveEngine();
    expect(result.status).toBe("waking");
    expect(result.reason).toContain("queued");
  });
});

describe("resolveEngine — A→B quota failover + strict routing", () => {
  it("fails over A→B when account A is out of quota (AUTO)", async () => {
    /* Account A push returns quota error; account B succeeds. We assert the
       push was attempted for both accounts (A then B). */
    const calls = installFetch({ aliveUrls: [], beaconUrl: null, kernelStatus: "complete", pushOutcome: "quota" });
    const result = await resolveEngine(); // auto → tries A then B, both quota
    expect(result.status).toBe("error");
    expect(result.message).toContain("quota");
    const pushes = calls.filter((c) => c.includes("/kernels/push"));
    expect(pushes.length).toBe(2); // A then B (both quota-blocked here)
  });

  it("strict account='b' never pushes account A", async () => {
    const calls = installFetch({ aliveUrls: [], beaconUrl: null, kernelStatus: "complete", pushOutcome: "ok" });
    const result = await resolveEngine("b");
    expect(result.status).toBe("waking");
    const pushes = calls.filter((c) => c.includes("/kernels/push"));
    expect(pushes.length).toBe(1);
    /* Only account B's credentials should appear (Bearer key-b). */
    expect(pushes.length).toBe(1);
  });

  it("strict account='a' with missing A creds errors honestly", async () => {
    setEnv(false, true); // only B configured
    installFetch({ aliveUrls: [], beaconUrl: null });
    const result = await resolveEngine("a");
    expect(result.status).toBe("error");
    expect(result.message).toContain("KAGGLE_KEY");
  });

  it("errors when no accounts are configured", async () => {
    setEnv(false, false);
    installFetch({});
    const result = await resolveEngine();
    expect(result.status).toBe("error");
  });
});

describe("getEngineLinks + isEngineAlive", () => {
  it("extracts trycloudflare LIVE LINKs from the webhook.site beacon", async () => {
    installFetch({ beaconUrl: LIVE_URL, aliveUrls: [LIVE_URL] });
    const links = await getEngineLinks();
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].url).toBe(LIVE_URL);
  });

  it("isEngineAlive is true only for 200 + non-empty models[]", async () => {
    installFetch({ aliveUrls: [LIVE_URL] });
    expect(await isEngineAlive(LIVE_URL)).toBe(true);
    expect(await isEngineAlive("https://dead.trycloudflare.com")).toBe(false);
  });
});

describe("discoverAlive — read-only engine status (never wakes)", () => {
  it("reports an alive engine with its URL", async () => {
    const calls = installFetch({ beaconUrl: LIVE_URL, aliveUrls: [LIVE_URL] });
    const result = await discoverAlive();
    expect(result.alive).toBe(true);
    expect(result.url).toBe(LIVE_URL);
    expect(calls.some((c) => c.includes("/kernels/push"))).toBe(false); // never wakes
  });

  it("reports not-alive when no engine responds", async () => {
    installFetch({ beaconUrl: null, aliveUrls: [] });
    const result = await discoverAlive();
    expect(result.alive).toBe(false);
    expect(result.url).toBeNull();
  });
});

describe("killAllEngines — engine-off", () => {
  it("POSTs /off with the key to every alive engine", async () => {
    process.env.ENGINE_OFF_KEY = "off-secret";
    const calls = installFetch({ beaconUrl: LIVE_URL, aliveUrls: [LIVE_URL] });
    const result = await killAllEngines();
    expect(result.status).toBe("off");
    expect(result.killed.some((k) => k.result === "shutdown")).toBe(true);
    const offCall = calls.find((c) => c.includes("/off"));
    expect(offCall).toBeTruthy();
  });

  it("reports no engines when none are alive", async () => {
    process.env.ENGINE_OFF_KEY = "off-secret";
    installFetch({ beaconUrl: null, aliveUrls: [] });
    const result = await killAllEngines();
    expect(result.status).toBe("off");
    expect(result.killed.length).toBe(0);
  });

  it("errors when ENGINE_OFF_KEY is not set", async () => {
    delete process.env.ENGINE_OFF_KEY;
    installFetch({ beaconUrl: LIVE_URL });
    const result = await killAllEngines();
    expect(result.status).toBe("error");
    expect(result.message).toContain("ENGINE_OFF_KEY");
  });
});
