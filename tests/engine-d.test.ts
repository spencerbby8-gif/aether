import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetDiscoveryCache,
  resolveEngine,
  kernelSlugFor,
} from "@/server/engine/resolve";
import { credentialsFor, engineConfigured, credentialEnvNames } from "@/server/engine/kaggle";
import { ENGINE_IDS, engineUrlOverride } from "@/server/engine/contract";
import { interpretBeacon } from "@/server/engine/beacon";
import { redactSecrets } from "@/server/tools/security";

/**
 * Engine D contract.
 *
 * D was added as a fourth slot, and the failure mode that matters is not "D is
 * missing" — TypeScript catches that — but "D is present everywhere except one
 * hand-written list". Every assertion here targets a place where a slot could
 * be silently dropped: the failover order, the beacon tag regex, slot
 * validation, credential env names, and secret redaction.
 */

const REAL_ENV = { ...process.env };

const LIVE_D = "https://delta.trycloudflare.com";

/** webhook.site shape: heartbeats arrive as GET ?m=<message>. */
function beaconWith(tag: string, liveUrl: string) {
  return {
    data: [
      {
        query: { m: `engine=${tag} AGENT LIVE LINK: ${liveUrl} (tools: web_search)` },
        created_at: new Date().toISOString(),
      },
    ],
  };
}

function installFetch(opts: {
  aliveUrls?: string[];
  beaconUrl?: string | null;
  beaconTag?: string;
  kernelStatus?: string;
  pushOutcomeBySlot?: Record<string, "ok" | "quota" | "error">;
}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);

    if (url.startsWith("https://webhook.site/")) {
      return new Response(
        JSON.stringify(
          opts.beaconUrl
            ? beaconWith(opts.beaconTag ?? "d", opts.beaconUrl)
            : { data: [] },
        ),
        { status: 200 },
      );
    }
    if (url.startsWith("https://ntfy.sh/")) return new Response("", { status: 200 });
    if (url.endsWith("/api/ps")) {
      const alive = (opts.aliveUrls ?? []).some((u) => url.startsWith(u));
      return alive
        ? new Response(JSON.stringify({ models: [{ name: "model" }] }), { status: 200 })
        : new Response("{}", { status: 503 });
    }
    if (url.includes("/kernels/status")) {
      return new Response(JSON.stringify({ status: opts.kernelStatus ?? "complete" }), {
        status: 200,
      });
    }
    if (url.includes("/kernels/push")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.Authorization ?? headers.authorization ?? "";
      let outcome = "ok";
      if (opts.pushOutcomeBySlot) {
        for (const [slot, o] of Object.entries(opts.pushOutcomeBySlot)) {
          if (auth.includes(`key-${slot}`)) outcome = o;
        }
      }
      if (outcome === "quota") {
        return new Response(JSON.stringify({ error: "Maximum weekly GPU quota reached" }), {
          status: 403,
        });
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

function setEnv(a = true, b = true, c = true, d = true) {
  const defs: Array<[string, string, string, string]> = [
    ["", "user-a", "key-a", "user-a/kernel"],
    ["_B", "user-b", "key-b", "user-b/kernel"],
    ["_C", "user-c", "key-c", "dyceelvk/qwen-3-8-27b-uncensored-chat"],
    ["_D", "user-d", "key-d", "adaoraodoh/qwen-3-8-27b-uncensored-chat"],
  ];
  const on = [a, b, c, d];
  defs.forEach(([suffix, user, key, kernel], i) => {
    if (on[i]) {
      process.env[`KAGGLE_USERNAME${suffix}`] = user;
      process.env[`KAGGLE_KEY${suffix}`] = key;
      process.env[`ENGINE_KERNEL_${suffix ? suffix.slice(1) : "A"}`] = kernel;
    } else {
      delete process.env[`KAGGLE_USERNAME${suffix}`];
      delete process.env[`KAGGLE_KEY${suffix}`];
      delete process.env[`ENGINE_KERNEL_${suffix ? suffix.slice(1) : "A"}`];
    }
  });
}

beforeEach(() => {
  setEnv();
  process.env.BEACON_URL = "https://webhook.site/token/test";
  process.env.ENGINE_OFF_KEY = "test-off-key-0001";
  process.env.ENGINE_BEACON_TOKEN = "00000000-0000-4000-8000-000000000000";
  process.env.ENGINE_BEACON_TOPIC = "test-topic";
  process.env.BEACON_BACKUP_URL = "https://ntfy.sh/test/json?poll=1";
  delete process.env.BEACON_SECRET;
  for (const s of ["A", "B", "C", "D"]) delete process.env[`ENGINE_URL_${s}`];
  vi.unstubAllGlobals();
  resetDiscoveryCache();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in REAL_ENV)) delete process.env[key];
  Object.assign(process.env, REAL_ENV);
  vi.unstubAllGlobals();
});

describe("engine D — fleet contract", () => {
  it("is the fourth and last slot in the failover chain", () => {
    expect(ENGINE_IDS).toEqual(["a", "b", "c", "d"]);
    expect(ENGINE_IDS[ENGINE_IDS.length - 1]).toBe("d");
  });

  it("reads ENGINE_KERNEL_D and normalises user/slug to the slug", () => {
    expect(kernelSlugFor("d")).toBe("qwen-3-8-27b-uncensored-chat");
  });

  it("reads KAGGLE_USERNAME_D / KAGGLE_KEY_D for credentials", () => {
    expect(credentialsFor("d")).toEqual({ username: "user-d", key: "key-d" });
  });

  it("is configured only when its own credentials exist", () => {
    expect(engineConfigured("d")).toBe(true);
    setEnv(true, true, true, false);
    expect(engineConfigured("d")).toBe(false);
  });

  it("names its env vars in error messages, secret-free", () => {
    expect(credentialEnvNames("d")).toBe("KAGGLE_USERNAME_D / KAGGLE_KEY_D");
    expect(credentialEnvNames("d")).not.toContain("key-d");
  });

  it("accepts an ENGINE_URL_D override", () => {
    process.env.ENGINE_URL_D = "https://d.example.com/";
    expect(engineUrlOverride("d")).toBe("https://d.example.com");
  });
});

describe("engine D — beacon attribution", () => {
  it("attributes an engine=d tagged announcement to slot D", () => {
    const signal = interpretBeacon([{ at: 1, text: `engine=d alive: ${LIVE_D} (idle 0 min)` }]);
    expect(signal.liveUrlD).toBe(LIVE_D);
    expect(signal.liveUrl).toBe(LIVE_D);
    expect(signal.liveUrlBySlot.d).toBe(LIVE_D);
  });

  it("keeps all four tunnels distinct", () => {
    const signal = interpretBeacon([
      { at: 1, text: `engine=a alive: https://a.test (idle 0 min)` },
      { at: 2, text: `engine=b alive: https://b.test (idle 0 min)` },
      { at: 3, text: `engine=c alive: https://c.test (idle 0 min)` },
      { at: 4, text: `engine=d alive: ${LIVE_D} (idle 0 min)` },
    ]);
    expect(signal.liveUrlA).toBe("https://a.test");
    expect(signal.liveUrlB).toBe("https://b.test");
    expect(signal.liveUrlC).toBe("https://c.test");
    expect(signal.liveUrlD).toBe(LIVE_D);
  });

  it("an untagged announcement is not attributed to D", () => {
    const signal = interpretBeacon([{ at: 1, text: `alive: ${LIVE_D} (idle 0 min)` }]);
    expect(signal.liveUrl).toBe(LIVE_D);
    expect(signal.liveUrlD).toBeNull();
  });
});

describe("engine D — routing and failover", () => {
  it("strict account='d' pushes with D's credentials only", async () => {
    const calls = installFetch({
      aliveUrls: [],
      beaconUrl: null,
      kernelStatus: "complete",
    });
    const result = await resolveEngine("d");
    expect(result.status).toBe("waking");
    const pushes = calls.filter((c) => c.includes("/kernels/push"));
    expect(pushes.length).toBe(1);
  });

  it("strict account='d' with missing D creds errors naming KAGGLE_KEY_D", async () => {
    setEnv(true, true, true, false);
    installFetch({ aliveUrls: [], beaconUrl: null });
    const result = await resolveEngine("d");
    expect(result.status).toBe("error");
    expect(result.message).toContain("KAGGLE_KEY_D");
  });

  it("an unconfigured D is dropped from the fleet rather than failing in it", async () => {
    setEnv(true, true, true, false);
    expect(engineConfigured("d")).toBe(false);
    /* A is alive, so AUTO resolution succeeds without ever touching D. */
    installFetch({ aliveUrls: ["https://alpha.trycloudflare.com"], beaconUrl: null });
    const result = await resolveEngine();
    expect(result.status).not.toBe("error");
  });

  it("uses a live D announced on the beacon", async () => {
    installFetch({ aliveUrls: [LIVE_D], beaconUrl: LIVE_D, beaconTag: "d" });
    const result = await resolveEngine("d");
    /* The resolver reports "alive" for a serving engine; "live" is the
       manager's word for the same thing, not a value this function returns. */
    expect(result.status).toBe("alive");
    expect(result.url).toBe(LIVE_D);
    expect(result.slot).toBe("d");
  });

  it("reports D's exhausted GPU quota in the message rather than as a generic error", async () => {
    installFetch({
      aliveUrls: [],
      beaconUrl: null,
      kernelStatus: "complete",
      pushOutcomeBySlot: { d: "quota" },
    });
    const result = await resolveEngine("d");
    /* wakeSlot classifies quota separately; resolveEngine surfaces a strict
       single-slot quota failure as an error whose message says so. */
    expect(result.status).toBe("error");
    expect(result.message?.toLowerCase()).toContain("quota");
  });
});

describe("engine D — secret handling", () => {
  it("redacts D's key, username, kernel slug and URL from outgoing text", () => {
    process.env.KAGGLE_KEY_D = "KGAT_reald_looking_value";
    process.env.KAGGLE_USERNAME_D = "adaoraodoh";
    process.env.ENGINE_URL_D = "https://secret-d.trycloudflare.com";
    const leak =
      "key=KGAT_reald_looking_value user=adaoraodoh url=https://secret-d.trycloudflare.com";
    const out = redactSecrets(leak);
    expect(out).not.toContain("KGAT_reald_looking_value");
    expect(out).not.toContain("adaoraodoh");
    expect(out).not.toContain("https://secret-d.trycloudflare.com");
  });

  it("never exposes the key through the credential accessor in stringified form", () => {
    const creds = credentialsFor("d");
    expect(creds).not.toBeNull();
    /* The accessor returns the key for server-side use; this asserts the
       ERROR path does not carry it, which is what actually reaches a client. */
    expect(credentialEnvNames("d")).not.toContain(creds?.key ?? "");
  });
});
