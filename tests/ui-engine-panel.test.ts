// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, render, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import { SettingsModal } from "@/components/modals";
import { DEFAULT_SETTINGS } from "@/lib/types";

/**
 * UI PROOF — the real SettingsModal (which contains EnginePanel) rendered in a
 * real DOM, fed by the REAL /api/engine/state over HTTP from a running
 * `next start` and real engine simulators.
 *
 * Nothing about the component or the server is mocked. The only substitution is
 * the DOM itself (jsdom), because this sandbox has no browser.
 *
 * The whole file SKIPS when the proof stack is not running, so `npm test`
 * stays green standalone. Run it via scripts/proofs/ui-proof.sh.
 */

const BASE = process.env.PROOF_BASE ?? "http://127.0.0.1:3111";
const STACK = process.env.PROOF_STACK ?? "http://127.0.0.1:3200";
const TOKEN = process.env.PROOF_TOKEN ?? "proof-control-token-fixed";

const realFetch = globalThis.fetch;

/* Determined at module scope: `describe.skip` is decided during collection,
   long before beforeAll runs, so a flag set in a hook would always read false. */
let live = false;
try {
  const probe = await realFetch(`${process.env.PROOF_BASE ?? "http://127.0.0.1:3111"}/api/health`, {
    signal: AbortSignal.timeout(2_000),
  });
  live = probe.ok;
} catch {
  live = false;
}

async function stack(path: string) {
  return realFetch(`${STACK}${path}`);
}
async function setHealth(slot: "a" | "b", up: boolean) {
  await stack(`/__health?slot=${slot}&up=${up ? 1 : 0}`);
  /* The server caches fleet health briefly; let it expire. */
  await new Promise((r) => setTimeout(r, 6_000));
}

/**
 * Wait until the component has rendered REAL server data.
 *
 * A null snapshot renders every slot as offline/"no url", so waiting on health
 * text alone resolves on the very first paint and asserts on nothing.
 * "Credentials:" only appears once the snapshot has loaded.
 */
async function settled(container: HTMLElement) {
  await waitFor(() => expect(container.textContent).toMatch(/Credentials:/), { timeout: 20_000 });
  /* One more tick so the per-slot health from that snapshot has painted. */
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
}

function renderPanel() {
  return render(
    React.createElement(SettingsModal, {
      settings: DEFAULT_SETTINGS,
      online: true,
      busy: false,
      onClose: () => {},
      onUpdate: () => {},
      onExport: () => {},
      onWipe: () => {},
    }),
  );
}

beforeAll(async () => {
  if (!live) return;

  /* Browser behaviour: relative URLs resolve against the origin, and the
     native shell supplies the control token at runtime. */
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    AetherNative: { controlToken: () => TOKEN },
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/") ? BASE + input : input;
    return realFetch(url as RequestInfo, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

const maybe = live ? describe : describe.skip;

maybe("EnginePanel — truthful per-engine health (audit §4.1 / A1)", () => {
  it("shows a live engine as live, and never renders a tunnel URL", async () => {
    await setHealth("a", true);
    await setHealth("b", true);

    const { container } = renderPanel();
    await settled(container);

    const text = container.textContent ?? "";
    /* A1: health chips come from /api/ps, not from credential presence. */
    expect(text).toMatch(/Engine A/);
    expect(text).toMatch(/Engine B/);
    /* A8: the internal tunnel host must never reach the DOM. */
    expect(text).not.toMatch(/trycloudflare/i);
    /* Credential presence is reported separately from health. */
    expect(text).toMatch(/key set|no key/);
  });

  it("reports a dead engine as offline while another stays live (A1)", async () => {
    await setHealth("a", false);
    await setHealth("b", true);

    const { container } = renderPanel();
    await settled(container);

    const text = container.textContent ?? "";
    /* Both facts must be visible at once: one slot live, one offline. */
    expect(text).toMatch(/offline|no url/);
    expect(text).toMatch(/live/i);
    /* The old badge could not do this: it showed "ready" for both. */
    expect(text).not.toMatch(/No live engine to stop/);
  });

  it("lets you wake B while A is live — manual failover (audit §4.2 / A3)", async () => {
    await setHealth("a", true);
    await setHealth("b", false);

    const { container } = renderPanel();
    await settled(container);

    const buttons = [...container.querySelectorAll("button")].filter((b) =>
      /^(Wake|Waking…|Live)$/.test((b.textContent ?? "").trim()),
    );
    expect(buttons.length).toBe(3);
    const states = buttons.map((b) => ({ label: (b.textContent ?? "").trim(), disabled: (b as HTMLButtonElement).disabled }));
    /* A is live -> its own button is disabled; B is offline -> enabled. */
    expect(states[0]).toEqual({ label: "Live", disabled: true });
    expect(states[1]).toEqual({ label: "Wake", disabled: false });
  });

  it("exposes exactly one shutdown control (audit §4.5 / A4)", async () => {
    await setHealth("a", true);
    await setHealth("b", true);
    const { container } = renderPanel();
    await settled(container);
    const shutdowns = [...container.querySelectorAll("button")].filter((b) =>
      /Shut down all engines|No live engine to stop/.test(b.textContent ?? ""),
    );
    expect(shutdowns.length).toBe(1);
  });

  /*
   * B8 / audit R3: the idle copy must match what the server can actually
   * enforce. A serverless host cannot hold an idle clock, so the panel must not
   * promise a countdown it will never honour.
   */
  it("renders idle copy that matches the server's enforced-by truth (B8)", async () => {
    const res = await fetch(`${BASE}/api/engine/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const snapshot = (await res.json()) as {
      idleOff?: { authoritative: boolean };
      idleLimitMinutes: number;
    };
    const { container } = renderPanel();
    await settled(container);
    const text = container.textContent ?? "";

    if (snapshot.idleOff?.authoritative) {
      expect(text).toMatch(/Auto idle-off after/);
      expect(text).not.toMatch(/enforced by the engine itself/);
    } else {
      expect(text).toMatch(/enforced by\s*the engine itself/);
      expect(text).not.toMatch(/Auto idle-off after/);
    }
  });
});
