// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { engineOff, engineStatus, engineWake } from "@/lib/engine-client";

/**
 * Regression tests for the "engine switch stuck loading forever" bug.
 *
 * Root cause: the power button awaited engineWake() which had NO timeout, so a
 * hung or host-killed request left powerBusy true forever — the spinner never
 * cleared. The fix gives every engine request an AbortSignal timeout AND makes
 * the wake non-blocking. These tests pin the timeout behaviour using a fetch
 * stub that honours abort exactly like the real browser fetch.
 */

const FAST = 40; // ms — short ceiling so tests run instantly

/** A fetch stub that behaves like the real one: rejects on abort. */
function hangingFetch(): typeof fetch {
  const impl = (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        });
      }
      /* never resolves otherwise — simulates a killed/hung server function */
    });
  return impl as unknown as typeof fetch;
}

/** A fetch stub that resolves after `ms`, honouring abort. */
function slowFetch(ms: number, body = { status: "alive", url: "https://x.example" }): typeof fetch {
  const impl = (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }, ms);
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        });
      }
    });
  return impl as unknown as typeof fetch;
}

describe("engine request timeouts — the switch can never hang forever", () => {
  it("engineWake rejects when the server never responds", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await expect(engineWake(undefined, FAST)).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it("engineWake rejects when the server is slower than the ceiling", async () => {
    vi.stubGlobal("fetch", slowFetch(5_000)); // 5s server vs 40ms ceiling
    const start = Date.now();
    await expect(engineWake(undefined, FAST)).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1_000);
    vi.unstubAllGlobals();
  });

  it("engineStatus rejects when the server never responds", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await expect(engineStatus(FAST)).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it("engineOff rejects when the server never responds", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await expect(engineOff(FAST)).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it("a prompt response still resolves normally", async () => {
    vi.stubGlobal("fetch", slowFetch(1));
    const result = await engineWake(undefined, FAST);
    expect(result.status).toBe("alive");
    vi.unstubAllGlobals();
  });

  it("the production timeout is finite (never an unbounded request)", async () => {
    const { ENGINE_REQUEST_TIMEOUT_MS } = await import("@/lib/engine-client");
    expect(Number.isFinite(ENGINE_REQUEST_TIMEOUT_MS)).toBe(true);
    expect(ENGINE_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ENGINE_REQUEST_TIMEOUT_MS).toBeLessThan(120_000);
  });
});
