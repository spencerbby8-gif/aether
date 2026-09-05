import { requireControlAuth } from "@/server/auth";
import { killAllEngines, resolveEngine, type KillResult, type ResolveResult } from "./resolve";

/**
 * HTTP adapters for the engine control plane.
 *
 * FIX (audit R2): this is now the ONLY engine control implementation. The
 * divergent Kaggle client in kaggle.ts (Basic auth + snake_case push body) has
 * been reduced to credential/config accessors; all wake, discovery, health and
 * shutdown behaviour flows through resolve.ts, which implements the documented
 * Kaggle REST contract (camelCase body + `Authorization: Bearer <key>`).
 */

export interface HandlerResult {
  status: number;
  body: ResolveResult | KillResult;
}

export async function ensureAliveHandler(account?: "a" | "b" | "c"): Promise<HandlerResult> {
  const result = await resolveEngine(account);
  if (result.status === "error") return { status: 502, body: result };
  return { status: 200, body: result }; // alive | waking
}

export async function engineOffHandler(): Promise<HandlerResult> {
  const result = await killAllEngines();
  if (result.status === "error") return { status: 500, body: result };
  const anyShutdown = result.killed.some((k) => k.result === "shutdown");
  const anyForbidden = result.killed.some((k) => k.result === "rejected-key");
  const anyFailed = result.killed.some((k) => k.result !== "shutdown");
  return { status: anyForbidden ? 403 : anyFailed && !anyShutdown ? 502 : 200, body: result };
}

/** Shared auth gate for the control routes. */
export { requireControlAuth };
