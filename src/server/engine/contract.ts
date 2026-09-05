/**
 * Engine contract — the SINGLE source of truth for engine identity, transport
 * endpoints and lifecycle states.
 *
 * The browser never sees these values; everything is mediated by the server.
 * Credentials live only in server env and are never serialized.
 *
 * FIX (audit C2): beacon endpoints are no longer hardcoded public URLs. They
 * come from env, so the fleet can use a private/authenticated channel, and so
 * the runtime can be pointed at a test engine. Announcements may be HMAC
 * signed (BEACON_SECRET); when a secret is configured, unsigned or
 * bad-signature announcements are rejected.
 */

export const MODEL_NAME = "hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS";

/**
 * Beacon endpoints. Empty by default: with no beacon configured the control
 * plane relies on explicit ENGINE_URL_* overrides or a state store, and never
 * silently trusts a public endpoint.
 */
export function beaconUrl(): string {
  return process.env.BEACON_URL ?? "";
}

export function beaconBackupUrl(): string {
  return process.env.BEACON_BACKUP_URL ?? "";
}

/** When set, beacon announcements must carry a valid HMAC signature. */
export function beaconSecret(): string | null {
  const s = process.env.BEACON_SECRET;
  return s && s.length > 0 ? s : null;
}

/**
 * Explicit per-engine URL overrides. These are the authoritative way to pin a
 * known engine (and the only way to get deterministic A/B/C routing without
 * engine-side identity tags). Never exposed to the client.
 */
export function engineUrlOverride(slot: EngineId): string | null {
  const env: Record<EngineId, string | undefined> = {
    a: process.env.ENGINE_URL_A,
    b: process.env.ENGINE_URL_B,
    c: process.env.ENGINE_URL_C,
  };
  const url = env[slot];
  return url && /^https?:\/\//i.test(url) ? url.replace(/\/+$/, "") : null;
}

export const WAKE_URL = "/.netlify/functions/ensure-alive";
export const OFF_URL = "/.netlify/functions/engine-off";

/** Three-engine fleet: A, B, and C. AUTO failover order is A → B → C. */
export type EngineId = "a" | "b" | "c";
export const ENGINE_IDS: EngineId[] = ["a", "b", "c"];

/**
 * Engine lifecycle states.
 *  - alive:     API_BASE resolved and /api/ps healthy
 *  - waking:    kernel start requested, waiting for the tunnel heartbeat
 *  - off:       engine stopped (deliberately or by quota policy)
 *  - quota:     Kaggle reported the GPU quota exhausted
 *  - unreachable: last known URL failed health checks (rotating tunnel)
 *  - error:     control-plane failure (e.g. KAGGLE_KEY not configured)
 */
export type EngineState = "alive" | "waking" | "off" | "quota" | "unreachable" | "error";

export interface EngineInfo {
  id: EngineId;
  state: EngineState;
  url: string | null;
  lastSeen: number | null;
  lastError?: string;
}

/* ------------------------------------------------------------------ */
/* Engine HTTP contract — ONE definition, used by every implementation. */
/* ------------------------------------------------------------------ */

/** Shutdown endpoint served by the engine. There is no `/api/off`. */
export const ENGINE_OFF_PATH = "/off";
/** Header the engine requires on shutdown. */
export const ENGINE_OFF_HEADER = "X-Engine-Key";
/** Health endpoint. */
export const ENGINE_HEALTH_PATH = "/api/ps";
/** Chat endpoint (NDJSON agent loop). */
export const ENGINE_CHAT_PATH = "/api/chat";

/**
 * The server-side shutdown key. This authorizes server → engine shutdown and
 * is distinct from the per-engine Kaggle credentials. It is never returned to
 * any client and never logged.
 */
export function engineOffKey(): string | null {
  const key = process.env.ENGINE_OFF_KEY;
  return key && key.length > 0 ? key : null;
}

/** Idle shutdown — 20 minutes of true inactivity (overridable for testing). */
export const DEFAULT_IDLE_MINUTES = 20;

export function idleMinutes(): number {
  const raw = Number(process.env.ENGINE_IDLE_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MINUTES;
}

/**
 * Stream timing (audit R1). The engine's agent loop can legitimately run for
 * many minutes while emitting thinking keep-alives, so the stream is bounded by
 * INACTIVITY, not by a total deadline.
 *  - STREAM_IDLE_TIMEOUT_MS: max silence between engine events before we give up
 *  - STREAM_TOTAL_TIMEOUT_MS: hard ceiling so nothing can run forever
 */
export function streamIdleTimeoutMs(): number {
  const raw = Number(process.env.STREAM_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
}

export function streamTotalTimeoutMs(): number {
  const raw = Number(process.env.STREAM_TOTAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 900_000;
}

/** Milliseconds a resolved engine URL stays trusted before re-verification. */
export function staleUrlMs(): number {
  const raw = Number(process.env.ENGINE_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}
