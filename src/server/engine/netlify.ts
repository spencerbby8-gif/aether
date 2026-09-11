import { requireControlAuth } from "@/server/auth";
import { redactSecrets } from "@/server/tools/security";
import { getEngineManager } from "./manager";
import { killAllEngines, resolveEngine, type KillResult, type ResolveResult } from "./resolve";
import type { EngineId } from "./contract";

/**
 * HTTP adapters for the engine control plane.
 *
 * FIX (audit R2): this is now the ONLY engine control implementation. The
 * divergent Kaggle client in kaggle.ts (Basic auth + snake_case push body) has
 * been reduced to credential/config accessors; all wake, discovery, health and
 * shutdown behaviour flows through resolve.ts, which implements the documented
 * Kaggle REST contract (camelCase body + `Authorization: Bearer <key>`).
 *
 * Every resolution is written through to the EngineManager, so /api/engine/state
 * and the UI can never disagree with what the control plane actually bound.
 *
 * FIX (audit C2): these adapters are the boundary where internal resolution
 * state becomes an HTTP response, so this is where tunnel URLs and Kaggle
 * usernames are stripped. The browser never dials an engine directly — the
 * server proxies every engine request — so a client has no use for the URL, and
 * shipping it turned every control response into a tunnel-URL disclosure.
 */

/* ---------------- public (client-facing) response shapes ---------------- */

export interface PublicEngineLink {
  /** Which engine announced this link. The URL itself never leaves the server. */
  slot: EngineId | null;
  ageMinutes: number;
}

export interface PublicResolveBody {
  status: "alive" | "waking" | "error";
  slot?: EngineId | null;
  /** True when the server holds a usable engine URL — the URL itself is withheld. */
  urlPresent?: boolean;
  engines?: PublicEngineLink[];
  model?: string;
  ageMinutes?: number;
  etaMinutes?: number;
  reason?: string;
  message?: string;
}

export interface PublicKillBody {
  status: "off" | "error";
  killed: Array<{ slot: EngineId | null; result: string }>;
  message?: string;
}

export interface HandlerResult {
  status: number;
  /** Safe to serialize to a client. Contains no tunnel URL and no credentials. */
  body: PublicResolveBody | PublicKillBody;
  /**
   * Server-internal only, for callers that must actually dial the engine (the
   * streaming route). Never part of `body`, so it can never be serialized.
   */
  internal?: { url?: string; slot?: EngineId | null };
}

/** Scrub Kaggle usernames/keys and tunnel URLs out of free-text fields. */
function safeText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactSecrets(value);
}

function publicResolve(result: ResolveResult): PublicResolveBody {
  const body: PublicResolveBody = { status: result.status };
  if (result.slot !== undefined) body.slot = result.slot;
  if (result.url) body.urlPresent = true;
  if (result.engines) {
    body.engines = result.engines.map((e) => ({ slot: e.slot ?? null, ageMinutes: e.ageMinutes }));
  }
  if (result.model) body.model = result.model;
  if (result.ageMinutes !== undefined) body.ageMinutes = result.ageMinutes;
  if (result.etaMinutes !== undefined) body.etaMinutes = result.etaMinutes;
  if (result.reason) body.reason = safeText(result.reason);
  if (result.message) body.message = safeText(result.message);
  return body;
}

function publicKill(result: KillResult, urlToSlot: Map<string, EngineId>): PublicKillBody {
  return {
    status: result.status,
    killed: result.killed.map((k) => ({
      /* Prefer the slot the link was announced with; fall back to whatever the
         manager had bound, so an engine discovered only via the beacon is still
         named instead of reported as null. */
      slot: k.slot ?? urlToSlot.get(k.url) ?? null,
      result: k.result,
    })),
    message: safeText(result.message),
  };
}

/* ------------------------------- handlers ------------------------------- */

export async function ensureAliveHandler(account?: EngineId): Promise<HandlerResult> {
  const engineManager = await getEngineManager(); // FIX (audit R3): durable state
  const result = await resolveEngine(account);
  if (result.status === "alive" && result.url) {
    const slot = result.slot ?? account;
    if (slot) engineManager.noteAlive(slot, result.url);
  }
  const internal = { url: result.url, slot: result.slot ?? account ?? null };
  if (result.status === "error") return { status: 502, body: publicResolve(result), internal };
  return { status: 200, body: publicResolve(result), internal }; // alive | waking
}

export async function engineOffHandler(): Promise<HandlerResult> {
  const engineManager = await getEngineManager(); // FIX (audit R3): durable state
  /* Remember which URL belonged to which slot BEFORE the shutdown clears them. */
  const urlToSlot = new Map<string, EngineId>();
  for (const [id, info] of Object.entries(engineManager.snapshot().engines)) {
    if (info.url) urlToSlot.set(info.url, id as EngineId);
  }

  const result = await killAllEngines();

  /* Only a CONFIRMED shutdown may clear a slot's state (audit C3). */
  for (const k of result.killed) {
    if (k.result !== "shutdown" && k.result !== "already-off") continue;
    const slot = urlToSlot.get(k.url);
    if (slot) engineManager.noteOff(slot);
  }

  const body = publicKill(result, urlToSlot);
  if (result.status === "error") return { status: 500, body };
  const anyShutdown = result.killed.some((k) => k.result === "shutdown");
  const anyForbidden = result.killed.some((k) => k.result === "rejected-key");
  const anyFailed = result.killed.some((k) => k.result !== "shutdown");
  return { status: anyForbidden ? 403 : anyFailed && !anyShutdown ? 502 : 200, body };
}

/** Shared auth gate for the control routes. */
export { requireControlAuth };
