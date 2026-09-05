import { afterAll, describe, expect, it } from "vitest";
import { resetDiscoveryCache, wakeSlot } from "@/server/engine/resolve";

const REAL_ENV = { ...process.env };

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in REAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, REAL_ENV);
});

/**
 * Live control-plane probes — these hit the REAL Kaggle API over the network
 * with deliberately invalid credentials, proving that Aether's requests are
 * correctly formed and handled honestly end to end.
 *
 * Updated for the unified control plane (audit R2): there is now ONE Kaggle
 * client, in resolve.ts, using `Authorization: Bearer <key>` and a camelCase
 * push body. The old Basic-auth/snake_case client in kaggle.ts is gone.
 */
describe("Kaggle control plane — real network probes", () => {
  it("wakeSlot reports an honest error state against the real API", async () => {
    process.env.KAGGLE_USERNAME = "aether-live-probe";
    process.env.KAGGLE_KEY = "invalid-probe-key";
    delete process.env.ENGINE_KERNEL_A;
    resetDiscoveryCache();

    const result = await wakeSlot("a");
    expect(["error", "quota"]).toContain(result.state);
    expect(result.detail.length).toBeGreaterThan(5);
    /* Must NOT claim a kernel is booting when Kaggle refused the credentials. */
    expect(result.state).not.toBe("waking");
  }, 30_000);

  it("reports a missing-credential error without touching the network", async () => {
    delete process.env.KAGGLE_USERNAME_C;
    delete process.env.KAGGLE_KEY_C;
    resetDiscoveryCache();

    const result = await wakeSlot("c");
    expect(result.state).toBe("error");
    expect(result.detail).toMatch(/KAGGLE_KEY_C/i);
    /* No credential value may appear in the message. */
    expect(result.detail).not.toMatch(/invalid-probe-key/);
  }, 30_000);
});
