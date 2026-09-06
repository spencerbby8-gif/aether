import { ENGINE_OFF_HEADER, ENGINE_OFF_PATH } from "./contract";

/**
 * THE single implementation of "tell one engine to shut down".
 *
 * FIX (audit C3 / B1): the wire contract for shutdown used to be written twice —
 * once in resolve.ts (killAllEngines) and once in manager.ts (off). They had
 * already drifted: the manager called `/api/off` with an `x-off-key` header
 * while the engine only serves `POST /off` with `X-Engine-Key`. The engine
 * proxied the unknown path to ollama, returned 502, and the UI reported the
 * engine as "off" while the Kaggle kernel kept burning quota.
 *
 * Both callers now go through this function, so the contract cannot fork again.
 */

export type ShutdownOutcome =
  /** The engine accepted the shutdown (HTTP 200). */
  | "shutdown"
  /** The engine rejected our key (HTTP 403) — it is still running. */
  | "rejected-key"
  /** The engine could not be reached but is no longer serving. */
  | "already-off"
  /** The engine could not be reached and IS still serving. */
  | "unreachable"
  | `http-${number}`;

/** Outcomes that mean the engine is genuinely no longer running. */
export function shutdownConfirmed(outcome: ShutdownOutcome): boolean {
  return outcome === "shutdown" || outcome === "already-off";
}

export async function shutdownEngineUrl(
  url: string,
  offKey: string,
  options: {
    /** Confirms whether the engine is still serving, used when the call fails. */
    isAlive: (url: string) => Promise<boolean>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<ShutdownOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  try {
    const response = await doFetch(`${url.replace(/\/$/, "")}${ENGINE_OFF_PATH}`, {
      method: "POST",
      headers: { [ENGINE_OFF_HEADER]: offKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return "shutdown";
    if (response.status === 403) return "rejected-key";
    return `http-${response.status}`;
  } catch {
    /* Unreachable may mean the engine is already gone — confirm rather than
       assume. Claiming "off" here is exactly the bug this module exists to end. */
    return (await options.isAlive(url)) ? "unreachable" : "already-off";
  }
}
