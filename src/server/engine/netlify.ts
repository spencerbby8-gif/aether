import { killAllEngines, resolveEngine, type KillResult, type ResolveResult } from "./resolve";

/**
 * HTTP adapters for the engine control plane.
 * Backed by resolve.ts — the faithful TypeScript port of the verified
 * aether-engine-runtime Netlify Functions. Responses use the handoff's real
 * shapes:
 *   ensure-alive → {status:"alive",url,...} | {status:"waking",...} | {status:"error",message}
 *   engine-off   → {status:"off",killed:[...],message}
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
  return { status: anyShutdown ? 200 : anyForbidden ? 403 : 200, body: result };
}
