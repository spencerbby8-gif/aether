/**
 * Phase 5 engine contract — supplied constants, used verbatim.
 * The browser never sees these paths directly; everything is mediated by
 * this server. KAGGLE_KEY lives only in server env and is never serialized.
 */

export const MODEL_NAME = "hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS";

export const BEACON_URL = "https://REMOVED_WEBHOOK_TOKEN";
export const BEACON_BACKUP = "https://ntfy.sh/REMOVED_BEACON_TOPIC/json?poll=1&since=12h";

export const WAKE_URL = "/.netlify/functions/ensure-alive";
export const OFF_URL = "/.netlify/functions/engine-off";

/** Two Kaggle GPU engines, addressed as slots. */
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

/** Idle shutdown — 20 minutes of true inactivity (overridable for testing). */
export const DEFAULT_IDLE_MINUTES = 20;

export function idleMinutes(): number {
  const raw = Number(process.env.ENGINE_IDLE_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MINUTES;
}
