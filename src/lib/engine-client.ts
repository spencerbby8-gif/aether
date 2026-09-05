"use client";

import { useEffect, useState } from "react";

/**
 * Client-side engine API. Everything goes through OUR server routes —
 * the browser never touches Kaggle and never sees credentials.
 */

export type EngineState = "alive" | "waking" | "off" | "quota" | "unreachable" | "error";

export type EngineSlot = "a" | "b" | "c";

export interface EngineSnapshot {
  active: EngineSlot;
  engines: Record<EngineSlot, { id: string; state: EngineState; url: string | null; lastSeen: number | null }>;
  activeOperations: number;
  idleMs: number;
  idleLimitMinutes: number;
  kaggleConfigured: boolean;
  /** Per-engine configuration flags (booleans only — never credentials). */
  kaggle?: { a: boolean; b: boolean; c: boolean };
  model?: string;
  events: Array<{ at: number; text: string }>;
  /**
   * FRESH /api/ps health check — the single source of truth for whether an
   * engine is ACTUALLY live. Never a cached/stale read. `alive` is only true
   * when /api/ps returned 200 + models[].
   */
  live?: { alive: boolean; url: string | null; waking: boolean; latencyMs: number; checked: number };
}

export async function engineState(): Promise<EngineSnapshot | null> {
  try {
    const response = await fetch("/api/engine/state", { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as EngineSnapshot;
  } catch {
    return null;
  }
}

/** Real ensure-alive response shapes (handoff contract). */
export interface EnsureAliveResponse {
  status: "alive" | "waking" | "error";
  url?: string;
  engines?: Array<{ url: string; ageMinutes: number }>;
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
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as EnsureAliveResponse;
}

export interface EngineOffResponse {
  status: "off" | "error";
  killed: Array<{ url: string; result: string }>;
  message?: string;
}

/**
 * Power control — the exact contract route:
 *   GET /api/netlify/engine-off  → kill-all (every alive engine)
 * ENGINE_OFF_KEY authorizes the engine-side shutdown server-side only.
 */
export async function engineOff(timeoutMs: number = ENGINE_REQUEST_TIMEOUT_MS): Promise<EngineOffResponse> {
  const response = await fetch("/api/netlify/engine-off", {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as EngineOffResponse;
}

export type EngineRuntimeState = "live" | "offline" | "waking";

export interface EngineStatusResponse {
  /** True runtime state, confirmed by /api/ps. */
  state: EngineRuntimeState;
  alive: boolean;
  url: string | null;
  model: string | null;
  checked: number;
  waking: boolean;
  latencyMs: number;
}

/**
 * Read-only engine state (never wakes). Powers the header power-button.
 *   GET /api/netlify/engine-status → { state, alive, url, model, checked }
 * `alive` is only true once /api/ps has confirmed the engine — never a
 * stale beacon read.
 */
export async function engineStatus(timeoutMs: number = 12_000): Promise<EngineStatusResponse> {
  const response = await fetch("/api/netlify/engine-status", {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.json()) as Partial<EngineStatusResponse>;
  return {
    state: body.state ?? (body.alive ? "live" : "offline"),
    alive: body.alive ?? false,
    url: body.url ?? null,
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
    reader.releaseLock();
  }
}
