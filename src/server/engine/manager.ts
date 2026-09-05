import { fetchBeaconSignal } from "./beacon";
import { ENGINE_IDS, idleMinutes, type EngineId, type EngineInfo, type EngineState } from "./contract";
import { engineConfigured, engineOffKey, kaggleWakeKernel } from "./kaggle";

/**
 * EngineManager — authoritative server-side lifecycle for the two Kaggle
 * engines. Resolution order (per contract): WAKE_URL result → beacon
 * fallback → /api/ps health checks. API_BASE is never hardcoded; tunnels
 * rotate and are always re-resolved from live signals.
 */

export interface ManagerEvent {
  at: number;
  text: string;
}

export interface ManagerOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Wait window for a waking engine to announce its tunnel (ms). */
  wakeTimeoutMs?: number;
  wakePollMs?: number;
  healthTimeoutMs?: number;
  idleCheckMs?: number;
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

  private engines: Record<EngineId, EngineInfo> = {
    a: { id: "a", state: "off", url: null, lastSeen: null },
    b: { id: "b", state: "off", url: null, lastSeen: null },
    c: { id: "c", state: "off", url: null, lastSeen: null },
  };
  private active: EngineId = "a";
  private activeOperations = 0;
  private lastActivity = 0;
  private events: ManagerEvent[] = [];
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /* Race safety: concurrent wakes of the same engine join one promise. */
  private activeWakes = new Map<EngineId, Promise<{ state: EngineState; detail: string; url: string | null }>>();
  /* Prevents re-pushing a kernel that is already booting (duplicate runs). */
  private lastPushAt = new Map<EngineId, number>();
  private static readonly PUSH_COOLDOWN_MS = 10 * 60_000;

  constructor(options: ManagerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? null;
    this.now = options.now ?? Date.now;
    this.wakeTimeoutMs = options.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
    this.wakePollMs = options.wakePollMs ?? DEFAULT_WAKE_POLL_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
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
    this.events.push({ at: this.now(), text });
    if (this.events.length > 80) this.events = this.events.slice(-80);
  }

  /* ---------------- health ---------------- */

  /** Lazy default binding so test/global fetch replacements apply. */
  private http(): typeof fetch {
    return this.fetchImpl ?? fetch;
  }

  /** GET {url}/api/ps — the engine's own health endpoint. */
  async health(url: string): Promise<boolean> {
    try {
      const response = await this.http()(`${url.replace(/\/$/, "")}/api/ps`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /* ---------------- resolution (the contract order) ---------------- */

  /**
   * Resolve a usable API_BASE. Never hardcoded:
   *  1) WAKE_URL (ensure-alive) result when it reports a live URL
   *  2) beacon fallback — latest announced tunnel URL, health-checked
   *  3) last cached URL, health-checked (rotating-URL recovery)
   */
  async resolve(options: { wakeFirst?: boolean; engine?: EngineId } = {}): Promise<{ url: string | null; state: EngineState; detail: string }> {
    const slot = options.engine ?? this.active;
    const engine = this.engines[slot];

    /* 1 — cached alive URL that still passes health (fast path). */
    if (engine.state === "alive" && engine.url && (await this.health(engine.url))) {
      return { url: engine.url, state: "alive", detail: "Cached URL healthy." };
    }

    /* 2 — WAKE_URL / beacon-driven resolution. */
    const beacon = await fetchBeaconSignal(this.http()).catch(() => null);
    if (beacon?.signal.off && !beacon.signal.liveUrl) {
      this.setState(slot, "off", null, "Beacon reports ENGINE OFF.");
      return { url: null, state: "off", detail: "Beacon reports the engine is off." };
    }

    /* Candidates in priority order: this engine's tagged announcement first,
       then its cached URL, then other engines' cached URLs, and finally the
       latest untagged live announcement as a fallback. Untagged heartbeats
       can't say which engine they belong to, so they're only used when no
       engine-specific candidate is healthy. */
    const tagged =
      slot === "a" ? beacon?.signal.liveUrlA : slot === "b" ? beacon?.signal.liveUrlB : beacon?.signal.liveUrlC;
    const candidates: string[] = [];
    if (tagged) candidates.push(tagged);
    if (engine.url && !candidates.includes(engine.url)) candidates.push(engine.url);
    for (const other of ENGINE_IDS) {
      const info = this.engines[other];
      if (info.url && !candidates.includes(info.url)) candidates.push(info.url);
    }
    /* Untagged live announcement as the last-resort candidate. */
    if (beacon?.signal.liveUrl && !candidates.includes(beacon.signal.liveUrl)) {
      candidates.push(beacon.signal.liveUrl);
    }

    for (const candidate of candidates) {
      if (await this.health(candidate)) {
        engine.url = candidate;
        engine.lastSeen = this.now();
        this.setState(slot, "alive", candidate, "Resolved via beacon/health checks.");
        return { url: candidate, state: "alive", detail: `Healthy: ${candidate}` };
      }
    }

    /* Everything announced is dead — the tunnel rotated or the engine stopped. */
    if (beacon?.signal.liveUrl) {
      this.setState(slot, "unreachable", null, "Announced URL failed /api/ps (rotating tunnel).");
      return { url: null, state: "unreachable", detail: "Announced tunnel URL failed health checks." };
    }
    if (engine.state === "waking") {
      return { url: null, state: "waking", detail: "Engine is waking; no tunnel announced yet." };
    }
    this.setState(slot, engine.state === "quota" ? "quota" : "off", null, "No live URL found.");
    return { url: null, state: engine.state, detail: "No engine URL resolved." };
  }

  /**
   * AUTO-mode discovery for fleets whose heartbeats are UNTAGGED: take the
   * latest announced tunnel if it is healthy, and bind it to the active
   * slot. Strict manual routing never uses this — manual slots resolve only
   * through tagged announcements or their own wake, so an untagged URL can
   * never silently satisfy ENGINE A / ENGINE B.
   */
  async resolveAnyLive(): Promise<{ url: string | null; state: EngineState; detail: string }> {
    const beacon = await fetchBeaconSignal(this.http()).catch(() => null);
    if (beacon?.signal.off && !beacon.signal.liveUrl) {
      return { url: null, state: "off", detail: "Beacon reports ENGINE OFF." };
    }
    const url = beacon?.signal.liveUrl ?? null;
    if (url && (await this.health(url))) {
      this.setState(this.active, "alive", url, "Untagged announcement bound to active slot (auto).");
      return { url, state: "alive", detail: "Announced tunnel is healthy." };
    }
    return { url: null, state: url ? "unreachable" : "off", detail: url ? "Announced tunnel failed health." : "No announcement." };
  }

  /* ---------------- wake ---------------- */

  /**
   * Wake an engine through the control plane, then wait for its tunnel
   * announcement + health. Concurrent wakes of the same engine join one
   * shared promise (no duplicate Kaggle pushes, no races).
   */
  wake(slot?: EngineId, maxWaitMs?: number): Promise<{ state: EngineState; detail: string; url: string | null }> {
    const target = slot ?? this.active;
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
    const quick = await this.resolve({ engine: target });
    if (quick.state === "alive" && quick.url) {
      return { state: "alive", detail: quick.detail, url: quick.url };
    }

    /* If this engine is already booting from a recent push, do NOT push
       again (Kaggle would start duplicate runs) — just poll for the tunnel. */
    const pushedAt = this.lastPushAt.get(target);
    const alreadyBooting =
      this.engines[target].state === "waking" && pushedAt !== undefined && this.now() - pushedAt < EngineManager.PUSH_COOLDOWN_MS;

    if (!alreadyBooting) {
      const wakeResult = await kaggleWakeKernel(target, this.http());
      this.log(`wake(${target}): ${wakeResult.state} — ${wakeResult.detail}`);
      if (wakeResult.state === "quota") {
        this.setState(target, "quota", null, wakeResult.detail);
        return { state: "quota", detail: wakeResult.detail, url: null };
      }
      if (wakeResult.state === "error") {
        /* Control plane unusable — maybe the engine is already alive. */
        const fallback = await this.resolve({ engine: target });
        if (fallback.state === "alive" && fallback.url) {
          return { state: "alive", detail: fallback.detail, url: fallback.url };
        }
        this.setState(target, engineConfigured(target) ? "error" : fallback.state, null, wakeResult.detail);
        return { state: this.engines[target].state, detail: wakeResult.detail, url: null };
      }
      this.lastPushAt.set(target, this.now());
      this.setState(target, "waking", null, wakeResult.detail);
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
      const url = beacon?.signal.liveUrl ?? null;
      lastEventAt = Math.max(lastEventAt, beacon?.signal.events[0]?.at ?? 0);
      if (url && !beacon?.signal.off) {
        if (await this.health(url)) {
          this.setState(slot, "alive", url, "Tunnel announced and healthy.");
          return { state: "alive", detail: "Engine is alive.", url };
        }
      }
      /* Never sleep past the wait window. */
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(this.wakePollMs, remaining)));
    }
    /* Beacon still chattering (boot stages) → honestly "waking", so callers
       can keep waiting instead of treating a slow boot as a failure. */
    if (lastEventAt > this.now() - 10 * 60_000) {
      this.setState(slot, "waking", null, "Still booting — beacon activity ongoing.");
      return { state: "waking", detail: "Engine is still booting.", url: null };
    }
    this.setState(slot, "unreachable", null, "Wake timed out waiting for a healthy tunnel.");
    return { state: "unreachable", detail: "Wake timed out.", url: null };
  }

  /* ---------------- shutdown ---------------- */

  /**
   * Shut down one or both engines. Refused while operations are active —
   * the server is authoritative for this guard.
   */
  async off(target: EngineId | "both"): Promise<{ ok: boolean; detail: string; results: Record<string, string> }> {
    if (this.hasActiveOperations()) {
      return { ok: false, detail: "Refused: an engine operation is active.", results: {} };
    }
    this.touch();
    const slots = target === "both" ? ENGINE_IDS : [target];
    const results: Record<string, string> = {};
    for (const slot of slots) {
      const engine = this.engines[slot];
      if (engine.url) {
        try {
          /* ENGINE_OFF_KEY authorizes shutdown server-side; it never leaves
             this process except as a request header to the engine itself. */
          const offKey = engineOffKey();
          const response = await this.http()(`${engine.url.replace(/\/$/, "")}/api/off`, {
            method: "POST",
            headers: offKey ? { "x-off-key": offKey } : {},
            signal: AbortSignal.timeout(this.healthTimeoutMs),
          });
          results[slot] = response.ok ? "off-accepted" : `off-http-${response.status}`;
        } catch {
          results[slot] = "off-unreachable";
        }
      } else {
        results[slot] = engine.state === "off" ? "already-off" : "no-url";
      }
      /* Clear the stale tunnel URL: the next message must re-discover the
         engine's new rotating URL through wake + beacon, never reuse it.
         Also reset the push cooldown so a fresh boot may push again. */
      engine.url = null;
      this.lastPushAt.delete(slot);
      this.setState(slot, "off", null, `Shut down (${results[slot]}).`);
    }
    this.log(`off(${target}): ${JSON.stringify(results)}`);
    return { ok: true, detail: `Shutdown requested for ${slots.length} engine(s).`, results };
  }

  /* ---------------- failover ---------------- */

  /** Pick the engine to work against: active slot first, any alive second. */
  pickEngine(): EngineId {
    if (this.engines[this.active].state === "alive") return this.active;
    const other = ENGINE_IDS.find((id) => this.engines[id].state === "alive");
    if (other) {
      this.active = other;
      return other;
    }
    return this.active;
  }

  /** Mark the current engine's URL as stale (rotating-URL failure). */
  reportFailure(slot: EngineId): void {
    const engine = this.engines[slot];
    if (engine.state === "alive") {
      this.setState(slot, "unreachable", null, "Operation failed against the cached URL.");
    }
  }

  /** Fail over: try the other engine, waking it if needed. */
  /** A → B → C failover order. Each engine fails over to the next in line. */
  async failover(from: EngineId): Promise<{ slot: EngineId; url: string | null; state: EngineState }> {
    const order: EngineId[] = ["a", "b", "c"];
    const currentIndex = order.indexOf(from);
    const target: EngineId = order[(currentIndex + 1) % order.length];
    this.active = target;
    this.log(`failover ${from} → ${target}`);
    const resolved = await this.resolve({ engine: target });
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
    const anyAlive = ENGINE_IDS.some((id) => this.engines[id].state === "alive");
    if (!anyAlive) return false;
    if (this.hasActiveOperations()) {
      this.touch(); // never idle while work is in flight
      return false;
    }
    if (this.idleMs() < limitMs) return false;
    this.log(`idle-off: no activity for ${Math.round(this.idleMs() / 60_000)} min — shutting down both engines.`);
    await this.off("both");
    return true;
  }

  /* ---------------- state ---------------- */

  private setState(slot: EngineId, state: EngineState, url: string | null, note?: string): void {
    const engine = this.engines[slot];
    engine.state = state;
    if (url !== null) engine.url = url;
    if (state === "alive") engine.lastSeen = this.now();
    if (note) engine.lastError = note;
    this.log(`engine ${slot}: ${state}${url ? ` @ ${url}` : ""}${note ? ` — ${note}` : ""}`);
  }

  snapshot() {
    return {
      model: undefined as string | undefined, // filled by route (never leak secrets)
      active: this.active,
      engines: {
        a: { ...this.engines.a },
        b: { ...this.engines.b },
        c: { ...this.engines.c },
      },
      activeOperations: this.activeOperations,
      idleMs: this.idleMs(),
      idleLimitMinutes: idleMinutes(),
      /* Per-engine configuration flags — booleans only, never values. */
      kaggleConfigured: engineConfigured("a") || engineConfigured("b"),
      kaggle: { a: engineConfigured("a"), b: engineConfigured("b"), c: engineConfigured("c") },
      events: this.events.slice(-12),
    };
  }
}

/* Singleton used by API routes (server process is authoritative). */
export const engineManager = new EngineManager();
engineManager.startIdleWatch();
