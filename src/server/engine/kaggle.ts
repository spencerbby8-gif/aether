import type { EngineId } from "./contract";
import { accounts, kernelSlugFor } from "./resolve";

/**
 * Kaggle credential accessors — NOTHING ELSE.
 *
 * FIX (audit R2): this module used to contain a second, divergent Kaggle client
 * (Basic auth, a snake_case push body, and heuristic kernel discovery that could
 * pick the newest unrelated kernel in the account). Two implementations of the
 * same job had already drifted apart. All wake / discovery / status / shutdown
 * behaviour now lives in resolve.ts, which uses the documented Kaggle REST
 * contract. What remains here is credential and configuration lookup only, so
 * there is exactly one way to talk to Kaggle.
 *
 * Credentials come ONLY from server env and are never serialized into any
 * response, log line, bundle or client-visible surface.
 */

export interface EngineCredentials {
  username: string;
  key: string;
}

/** Credentials for one engine slot, or null when not configured. */
export function credentialsFor(engine: EngineId): EngineCredentials | null {
  const [acc] = accounts(engine);
  return acc ? { username: acc.user, key: acc.key } : null;
}

/** True when a given engine has server-side credentials. */
export function engineConfigured(engine: EngineId): boolean {
  return credentialsFor(engine) !== null;
}

/** Which env vars a slot needs — for truthful, secret-free error messages. */
export function credentialEnvNames(engine: EngineId): string {
  const names: Record<EngineId, string> = {
    a: "KAGGLE_USERNAME / KAGGLE_KEY",
    b: "KAGGLE_USERNAME_B / KAGGLE_KEY_B",
    c: "KAGGLE_USERNAME_C / KAGGLE_KEY_C",
    d: "KAGGLE_USERNAME_D / KAGGLE_KEY_D",
  };
  return names[engine];
}

export { kernelSlugFor };
