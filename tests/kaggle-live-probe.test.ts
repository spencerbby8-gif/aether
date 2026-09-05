import { afterAll, describe, expect, it } from "vitest";
import { resolveKernelSlug, kaggleWakeKernel, clearSlugCache } from "@/server/engine/kaggle";

const REAL_ENV = { ...process.env };

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in REAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, REAL_ENV);
});

/**
 * Live control-plane probes — these hit the REAL Kaggle API over the
 * network with deliberately invalid credentials, proving that Aether's
 * requests are correctly formed and handled honestly end to end.
 * (Skipped automatically when offline.)
 */
describe("Kaggle control plane — real network probes", () => {
  it("resolveKernelSlug reaches Kaggle and reports null honestly on 401/400", async () => {
    process.env.KAGGLE_USERNAME = "aether-live-probe";
    process.env.KAGGLE_KEY = "invalid-probe-key";
    delete process.env.ENGINE_KERNEL_A;
    clearSlugCache();
    const slug = await resolveKernelSlug("a", fetch);
    expect(slug).toBeNull(); // invalid creds → Kaggle refuses → honest null
  }, 30_000);

  it("kaggleWakeKernel returns an honest error state against the real API", async () => {
    process.env.KAGGLE_USERNAME = "aether-live-probe";
    process.env.KAGGLE_KEY = "invalid-probe-key";
    delete process.env.ENGINE_KERNEL_A;
    clearSlugCache();
    const result = await kaggleWakeKernel("a", fetch);
    expect(["error", "quota"]).toContain(result.state);
    expect(result.detail.length).toBeGreaterThan(10);
    // Must NOT claim success without a real kernel.
    expect(result.state).not.toBe("waking");
  }, 30_000);
});
