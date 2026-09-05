import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  AETHER_NOTEBOOK_SHA256,
  getAetherNotebook,
} from "@/server/engine/aether-engine-source";

/**
 * Tests for the VERIFIED handoff engine source (aether-engine-source.ts).
 * The module embeds the pinned notebook as Base64 and getAetherNotebook()
 * fails closed: decode Base64 → SHA-256 → compare to the pin → JSON.parse →
 * return, otherwise throw. These tests prove the integrity gate works.
 */

describe("verified engine source — integrity gate", () => {
  it("exposes the pinned SHA-256 constant", () => {
    expect(AETHER_NOTEBOOK_SHA256).toBe("3dc068d15a4c745db14c8c42ba841eca5862406761bff9b0633385848c561ddd");
  });

  it("getAetherNotebook returns the notebook whose SHA-256 matches the pin", () => {
    const notebook = getAetherNotebook(); // throws if tampered
    expect(typeof notebook).toBe("string");
    expect(notebook.length).toBeGreaterThan(1000);
    const hash = createHash("sha256").update(notebook, "utf8").digest("hex");
    expect(hash).toBe(AETHER_NOTEBOOK_SHA256);
  });

  it("the decoded source is a valid Jupyter notebook (JSON with cells)", () => {
    const notebook = getAetherNotebook();
    const parsed = JSON.parse(notebook) as { cells?: unknown; nbformat?: number };
    expect(Array.isArray(parsed.cells)).toBe(true);
    expect(parsed.nbformat).toBe(4);
  });

  it("the decoded notebook is byte-identical to the bundled netlify function notebook", async () => {
    const { readFileSync } = await import("node:fs");
    const bundled = readFileSync("netlify/functions/ensure-alive/notebook.ipynb", "utf8");
    const fromModule = getAetherNotebook();
    const bundledHash = createHash("sha256").update(bundled, "utf8").digest("hex");
    const moduleHash = createHash("sha256").update(fromModule, "utf8").digest("hex");
    expect(moduleHash).toBe(bundledHash);
    expect(bundledHash).toBe(AETHER_NOTEBOOK_SHA256);
  });

  it("notebook byte size is the verified 36,301 bytes", () => {
    const notebook = getAetherNotebook();
    expect(Buffer.byteLength(notebook, "utf8")).toBe(36301);
  });
});
