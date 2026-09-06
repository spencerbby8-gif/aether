"use client";

import { useEffect, useState } from "react";
import { controlAuthHeaders } from "@/lib/control-auth";

/**
 * Client-side engine API. Everything goes through OUR server routes —
 * the browser never touches Kaggle and never sees credentials.
 */

export type EngineState = "alive" | "waking" | "off" | "quota" | "unreachable" | "error";

export type EngineSlot = "a" | "b" | "c";

/** Real per-engine health, from that slot's own /api/ps probe. */
export type SlotHealth = "live" | "waking" | "offline";

export interface EngineSlotInfo {
  id: string;
  /** Truth: did THIS slot's own engine answer /api/ps? */
  health: SlotHealth;
  latencyMs: number | null;
  healthChecked: boolean;
  /** Credential presence — deliberately NOT health. */
  configured: boolean;
  state: EngineState;
  /**
   * Whether the server holds a URL for this slot. The URL itself is never sent
   * to the browser: it is an unauthenticated RCE endpoint on the engine host.
   */
  urlPresent: boolean;
  lastSeen: number | null;
  lastError?: string;
}

export interface EngineSnapshot {
  active: EngineSlot;
  engines: Record<EngineSlot, EngineSlotInfo>;
  activeOperations: number;
  idleMs: number;
  idleLimitMinutes: number;
  /**
   * Where idle shutdown is actually enforced (audit R3). `authoritative` is
   * false on a serverless runtime, where a server-side idle clock restarts on
   * every cold start and therefore must not be shown as a countdown.
   */
  idleOff?: {
    running: boolean;
    authoritative: boolean;
    enforcedBy: "aether-server" | "engine";
    reason: string;
  };
  /**
   * What the hosting platform can actually sustain (audit D3). A null ceiling
   * means a long-lived Node server; 60 means Netlify will cut a generation off.
   */
  deployment?: {
    runtime: "netlify" | "vercel" | "node-server";
    streamCeilingSeconds: number | null;
    note: string;
  };
  kaggleConfigured: boolean;
  /** Per-engine configuration flags (booleans only — never credentials). */
  kaggle?: { a: boolean; b: boolean; c: boolean };
  model?: string;
  events: Array<{ at: number; text: string }>;
  /**
   * FRESH fleet-wide /api/ps health check. `alive` is only true when /api/ps
   * returned 200 + models[]. Never carries a tunnel URL.
   */
  live?: { alive: boolean; urlPresent: boolean; waking: boolean; latencyMs: number; checked: number; slot: EngineSlot | null };
}

export async function engineState(): Promise<EngineSnapshot | null> {
  try {
    const response = await fetch("/api/engine/state", { cache: "no-store", headers: await controlAuthHeaders() });
    if (!response.ok) return null;
    return (await response.json()) as EngineSnapshot;
  } catch {
    return null;
  }
}

/**
 * Real ensure-alive response shapes (handoff contract).
 *
 * FIX (audit C2): carries NO tunnel URL. The browser never dials an engine
 * directly — the server proxies every engine request — so the URL is server-
 * internal. `urlPresent` says whether the server holds one; `slot` says which
 * engine it is.
 */
export interface EnsureAliveResponse {
  status: "alive" | "waking" | "error";
  slot?: EngineSlot | null;
  urlPresent?: boolean;
  engines?: Array<{ slot: EngineSlot | null; ageMinutes: number }>;
  model?: string;
  ageMinutes?: number;
  etaMinutes?: number;
  reason?: string;
  message?: string;
}

/**
 * Wake / discover — the exact contract route:
 *   GET /api/netlify/ensure-alive?engine=a|b  (omit engine for AUTO A→B)
 * Returns the real shapes: {status:"alive",url,...} | {status:"waking",...}
 * | {status:"error",message}.
 */
/** Hard client-side ceiling for any engine request. A request that exceeds
 *  this always settles (never an infinite spinner), even if the server-side
 *  function is killed mid-flight by the host. */
export const ENGINE_REQUEST_TIMEOUT_MS = 20_000;

export async function engineWake(
  engine?: EngineSlot,
  timeoutMs: number = ENGINE_REQUEST_TIMEOUT_MS,
): Promise<EnsureAliveResponse> {
  const query = engine ? `?engine=${engine}` : "";
  const response = await fetch(`/api/netlify/ensure-alive${query}`, {
    method: "GET",
    headers: await controlAuthHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as EnsureAliveResponse;
}

export interface EngineOffResponse {
  status: "off" | "error";
  /** Identified by slot, never by tunnel URL (audit C2). */
  killed: Array<{ slot: EngineSlot | null; result: string }>;
  message?: string;
}

/**
 * Power control:
 *   POST /api/netlify/engine-off  → kill-all (every alive engine)
 *
 * This is POST because it changes server state; a GET here was reachable from
 * any web page (no auth, no CSRF token) and was a one-click engine kill switch.
 * ENGINE_OFF_KEY authorizes the server→engine hop only and never reaches the
 * client — the caller presents the control token instead.
 */
export async function engineOff(timeoutMs: number = ENGINE_REQUEST_TIMEOUT_MS): Promise<EngineOffResponse> {
  const response = await fetch("/api/netlify/engine-off", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await controlAuthHeaders()) },
    body: JSON.stringify({ engine: "all" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as EngineOffResponse;
}

export type EngineRuntimeState = "live" | "offline" | "waking";

export interface EngineStatusResponse {
  /** True runtime state, confirmed by /api/ps. */
  state: EngineRuntimeState;
  alive: boolean;
  /**
   * Whether an engine is addressable. The URL itself is never sent to the
   * browser (audit A8 / §6.6): it is an unauthenticated RCE endpoint on the
   * engine host, and the beacons that publish it are world-readable.
   */
  urlPresent: boolean;
  model: string | null;
  checked: number;
  waking: boolean;
  latencyMs: number;
}

/**
 * Read-only engine state (never wakes). Powers the header power-button.
 *   GET /api/netlify/engine-status → { state, alive, urlPresent, model, checked }
 * `alive` is only true once /api/ps has confirmed the engine — never a
 * stale beacon read.
 */
export async function engineStatus(timeoutMs: number = 12_000): Promise<EngineStatusResponse> {
  const response = await fetch("/api/netlify/engine-status", {
    cache: "no-store",
    headers: await controlAuthHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.json()) as Partial<EngineStatusResponse>;
  return {
    state: body.state ?? (body.alive ? "live" : "offline"),
    alive: body.alive ?? false,
    urlPresent: body.urlPresent ?? false,
    model: body.model ?? null,
    checked: body.checked ?? 0,
    waking: body.waking ?? false,
    latencyMs: body.latencyMs ?? 0,
  };
}

/**
 * Poll engine state for the header power-button. Polls fast while not live
 * (status transitions matter when waking/going down) and settles to a slower
 * cadence once confirmed live.
 */
export function useEngineStatus(enabled: boolean, idleIntervalMs = 8_000): EngineStatusResponse | null {
  const [status, setStatus] = useState<EngineStatusResponse | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (ms: number) => {
      timer = setTimeout(load, ms);
    };
    const load = () => {
      if (cancelled) return;
      engineStatus()
        .then((s) => {
          if (cancelled) return;
          setStatus(s);
          /* Fast while waking (transitions matter); slow once live. */
          schedule(s.alive ? idleIntervalMs : 2_500);
        })
        .catch(() => {
          if (!cancelled) schedule(2_500);
        });
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, idleIntervalMs]);
  return status;
}

/**
 * NDJSON lines emitted by /api/agent/stream (real engine contract):
 *   {message:{content}} — append to the answer
 *   {message:{thinking}} — safe thinking activity (never persisted raw)
 *   {tool:{id,name,state,detail}} — tool activity
 *   {citations:[{title,url}]} — sources for rendering
 *   {artifact:{name,mimeType,base64}} — generated JPG/WAV
 *   {error:{message}} / {done:true}
 */
export type EngineStreamLine =
  | { message?: { content?: string; thinking?: string }; done?: boolean; error?: { message?: string } }
  | { tool?: { id: string; name: string; state: "running" | "done" | "error"; detail?: string } }
  | { citations?: Array<{ title: string; url: string; snippet?: string }> }
  | { artifact?: { name: string; mimeType: string; base64: string } }
  | { tool_activity?: { kind: string; count: number } };

/** Poll engine lifecycle state (state reads never reset the idle timer). */
export function useEngineSnapshot(
  enabled: boolean,
  intervalMs = 6_000,
): { snapshot: EngineSnapshot | null; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      void engineState().then((next) => {
        if (!cancelled && next) setSnapshot(next);
      });
    };
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, intervalMs, tick]);
  const refresh = () => setTick((t) => t + 1);
  return { snapshot, refresh };
}

export async function* readNdjson(response: Response, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  /* Cancelling the reader is what makes an abort immediate: it settles the
     in-flight read() instead of leaving it parked until the next chunk, and it
     tears the HTTP connection down so the engine sees the disconnect. */
  const onAbort = () => {
    reader.cancel().catch(() => {
      /* already closed */
    });
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          /* tolerate malformed keep-alive lines */
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
