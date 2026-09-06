/**
 * Durable engine state — audit R3 / §7 P1 item 9.
 *
 * The finding: EngineManager kept `engines`, `active` and the push-cooldown
 * timestamps in module memory. On a serverless host every invocation can land
 * on a fresh instance, so:
 *   - `active` reset to "a" each request  -> engine selection never persisted
 *   - the 10-minute push cooldown reset   -> DUPLICATE Kaggle kernel pushes,
 *                                            which burn real GPU quota
 *   - bound tunnel URLs evaporated        -> the same engine got re-discovered
 *                                            and re-pushed
 *
 * The fix keeps the existing synchronous `EngineStateStore` interface — every
 * caller is on a hot path and making them all async would churn code that has
 * nothing to do with this bug — and puts a durable backend behind it. The
 * snapshot is hydrated once per instance and written through on mutation.
 *
 * Backends, chosen by host:
 *   NETLIFY=true            -> Netlify Blobs (the only shared writable store
 *                              available to a Netlify function; its filesystem
 *                              is ephemeral and mostly read-only)
 *   otherwise               -> a JSON file under the workspace root, which is
 *                              what a long-lived Node server and the server
 *                              bundled inside the Android app both have
 *   ENGINE_STATE_BACKEND=memory
 *                           -> the old in-memory behaviour (tests)
 *
 * Durability is best-effort by design: if the backend cannot be read the
 * manager starts from a clean snapshot, and if a write fails it is logged, not
 * thrown. Losing the cooldown costs a redundant kernel push; throwing here
 * would take the control plane down, which is worse.
 */

import fs from "node:fs";
import path from "node:path";

import type { EngineId, EngineInfo } from "./contract";
import { WORKSPACE_ROOT } from "@/server/tools/security";

import type { EngineStateStore, ManagerEvent } from "./manager";

export const ENGINE_STATE_VERSION = 1;

export interface PersistedEngineState {
  version: number;
  engines: Record<EngineId, EngineInfo>;
  active: EngineId;
  /** Slot -> epoch ms of the last kernel push. Bounds duplicate pushes. */
  pushAt: Partial<Record<EngineId, number>>;
  events: ManagerEvent[];
  savedAt: number;
}

export interface StateBackend {
  /** Human-readable name, surfaced in diagnostics. */
  readonly label: string;
  read(): Promise<PersistedEngineState | null>;
  write(state: PersistedEngineState): Promise<void>;
}

const EMPTY_ENGINES: Record<EngineId, EngineInfo> = {
  a: { id: "a", state: "off", url: null, lastSeen: null },
  b: { id: "b", state: "off", url: null, lastSeen: null },
  c: { id: "c", state: "off", url: null, lastSeen: null },
};

export function emptyPersistedState(): PersistedEngineState {
  return {
    version: ENGINE_STATE_VERSION,
    engines: JSON.parse(JSON.stringify(EMPTY_ENGINES)) as Record<EngineId, EngineInfo>,
    active: "a",
    pushAt: {},
    events: [],
    savedAt: 0,
  };
}

/**
 * Reject anything that is not a well-formed snapshot. A corrupt or
 * hand-edited file must degrade to "no state", never to a crash or to a
 * half-populated record that the manager then trusts.
 */
function coerceState(raw: unknown): PersistedEngineState | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<PersistedEngineState>;
  if (candidate.version !== ENGINE_STATE_VERSION) return null;
  if (!candidate.engines || typeof candidate.engines !== "object") return null;
  if (candidate.active !== "a" && candidate.active !== "b" && candidate.active !== "c") return null;

  const out = emptyPersistedState();
  for (const id of ["a", "b", "c"] as EngineId[]) {
    const info = candidate.engines[id];
    if (info && typeof info === "object" && info.id === id) {
      out.engines[id] = {
        id,
        state: info.state ?? "off",
        url: typeof info.url === "string" ? info.url : null,
        lastSeen: typeof info.lastSeen === "number" ? info.lastSeen : null,
      };
    }
  }
  if (candidate.pushAt && typeof candidate.pushAt === "object") {
    for (const id of ["a", "b", "c"] as EngineId[]) {
      const at = candidate.pushAt[id];
      if (typeof at === "number" && Number.isFinite(at)) out.pushAt[id] = at;
    }
  }
  out.active = candidate.active;
  out.events = Array.isArray(candidate.events)
    ? candidate.events.filter(
        (e): e is ManagerEvent =>
          Boolean(e) && typeof e === "object" && typeof e.at === "number" && typeof e.text === "string",
      ).slice(-80)
    : [];
  out.savedAt = typeof candidate.savedAt === "number" ? candidate.savedAt : 0;
  return out;
}

/* ------------------------------ file backend ------------------------------ */

export function fileBackend(file: string): StateBackend {
  return {
    label: `file:${file}`,
    async read() {
      try {
        const text = await fs.promises.readFile(file, "utf8");
        return coerceState(JSON.parse(text));
      } catch {
        return null; // missing or unreadable == no state yet
      }
    },
    async write(state) {
      /* Atomic: a crash mid-write must not leave a truncated file that the
         next invocation then fails to parse. */
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(state), "utf8");
      await fs.promises.rename(tmp, file);
    },
  };
}

/* --------------------------- netlify blobs backend -------------------------- */

export function netlifyBlobsBackend(name = "aether-engine"): StateBackend {
  const key = "engine-state.json";
  return {
    label: `netlify-blobs:${name}/${key}`,
    async read() {
      /* Imported lazily: the package is meaningless off Netlify, and a static
         import would drag it into every non-Netlify bundle. */
      const { getStore } = await import("@netlify/blobs");
      const store = getStore(name);
      const raw = await store.get(key, { type: "json" });
      return coerceState(raw);
    },
    async write(state) {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore(name);
      await store.setJSON(key, state);
    },
  };
}

/* ----------------------------- backend choice ------------------------------ */

export function defaultStateFile(): string {
  return process.env.ENGINE_STATE_FILE ?? path.join(WORKSPACE_ROOT, "engine-state.json");
}

/**
 * Pick the backend for this host. Returns null when durability is explicitly
 * disabled, which is what the unit tests want: a shared file would leak state
 * between test cases.
 */
export function selectStateBackend(): StateBackend | null {
  const forced = (process.env.ENGINE_STATE_BACKEND ?? "").toLowerCase();
  if (forced === "memory") return null;
  /*
   * Under vitest, default to memory unless a test explicitly asks for a backend.
   * A shared file would leak engine state between test files and make failures
   * depend on execution order.
   */
  if (!forced && process.env.VITEST) return null;
  if (forced === "file") return fileBackend(defaultStateFile());
  if (forced === "netlify") return netlifyBlobsBackend();
  if (process.env.NETLIFY === "true") return netlifyBlobsBackend();
  return fileBackend(defaultStateFile());
}

/* ------------------------------ the store ------------------------------ */

export interface DurableEngineStateStore extends EngineStateStore {
  /** Load persisted state. Safe to call repeatedly; later calls are no-ops. */
  hydrate(): Promise<void>;
  /** Force any pending write out. Called at the end of a request. */
  flush(): Promise<void>;
  /** Which backend is in use, for diagnostics. */
  readonly backendLabel: string;
  /** True once hydrate() has completed. */
  readonly hydrated: boolean;
}

export function createDurableStore(backend: StateBackend | null): DurableEngineStateStore {
  let state: PersistedEngineState = emptyPersistedState();
  let hydrated = false;
  let hydrating: Promise<void> | null = null;
  let pending: Promise<void> | null = null;
  let dirty = false;

  const schedule = () => {
    dirty = true;
    if (pending) return;
    pending = (async () => {
      /* Let concurrent mutations coalesce into one write. */
      await new Promise((r) => setTimeout(r, 0));
      try {
        if (dirty && backend) {
          dirty = false;
          state.savedAt = Date.now();
          await backend.write(state);
        }
      } catch (err) {
        /* Never break a request over a failed write. */
        console.error("[engine-state] write failed:", err instanceof Error ? err.message : err);
      } finally {
        pending = null;
      }
    })();
  };

  return {
    backendLabel: backend?.label ?? "memory",

    get hydrated() {
      return hydrated;
    },

    /*
     * Re-reads on EVERY call, not just the first.
     *
     * A serverless host reuses warm containers, so "hydrate once per process"
     * would leave instance Y serving stale state that instance X had already
     * superseded — which is the same class of bug this file exists to fix, just
     * narrowed. The control plane is low-traffic (wake / off / state poll) and
     * the payload is a few hundred bytes, so a read per request is cheap and
     * buys the property that actually matters: whoever wrote last wins, and
     * every instance agrees.
     */
    async hydrate() {
      if (hydrating) return hydrating;
      if (!backend) {
        hydrated = true;
        return;
      }
      hydrating = (async () => {
        try {
          const loaded = await backend.read();
          /* A missing file means "nothing persisted yet" — keep the current
             snapshot rather than wiping state another code path just wrote. */
          if (loaded) state = loaded;
        } catch (err) {
          console.error("[engine-state] read failed:", err instanceof Error ? err.message : err);
        } finally {
          hydrated = true;
          hydrating = null;
        }
      })();
      return hydrating;
    },

    async flush() {
      if (pending) await pending;
      if (dirty && backend) {
        try {
          dirty = false;
          state.savedAt = Date.now();
          await backend.write(state);
        } catch (err) {
          console.error("[engine-state] flush failed:", err instanceof Error ? err.message : err);
        }
      }
    },

    /* ---- EngineStateStore (synchronous) ---- */

    get: () => state.engines,

    set: (info) => {
      state.engines[info.id] = { ...info };
      schedule();
    },

    getActive: () => state.active,

    setActive: (slot) => {
      if (state.active === slot) return;
      state.active = slot;
      schedule();
    },

    getEvents: () => state.events,

    pushEvent: (event) => {
      state.events = [...state.events, event].slice(-80);
      schedule();
    },

    getPushAt: (slot) => state.pushAt[slot] ?? null,

    setPushAt: (slot, at) => {
      state.pushAt[slot] = at;
      schedule();
    },

    clearPushAt: (slot) => {
      if (!(slot in state.pushAt)) return;
      delete state.pushAt[slot];
      schedule();
    },
  };
}

/* --------------------- process-wide shared instance --------------------- */

/**
 * The one durable store the whole server uses. manager.ts and resolve.ts must
 * share it, otherwise the wake-dispatch guard below would consult a different
 * snapshot from the one the manager writes.
 */
const shared = createDurableStore(selectStateBackend());

export function engineStateStore(): DurableEngineStateStore {
  return shared;
}

export function engineStateBackendLabel(): string {
  return shared.backendLabel;
}

export function hydrateEngineState(): Promise<void> {
  return shared.hydrate();
}

export function flushEngineStateNow(): Promise<void> {
  return shared.flush();
}

/**
 * Cross-instance duplicate-push guard (audit R3).
 *
 * Only meaningful when a durable backend is configured: within a single process
 * the manager's `activeWakes` map and `isWakeInFlight()` already stop a second
 * push. The case they cannot see is a DIFFERENT instance — a warm serverless
 * container, or a second worker — pushing the same kernel again, which is what
 * burned Kaggle quota in the audit.
 */
export function durableGuardActive(): boolean {
  return shared.backendLabel !== "memory";
}

export function wakeDispatchedWithin(slot: EngineId, ttlMs: number): boolean {
  const at = shared.getPushAt(slot);
  return at !== null && Date.now() - at < ttlMs;
}

export function recordWakeDispatch(slot: EngineId): void {
  shared.setPushAt(slot, Date.now());
}
