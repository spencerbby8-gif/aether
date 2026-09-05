import { fetchBeaconSignal } from "./beacon";
import {
  ENGINE_HEALTH_PATH,
  ENGINE_IDS,
  ENGINE_OFF_HEADER,
  ENGINE_OFF_PATH,
  engineOffKey,
  engineUrlOverride,
  idleMinutes,
  staleUrlMs,
  type EngineId,
  type EngineInfo,
  type EngineState,
} from "./contract";
import { engineConfigured } from "./kaggle";
import { wakeSlot } from "./resolve";

/**
 * EngineManager — authoritative server-side lifecycle for the Kaggle engines.
 *
 * FIX (audit C3): shutdown uses the engine's REAL contract — POST {url}/off with
 * the `X-Engine-Key` header — and a slot is only marked "off" when the engine
 * actually accepted it (HTTP 200). Previously this called `/api/off` with an
 * `x-off-key` header, the engine proxied it to ollama and returned 502, and the
 * manager marked the engine "off" anyway: the UI showed "off" while the Kaggle
 * kernel kept running and burning GPU quota.
 *
 * FIX (audit C5): strict per-slot resolution can only be satisfied by that
 * slot's own attributed URL (explicit override, tagged beacon, or a URL bound
 * to the slot at wake time). An untagged announcement can never silently
 * satisfy "Engine B". AUTO mode may still bind an unattributed live engine.
 *
 * FIX (audit R3): all mutable state lives in an injectable store so it can be
 * backed by something durable on serverless instead of module memory.
 */

export interface ManagerEvent {
  at: number;
  text: string;
}

/** Slot → URL bindings. In-memory by default; replaceable for serverless. */
export interface EngineStateStore {
  get(): Record<EngineId, EngineInfo>;
  set(info: EngineInfo): void;
  getActive(): EngineId;
  setActive(slot: EngineId): void;
  getEvents(): ManagerEvent[];
  pushEvent(event: ManagerEvent): void;
  getPushAt(slot: EngineId): number | null;
  setPushAt(slot: EngineId, at: number): void;
  clearPushAt(slot: EngineId): void;
}

export function createMemoryStore(): EngineStateStore {
  const engines: Record<EngineId, EngineInfo> = {
    a: { id: "a", state: "off", url: null, lastSeen: null },
    b: { id: "b", state: "off", url: null, lastSeen: null },
    c: { id: "c", state: "off", url: null, lastSeen: null },
  };
  let active: EngineId = "a";
  let events: ManagerEvent[] = [];
  const pushAt = new Map<EngineId, number>();
  return {
    get: () => engines,
    set: (info) => {
      engines[info.id] = { ...info };
    },
    getActive: () => active,
    setActive: (slot) => {
      active = slot;
    },
    getEvents: () => events,
    pushEvent: (event) => {
      events = [...events, event].slice(-80);
    },
    getPushAt: (slot) => pushAt.get(slot) ?? null,
    setPushAt: (slot, at) => {
      pushAt.set(slot, at);
    },
    clearPushAt: (slot) => {
      pushAt.delete(slot);
    },
  };
}

export interface ManagerOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Wait window for a waking engine to announce its tunnel (ms). */
  wakeTimeoutMs?: number;
  wakePollMs?: number;
  healthTimeoutMs?: number;
  store?: EngineStateStore;
  /** Off key override (tests). Production reads ENGINE_OFF_KEY from env. */
  offKey?: () => string | null;
}

const DEFAULT_WAKE_TIMEOUT_MS = 12 * 60_000; // Kaggle boot ≈ 9 min
const DEFAULT_WAKE_POLL_MS = 10_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 8_000;

export class EngineManager {
  private fetchImpl: typeof fetch | null;
  private now: () => number;
  private wakeTimeoutMs: number;
  private wakePollMs: number;
  private healthTimeoutMs: number;
  private store: EngineStateStore;
  private offKeyFn: () => string | null;

  private activeOperations = 0;
  private lastActivity = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /* Race safety: concurrent wakes of the same engine join one promise. */
  private activeWakes = new Map<EngineId, Promise<{ state: EngineState; detail: string; url: string | null }>>();
  /* Prevents re-pushing a kernel that is already booting (duplicate runs). */
  private static readonly PUSH_COOLDOWN_MS = 10 * 60_000;

  constructor(options: ManagerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? null;
    this.now = options.now ?? Date.now;
    this.wakeTimeoutMs = options.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
    this.wakePollMs = options.wakePollMs ?? DEFAULT_WAKE_POLL_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.store = options.store ?? createMemoryStore();
    this.offKeyFn = options.offKey ?? engineOffKey;
    this.lastActivity = this.now();
  }

  /* ---------------- activity & operations ---------------- */

  /** Meaningful activity resets the idle timer (chat, tools, wake, off). */
  touch(): void {
    this.lastActivity = this.now();
  }

  idleMs(): number {
    return Math.max(0, this.now() - this.lastActivity);
  }

  beginOperation(): void {
    this.activeOperations += 1;
    this.touch();
  }

  endOperation(): void {
    this.activeOperations = Math.max(0, this.activeOperations - 1);
    this.touch();
  }

  hasActiveOperations(): boolean {
    return this.activeOperations > 0;
  }

  private log(text: string): void {
    this.store.pushEvent({ at: this.now(), text });
  }

  /* ---------------- health ---------------- */

  /** Lazy default binding so test/global fetch replacements apply. */
  private http(): typeof fetch {
    return this.fetchImpl ?? fetch;
  }

  /** GET {url}/api/ps — the engine's own health endpoint. */
  async health(url: string): Promise<boolean> {
    try {
      const response = await this.http()(`${url.replace(/\/$/, "")}${ENGINE_HEALTH_PATH}`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!response.ok) return false;
      const body = (await response.json().catch(() => null)) as { models?: unknown[] } | null;
      return Array.isArray(body?.models) && (body?.models.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /* ---------------- resolution ---------------- */

  /**
   * Resolve a usable API_BASE for one slot. Never hardcoded.
   *
   * `strict` (manual A/B/C) only accepts URLs attributed to that slot:
   *   1) ENGINE_URL_<slot> override
   *   2) a beacon announcement tagged with that slot
   *   3) a URL previously bound to that slot by its own wake, still healthy
   * AUTO additionally accepts the latest unattributed live announcement.
   *
   * FIX (audit): cached URLs older than ENGINE_STALE_MS are re-verified instead
   * of trusted, so a rotated tunnel is detected rather than reused.
   */
  async resolve(options: { engine?: EngineId; strict?: boolean } = {}): Promise<{
    url: string | null;
    state: EngineState;
    detail: string;
  }> {
    const slot = options.engine ?? this.store.getActive();
    const strict = options.strict ?? true;
    const engine = this.store.get()[slot];

    /* 1 — Explicit override always wins and is authoritative. */
    const override = engineUrlOverride(slot);
    if (override) {
      if (await this.health(override)) {
        this.bind(slot, "alive", override, "Resolved via ENGINE_URL override.");
        return { url: override, state: "alive", detail: `Healthy (override): ${override}` };
      }
      this.bind(slot, "unreachable", null, "Override URL failed /api/ps.");
      return { url: null, state: "unreachable", detail: "Override URL failed health checks." };
    }

    /* 2 — Cached URL, re-verified when stale. */
    const age = engine.lastSeen === null ? Infinity : this.now() - engine.lastSeen;
    if (engine.state === "alive" && engine.url && age < staleUrlMs() && (await this.health(engine.url))) {
      return { url: engine.url, state: "alive", detail: "Cached URL healthy." };
    }

    /* 3 — Beacon-driven resolution. */
    const beacon = await fetchBeaconSignal(this.http()).catch(() => null);
    const signal = beacon?.signal ?? null;

    if (signal?.off && !signal.liveUrl && (signal.offSlot === null || signal.offSlot === slot)) {
      this.bind(slot, "off", null, "Beacon reports ENGINE OFF.");
      return { url: null, state: "off", detail: "Beacon reports the engine is off." };
    }

    const tagged =
      signal && slot === "a"
        ? signal.liveUrlA
        : signal && slot === "b"
          ? signal.liveUrlB
          : signal && slot === "c"
            ? signal.liveUrlC
            : null;

    const candidates: string[] = [];
    if (tagged) candidates.push(tagged);
    /* A URL this slot bound itself earlier (from its own wake) is still valid. */
    if (engine.url && !candidates.includes(engine.url)) candidates.push(engine.url);
    /* AUTO only: an unattributed live announcement may be adopted. */
    if (!strict && signal?.liveUrl && !candidates.includes(signal.liveUrl)) {
      candidates.push(signal.liveUrl);
    }

    for (const candidate of candidates) {
      if (await this.health(candidate)) {
        this.bind(slot, "alive", candidate, tagged ? "Resolved via tagged beacon." : "Resolved via bound URL.");
        return { url: candidate, state: "alive", detail: `Healthy: ${candidate}` };
      }
    }

    /* Everything attributed is dead — the tunnel rotated or the engine stopped. */
    if (tagged || engine.url) {
      this.bind(slot, "unreachable", null, "Announced URL failed /api/ps (rotating tunnel).");
      return { url: null, state: "unreachable", detail: "Announced tunnel URL failed health checks." };
    }
    if (engine.state === "waking") {
      return { url: null, state: "waking", detail: "Engine is waking; no tunnel announced yet." };
    }
    const state: EngineState = engine.state === "quota" ? "quota" : "off";
    this.bind(slot, state, null, "No live URL found.");
    return { url: null, state, detail: "No engine URL resolved." };
  }

  /**
   * AUTO-mode discovery: adopt the latest healthy announcement, whether tagged
   * or not, and bind it to the active slot.
   */
  async resolveAnyLive(): Promise<{ url: string | null; state: EngineState; detail: string; slot: EngineId }> {
    const slot = this.store.getActive();
    const beacon = await fetchBeaconSignal(this.http()).catch(() => null);
    const signal = beacon?.signal ?? null;
    if (signal?.off && !signal.liveUrl) {
      return { url: null, state: "off", detail: "Beacon reports ENGINE OFF.", slot };
    }
    const url = signal?.liveUrl ?? null;
    if (url && (await this.health(url))) {
      this.bind(slot, "alive", url, "Untagged announcement bound to active slot (auto).");
      return { url, state: "alive", detail: "Announced tunnel is healthy.", slot };
    }
    return {
      url: null,
      state: url ? "unreachable" : "off",
      detail: url ? "Announced tunnel failed health." : "No announcement.",
      slot,
    };
  }

  /* ---------------- wake ---------------- */

  /**
   * Wake an engine through the control plane, then wait for its tunnel
   * announcement + health. Concurrent wakes of the same engine join one
   * shared promise (no duplicate Kaggle pushes, no races).
   */
  wake(slot?: EngineId, maxWaitMs?: number): Promise<{ state: EngineState; detail: string; url: string | null }> {
    const target = slot ?? this.store.getActive();
    const existing = this.activeWakes.get(target);
    if (existing) return existing;
    const promise = this.wakeInner(target, maxWaitMs).finally(() => {
      this.activeWakes.delete(target);
    });
    this.activeWakes.set(target, promise);
    return promise;
  }

  private async wakeInner(target: EngineId, maxWaitMs?: number): Promise<{ state: EngineState; detail: string; url: string | null }> {
    this.touch();

    /* Already resolvable? Skip straight to work. */
    const quick = await this.resolve({ engine: target, strict: true });
    if (quick.state === "alive" && quick.url) {
      return { state: "alive", detail: quick.detail, url: quick.url };
    }

    /* If this engine is already booting from a recent push, do NOT push
       again (Kaggle would start duplicate runs) — just poll for the tunnel. */
    const pushedAt = this.store.getPushAt(target);
    const alreadyBooting =
      this.store.get()[target].state === "waking" &&
      pushedAt !== null &&
      this.now() - pushedAt < EngineManager.PUSH_COOLDOWN_MS;

    if (!alreadyBooting) {
      const wakeResult = await wakeSlot(target);
      this.log(`wake(${target}): ${wakeResult.state} — ${wakeResult.detail}`);
      if (wakeResult.state === "quota") {
        this.bind(target, "quota", null, wakeResult.detail);
        return { state: "quota", detail: wakeResult.detail, url: null };
      }
      if (wakeResult.state === "error") {
        /* Control plane unusable — maybe the engine is already alive. */
        const fallback = await this.resolve({ engine: target, strict: true });
        if (fallback.state === "alive" && fallback.url) {
          return { state: "alive", detail: fallback.detail, url: fallback.url };
        }
        this.bind(target, engineConfigured(target) ? "error" : fallback.state, null, wakeResult.detail);
        return { state: this.store.get()[target].state, detail: wakeResult.detail, url: null };
      }
      this.store.setPushAt(target, this.now());
      this.bind(target, "waking", null, wakeResult.detail);
    } else {
      this.log(`wake(${target}): already booting (pushed ${Math.round((this.now() - (pushedAt ?? 0)) / 1000)}s ago) — polling only`);
    }
    return await this.waitForAlive(target, maxWaitMs);
  }

  /** Poll beacons + health until the waking engine announces a healthy tunnel. */
  async waitForAlive(slot: EngineId, maxWaitMs?: number): Promise<{ state: EngineState; detail: string; url: string | null }> {
    const deadline = this.now() + (maxWaitMs ?? this.wakeTimeoutMs);
    let lastEventAt = 0;
    while (this.now() < deadline) {
      const beacon = await fetchBeaconSignal(this.http()).catch(() => null);
      const signal = beacon?.signal ?? null;
      /* Prefer this slot's tagged URL; fall back to the generic announcement. */
      const tagged =
        slot === "a" ? signal?.liveUrlA : slot === "b" ? signal?.liveUrlB : slot === "c" ? signal?.liveUrlC : null;
      const url = tagged ?? signal?.liveUrl ?? null;
      lastEventAt = Math.max(lastEventAt, signal?.events[0]?.at ?? 0);
      if (url && !signal?.off) {
        if (await this.health(url)) {
          this.bind(slot, "alive", url, "Tunnel announced and healthy.");
          return { state: "alive", detail: "Engine is alive.", url };
        }
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(this.wakePollMs, remaining)));
    }
    /* Beacon still chattering (boot stages) → honestly "waking". */
    if (lastEventAt > this.now() - 10 * 60_000) {
      this.bind(slot, "waking", null, "Still booting — beacon activity ongoing.");
      return { state: "waking", detail: "Engine is still booting.", url: null };
    }
    this.bind(slot, "unreachable", null, "Wake timed out waiting for a healthy tunnel.");
    return { state: "unreachable", detail: "Wake timed out.", url: null };
  }

  /* ---------------- shutdown ---------------- */

  /**
   * Shut down one or all engines using the engine's REAL contract:
   *   POST {url}/off   with header  X-Engine-Key: <ENGINE_OFF_KEY>
   *
   * A slot is marked "off" ONLY when the engine returns 200. A 403 (bad key)
   * or 5xx/502 (wrong path, engine proxying to ollama) leaves the slot in its
   * previous state with a truthful error, so the UI can never claim a shutdown
   * that did not happen.
   *
   * Refused while operations are active — the server is authoritative.
   */
  async off(target: EngineId | "all"): Promise<{ ok: boolean; detail: string; results: Record<string, string> }> {
    if (this.hasActiveOperations()) {
      return { ok: false, detail: "Refused: an engine operation is active.", results: {} };
    }
    this.touch();

    const offKey = this.offKeyFn();
    if (!offKey) {
      const slots = target === "all" ? ENGINE_IDS : [target];
      const results: Record<string, string> = {};
      for (const slot of slots) results[slot] = "no-off-key";
      return {
        ok: false,
        detail: "ENGINE_OFF_KEY is not configured on the server; shutdown is not authorized.",
        results,
      };
    }

    const slots = target === "all" ? ENGINE_IDS : [target];
    const results: Record<string, string> = {};

    for (const slot of slots) {
      const engine = this.store.get()[slot];
      const previousState = engine.state;

      if (!engine.url) {
        results[slot] = engine.state === "off" ? "already-off" : "no-url";
        /* Nothing to shut down: "off" is truthful here. */
        if (engine.state !== "off") this.bind(slot, "off", null, "No URL to shut down.");
        continue;
      }

      let outcome: string;
      let accepted = false;
      try {
        const response = await this.http()(`${engine.url.replace(/\/$/, "")}${ENGINE_OFF_PATH}`, {
          method: "POST",
          headers: { [ENGINE_OFF_HEADER]: offKey, "content-type": "application/json" },
          signal: AbortSignal.timeout(this.healthTimeoutMs),
        });
        if (response.ok) {
          outcome = "off-accepted";
          accepted = true;
        } else if (response.status === 403) {
          outcome = "off-rejected-key";
        } else {
          outcome = `off-http-${response.status}`;
        }
      } catch {
        /* A dead tunnel also means the engine is gone — but only if we can
           confirm it is no longer serving. Otherwise stay truthful. */
        const stillUp = await this.health(engine.url);
        outcome = stillUp ? "off-unreachable" : "off-already-gone";
        accepted = !stillUp;
      }
      results[slot] = outcome;

      if (accepted) {
        this.store.clearPushAt(slot);
        this.bind(slot, "off", null, `Shut down (${outcome}).`);
      } else {
        /* Shutdown did NOT happen. Keep the previous state, record why. */
        this.bind(slot, previousState === "alive" ? "alive" : previousState, engine.url, `Shutdown failed (${outcome}).`);
        this.log(`off(${slot}): FAILED ${outcome} — engine still ${previousState}`);
      }
    }

    const allAccepted = Object.values(results).every((r) => r === "off-accepted" || r === "already-off" || r === "off-already-gone");
    this.log(`off(${target}): ${JSON.stringify(results)}`);
    return {
      ok: allAccepted,
      detail: allAccepted
        ? `Shutdown confirmed for ${slots.length} engine(s).`
        : `Shutdown FAILED for at least one engine: ${JSON.stringify(results)}`,
      results,
    };
  }

  /* ---------------- failover ---------------- */

  /** Pick the engine to work against: active slot first, any alive second. */
  pickEngine(): EngineId {
    const engines = this.store.get();
    if (engines[this.store.getActive()].state === "alive") return this.store.getActive();
    const other = ENGINE_IDS.find((id) => engines[id].state === "alive");
    if (other) {
      this.store.setActive(other);
      return other;
    }
    return this.store.getActive();
  }

  /** Mark a slot's URL stale and evict it (rotating-URL failure). */
  reportFailure(slot: EngineId): void {
    const engine = this.store.get()[slot];
    if (engine.state === "alive") {
      this.bind(slot, "unreachable", null, "Operation failed against the cached URL — evicted.");
    }
  }

  /**
   * Deterministic A → B → C → A failover. Each call advances exactly one step
   * from the slot that failed, so repeated failures walk the fleet in a fixed
   * order rather than oscillating.
   */
  async failover(from: EngineId): Promise<{ slot: EngineId; url: string | null; state: EngineState }> {
    const currentIndex = ENGINE_IDS.indexOf(from);
    const target = ENGINE_IDS[(currentIndex + 1) % ENGINE_IDS.length];
    this.store.setActive(target);
    this.log(`failover ${from} → ${target}`);
    const resolved = await this.resolve({ engine: target, strict: true });
    if (resolved.state === "alive" && resolved.url) {
      return { slot: target, url: resolved.url, state: "alive" };
    }
    const woken = await this.wake(target);
    return { slot: target, url: woken.url, state: woken.state };
  }

  /* ---------------- idle shutdown ---------------- */

  startIdleWatch(): void {
    if (this.idleTimer) return;
    const checkMs = Math.max(1_000, Math.min(30_000, this.wakePollMs));
    this.idleTimer = setInterval(() => {
      void this.idleCheck();
    }, checkMs);
    this.idleTimer.unref?.();
  }

  stopIdleWatch(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  async idleCheck(): Promise<boolean> {
    const limitMs = idleMinutes() * 60_000;
    const engines = this.store.get();
    const anyAlive = ENGINE_IDS.some((id) => engines[id].state === "alive");
    if (!anyAlive) return false;
    if (this.hasActiveOperations()) {
      this.touch(); // never idle while work is in flight
      return false;
    }
    if (this.idleMs() < limitMs) return false;
    this.log(`idle-off: no activity for ${Math.round(this.idleMs() / 60_000)} min — shutting down all engines.`);
    await this.off("all");
    return true;
  }

  /* ---------------- state ---------------- */

  private bind(slot: EngineId, state: EngineState, url: string | null, note?: string): void {
    const engine = this.store.get()[slot];
    const next: EngineInfo = {
      ...engine,
      id: slot,
      state,
      /* Evict the URL whenever we are no longer alive, so a rotated tunnel is
         never reused. */
      url: state === "alive" ? url : null,
      lastSeen: state === "alive" ? this.now() : engine.lastSeen,
      lastError: note ?? engine.lastError,
    };
    this.store.set(next);
    this.log(`engine ${slot}: ${state}${state === "alive" && url ? ` @ ${url}` : ""}${note ? ` — ${note}` : ""}`);
  }

  snapshot() {
    const engines = this.store.get();
    return {
      model: undefined as string | undefined, // filled by route (never leak secrets)
      active: this.store.getActive(),
      engines: {
        a: { ...engines.a },
        b: { ...engines.b },
        c: { ...engines.c },
      },
      activeOperations: this.activeOperations,
      idleMs: this.idleMs(),
      idleLimitMinutes: idleMinutes(),
      /* Per-engine configuration flags — booleans only, never values. */
      kaggleConfigured: ENGINE_IDS.some((id) => engineConfigured(id)),
      kaggle: { a: engineConfigured("a"), b: engineConfigured("b"), c: engineConfigured("c") },
      events: this.store.getEvents().slice(-12),
    };
  }
}

/* Singleton used by API routes (server process is authoritative). */
export const engineManager = new EngineManager();
engineManager.startIdleWatch();
