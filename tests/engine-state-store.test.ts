import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ENGINE_STATE_VERSION,
  createDurableStore,
  emptyPersistedState,
  fileBackend,
} from "@/server/engine/state-store";

/**
 * Audit R3 / §7 P1 item 9 — server-side lifecycle state lived in module memory,
 * so on a serverless host every fresh instance started from "active = a", an
 * empty push-cooldown map and no bound URLs. Engine selection never persisted
 * and the same Kaggle kernel got pushed again, burning GPU quota.
 *
 * These tests use the REAL file backend against a real temp file. Two separate
 * store instances over one file stand in for two serverless invocations.
 */
describe("durable engine state (audit R3)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-state-"));
    file = path.join(dir, "engine-state.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("carries the active engine and bound URLs into a second instance", async () => {
    const first = createDurableStore(fileBackend(file));
    await first.hydrate();
    first.setActive("b");
    first.set({ id: "b", state: "alive", url: "http://beta.trycloudflare.com", lastSeen: 123 });
    await first.flush();

    /* A brand-new instance: empty module memory, same backing file. */
    const second = createDurableStore(fileBackend(file));
    await second.hydrate();

    expect(second.getActive()).toBe("b");
    expect(second.get().b.url).toBe("http://beta.trycloudflare.com");
    expect(second.get().b.state).toBe("alive");
    /* Untouched slots must still be present and clean. */
    expect(second.get().a).toEqual({ id: "a", state: "off", url: null, lastSeen: null });
  });

  it("carries the push timestamp so a second instance will not re-push", async () => {
    const first = createDurableStore(fileBackend(file));
    await first.hydrate();
    first.setPushAt("b", Date.now());
    await first.flush();

    const second = createDurableStore(fileBackend(file));
    await second.hydrate();

    const at = second.getPushAt("b");
    expect(at).not.toBeNull();
    expect(Date.now() - (at as number)).toBeLessThan(60_000);
  });

  it("re-reads on every hydrate so a warm instance cannot serve stale state", async () => {
    const reader = createDurableStore(fileBackend(file));
    await reader.hydrate();
    expect(reader.getActive()).toBe("a");

    /* Another instance supersedes it while `reader` is still alive. */
    const writer = createDurableStore(fileBackend(file));
    await writer.hydrate();
    writer.setActive("c");
    await writer.flush();

    /* The old hydrate-once behaviour would still report "a" here. */
    await reader.hydrate();
    expect(reader.getActive()).toBe("c");
  });

  it("survives a corrupt file by starting clean instead of throwing", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "{ this is not json", "utf8");

    const store = createDurableStore(fileBackend(file));
    await expect(store.hydrate()).resolves.toBeUndefined();
    expect(store.getActive()).toBe("a");
    expect(store.get().b.state).toBe("off");
  });

  it("rejects a snapshot with the wrong version or a bogus active slot", async () => {
    const bad = emptyPersistedState();
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(file, JSON.stringify({ ...bad, version: 999 }), "utf8");
    let store = createDurableStore(fileBackend(file));
    await store.hydrate();
    expect(store.getActive()).toBe("a");

    fs.writeFileSync(
      file,
      JSON.stringify({ ...bad, version: ENGINE_STATE_VERSION, active: "z" }),
      "utf8",
    );
    store = createDurableStore(fileBackend(file));
    await store.hydrate();
    expect(store.getActive()).toBe("a");
  });

  it("keeps working with no backend at all (memory mode)", async () => {
    const store = createDurableStore(null);
    expect(store.backendLabel).toBe("memory");
    await store.hydrate();
    store.setActive("c");
    expect(store.getActive()).toBe("c");
    await store.flush();
  });
});
