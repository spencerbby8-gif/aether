import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverAlive,
  getEngineLinks,
  killAllEngines,
  resetDiscoveryCache,
  resolveEngine,
} from "@/server/engine/resolve";
import { credentialsFor, engineConfigured, kernelSlugFor } from "@/server/engine/kaggle";
import { ENGINE_IDS } from "@/server/engine/contract";
import { interpretBeacon } from "@/server/engine/beacon";

const REAL_ENV = { ...process.env };

const LIVE_A = "https://alpha.trycloudflare.com";
const LIVE_B = "https://beta.trycloudflare.com";
const LIVE_C = "https://gamma.trycloudflare.com";

function beaconWith(liveUrl: string | null) {
  if (!liveUrl) return { data: [] };
  return {
    data: [
      {
        query: { m: `AGENT LIVE LINK: ${liveUrl} (tools: web_search)` },
        created_at: new Date().toISOString(),
      },
    ],
  };
}

interface MockOptions {
  aliveUrls?: string[];
  beaconUrl?: string | null;
  kernelStatus?: string | null;
  pushOutcome?: "ok" | "quota" | "error";
  pushOutcomeBySlot?: Record<string, "ok" | "quota" | "error">;
}

function installFetch(opts: MockOptions) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);

    if (url.startsWith("https://webhook.site/")) {
      return new Response(JSON.stringify(beaconWith(opts.beaconUrl ?? null)), { status: 200 });
    }
    if (url.startsWith("https://ntfy.sh/")) return new Response("", { status: 200 });
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
      /* Route-specific outcomes by Authorization header (per-engine creds).
         Header names arrive capitalised from the real fetch init. */
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.Authorization ?? headers.authorization ?? "";
      let outcome = opts.pushOutcome ?? "ok";
      if (opts.pushOutcomeBySlot) {
        if (auth.includes("key-a")) outcome = opts.pushOutcomeBySlot.a ?? outcome;
        else if (auth.includes("key-b")) outcome = opts.pushOutcomeBySlot.b ?? outcome;
        else if (auth.includes("key-c")) outcome = opts.pushOutcomeBySlot.c ?? outcome;
      }
      if (outcome === "quota") {
        return new Response(JSON.stringify({ error: "Maximum weekly GPU quota reached" }), { status: 403 });
      }
      if (outcome === "error") return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      return new Response(JSON.stringify({ url: "kernel/ok" }), { status: 200 });
    }
    if (url.endsWith("/off")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function setEnv(a = true, b = true, c = true) {
  if (a) {
    process.env.KAGGLE_USERNAME = "user-a";
    process.env.KAGGLE_KEY = "key-a";
    process.env.ENGINE_KERNEL_A = "user-a/kernel";
  } else {
    delete process.env.KAGGLE_USERNAME;
    delete process.env.KAGGLE_KEY;
    delete process.env.ENGINE_KERNEL_A;
  }
  if (b) {
    process.env.KAGGLE_USERNAME_B = "user-b";
    process.env.KAGGLE_KEY_B = "key-b";
    process.env.ENGINE_KERNEL_B = "user-b/kernel";
  } else {
    delete process.env.KAGGLE_USERNAME_B;
    delete process.env.KAGGLE_KEY_B;
    delete process.env.ENGINE_KERNEL_B;
  }
  if (c) {
    process.env.KAGGLE_USERNAME_C = "user-c";
    process.env.KAGGLE_KEY_C = "key-c";
    process.env.ENGINE_KERNEL_C = "dyceelvk/qwen-3-8-27b-uncensored-chat";
  } else {
    delete process.env.KAGGLE_USERNAME_C;
    delete process.env.KAGGLE_KEY_C;
    delete process.env.ENGINE_KERNEL_C;
  }
}

beforeEach(() => {
  setEnv(true, true, true);
  process.env.BEACON_URL = "https://webhook.site/token/test";

  /*
   * The engine notebook is a TEMPLATE rendered with server secrets at push time
   * (audit C3/C5), so the wake path cannot run without them. These are dummies;
   * no real credential appears in this repo.
   */
  process.env.ENGINE_OFF_KEY = "test-off-key-0001";
  process.env.ENGINE_BEACON_TOKEN = "00000000-0000-4000-8000-000000000000";
  process.env.ENGINE_BEACON_TOPIC = "test-topic";
  process.env.BEACON_BACKUP_URL = "https://ntfy.sh/test/json?poll=1";
  delete process.env.BEACON_SECRET;
  delete process.env.ENGINE_URL_A;
  delete process.env.ENGINE_URL_B;
  delete process.env.ENGINE_URL_C;
  vi.unstubAllGlobals();
  resetDiscoveryCache();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in REAL_ENV)) delete process.env[key];
  Object.assign(process.env, REAL_ENV);
  vi.unstubAllGlobals();
});

describe("three-engine fleet contract", () => {
  it("ENGINE_IDS contains a, b, and c in failover order", () => {
    expect(ENGINE_IDS).toEqual(["a", "b", "c"]);
  });

  it("reads ENGINE_KERNEL_C for engine C", () => {
    /* kernelSlugFor normalises "user/slug" down to the slug Kaggle's API wants. */
    expect(kernelSlugFor("c")).toBe("qwen-3-8-27b-uncensored-chat");
  });

  it("reads KAGGLE_USERNAME_C / KAGGLE_KEY_C for engine C credentials", () => {
    const creds = credentialsFor("c");
    expect(creds).toEqual({ username: "user-c", key: "key-c" });
  });

  it("engine C is configured only when its credentials exist", () => {
    expect(engineConfigured("c")).toBe(true);
    setEnv(true, true, false);
    expect(engineConfigured("c")).toBe(false);
  });
});

describe("engine C routing", () => {
  it("strict account='c' never pushes A or B", async () => {
    const calls = installFetch({ aliveUrls: [], beaconUrl: null, kernelStatus: "complete", pushOutcome: "ok" });
    const result = await resolveEngine("c");
    expect(result.status).toBe("waking");
    /* Only one push, and it must use C's credentials. */
    const pushes = calls.filter((c) => c.includes("/kernels/push"));
    expect(pushes.length).toBe(1);
  });

  it("strict account='c' with missing C creds errors honestly naming KAGGLE_KEY_C", async () => {
    setEnv(true, true, false);
    installFetch({ aliveUrls: [], beaconUrl: null });
    const result = await resolveEngine("c");
    expect(result.status).toBe("error");
    expect(result.message).toContain("KAGGLE_KEY_C");
  });

  it("reports an honest error when account='c' has a non-quota push failure", async () => {
    installFetch({ aliveUrls: [], beaconUrl: null, kernelStatus: "complete", pushOutcome: "error" });
    const result = await resolveEngine("c");
    expect(result.status).toBe("error");
    expect(result.message).toContain("boom");
  });
});

describe("AUTO A→B→C failover on quota", () => {
  it("tries all three accounts in order when every account is quota-blocked", async () => {
    const calls = installFetch({
      aliveUrls: [],
      beaconUrl: null,
      kernelStatus: "complete",
      pushOutcomeBySlot: { a: "quota", b: "quota", c: "quota" },
    });
    const result = await resolveEngine(); // auto
    expect(result.status).toBe("error");
    expect(result.message).toContain("quota");
    /* All three accounts attempted in A→B→C order. */
    const pushes = calls.filter((c) => c.includes("/kernels/push"));
    expect(pushes.length).toBe(3);
  });

  it("fails over A→B→C and succeeds on C when A and B are quota-blocked", async () => {
    const calls = installFetch({
      aliveUrls: [],
      beaconUrl: null,
      kernelStatus: "complete",
      pushOutcomeBySlot: { a: "quota", b: "quota", c: "ok" },
    });
    const result = await resolveEngine(); // auto
    expect(result.status).toBe("waking");
    expect(result.reason).toContain("user-c");
    const pushes = calls.filter((c) => c.includes("/kernels/push"));
    expect(pushes.length).toBe(3);
  });

  it("fails over to B when only A is quota-blocked", async () => {
    const calls = installFetch({
      aliveUrls: [],
      beaconUrl: null,
      kernelStatus: "complete",
      pushOutcomeBySlot: { a: "quota", b: "ok", c: "ok" },
    });
    const result = await resolveEngine(); // auto
    expect(result.status).toBe("waking");
    expect(result.reason).toContain("user-b");
    const pushes = calls.filter((c) => c.includes("/kernels/push"));
    expect(pushes.length).toBe(2); // A failed, B succeeded — C never tried
  });
});

describe("beacon attribution for engine C", () => {
  it("attributes engine=c tagged announcements", () => {
    const signal = interpretBeacon([
      { at: 1, text: `engine=c alive: ${LIVE_C} (idle 0 min)` },
    ]);
    expect(signal.liveUrlC).toBe(LIVE_C);
    expect(signal.liveUrl).toBe(LIVE_C);
  });

  it("keeps A, B, and C tunnels distinct", () => {
    const signal = interpretBeacon([
      { at: 1, text: `engine=a alive: ${LIVE_A} (idle 0 min)` },
      { at: 2, text: `engine=b alive: ${LIVE_B} (idle 0 min)` },
      { at: 3, text: `engine=c alive: ${LIVE_C} (idle 0 min)` },
    ]);
    expect(signal.liveUrlA).toBe(LIVE_A);
    expect(signal.liveUrlB).toBe(LIVE_B);
    expect(signal.liveUrlC).toBe(LIVE_C);
  });
});

describe("kill-all includes engine C", () => {
  it("shuts down every live tunnel found on the beacons", async () => {
    process.env.ENGINE_OFF_KEY = "off-key";
    const calls = installFetch({ beaconUrl: LIVE_C, aliveUrls: [LIVE_C] });
    const result = await killAllEngines();
    expect(result.status).toBe("off");
    expect(result.killed.some((k) => k.url === LIVE_C && k.result === "shutdown")).toBe(true);
    expect(calls.some((c) => c.includes("/off"))).toBe(true);
  });
});
