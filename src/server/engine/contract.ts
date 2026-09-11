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
    d: process.env.ENGINE_URL_D,
  };
  const url = env[slot];
  return url && /^https?:\/\//i.test(url) ? url.replace(/\/+$/, "") : null;
}


/** Three-engine fleet: A, B, and C. AUTO failover order is A → B → C. */
export type EngineId = "a" | "b" | "c" | "d";
/* Order IS the failover order: A → B → C → D. Every consumer derives its
 * order from this array rather than hardcoding one, so widening it is what
 * extends the chain. */
export const ENGINE_IDS: EngineId[] = ["a", "b", "c", "d"];

/**
 * Kaggle REST base URL.
 *
 * Overridable from SERVER env only (never bundled, never NEXT_PUBLIC_) so the
 * documented push/status contract can be exercised against a recording endpoint
 * in proofs without spending real GPU quota. Defaults to the real API.
 */
export const KAGGLE_API = process.env.KAGGLE_API_URL ?? "https://www.kaggle.com/api/v1";

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
/**
 * The engine's OWN idle watchdog, read from the shipped notebook
 * (`IDLE_LIMIT = 3600.0`, "60 min idle -> shutdown to save quota").
 *
 * FIX (audit §5 / D2): the server used to default to 20 minutes while the
 * engine allowed 60, so the two disagreed and the server always fired first —
 * making the engine's watchdog dead code and killing engines 40 minutes before
 * either side intended. They now share one number. Set ENGINE_IDLE_MINUTES
 * lower if you want the server to shut engines down sooner than they would
 * shut themselves down.
 */
export const ENGINE_SELF_IDLE_MINUTES = 60;

export const DEFAULT_IDLE_MINUTES = ENGINE_SELF_IDLE_MINUTES;

/**
 * Synchronous serverless execution ceiling, in seconds, for the host we detect.
 *
 * FIX (audit R1 / D3): Netlify caps synchronous function execution at 60 s and
 * the limit is NOT configurable; its Background Functions run 15 min but answer
 * 202 immediately and therefore cannot stream to the caller. `maxDuration = 900`
 * on the streaming route is honoured by a long-lived Node server and by Vercel
 * (up to 800 s on Pro) but is simply ignored by Netlify, which will cut a
 * generation off mid-stream. A measured real generation here took 64.1 s — past
 * that cap — so this is a deployment constraint, not a theoretical one.
 */
export function platformStreamCeilingSeconds(): number | null {
  if (process.env.NETLIFY === "true") return 60;
  if (process.env.VERCEL) return 800; // Vercel Pro/Enterprise GA ceiling
  return null; // long-lived Node server: no platform ceiling
}

/**
 * How long a dispatched wake is reported as "waking" before the fleet probe is
 * allowed to call the slot offline again.
 *
 * Overridable from SERVER env so the expiry behaviour can be proven without
 * waiting out the real 15-minute boot window. A slot whose engine never
 * announces must eventually stop claiming to be waking.
 */
export function wakeTrackTtlMs(): number {
  const raw = Number(process.env.ENGINE_WAKE_TRACK_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
}

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
