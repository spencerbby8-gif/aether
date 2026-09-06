import { describe, expect, it } from "vitest";
import { APP_VERSION } from "@/lib/version";
import pkg from "../package.json";

describe("app version (audit §4.8 / A9)", () => {
  it("matches package.json so the UI badge cannot go stale", () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it("is a valid semver string", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});
