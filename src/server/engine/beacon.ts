import { BEACON_BACKUP, BEACON_URL } from "./contract";

/**
 * Beacon parsing — engines announce their rotating tunnel URLs by posting
 * status lines to webhook.site (query param `m`) and ntfy (JSON lines).
 * Lines look like:
 *   "AGENT LIVE LINK: https://xxx.trycloudflare.com (tools: ...)"
 *   "alive: https://xxx.trycloudflare.com (idle 3 min)"
 *   "ENGINE OFF via UI - quota saved"
 */

export interface BeaconSignal {
  /** Most recent live URL announced by any engine, if any. */
  liveUrl: string | null;
  liveUrlAt: number | null;
  /** Live URL explicitly tagged for engine A, B, or C, when announced. */
  liveUrlA: string | null;
  liveUrlB: string | null;
  liveUrlC: string | null;
  /** True when the most recent lifecycle event was a shutdown. */
  off: boolean;
  offAt: number | null;
  /** Raw parsed events, newest first (for diagnostics). */
  events: Array<{ at: number; text: string }>;
}

const LIVE_RE = /(?:AGENT LIVE LINK|alive)[:\s]+(https?:\/\/[^\s)]+)/i;
const OFF_RE = /ENGINE OFF/i;
/* Engines may tag their heartbeats with their slot: "engine=b alive: ..." */
const ENGINE_TAG_RE = /engine\s*[:=]?\s*([abc])\b/i;

function extractUrl(text: string): string | null {
  const match = LIVE_RE.exec(text);
  return match ? match[1].replace(/[.,;]+$/, "") : null;
}

function extractEngineTag(text: string): "a" | "b" | "c" | null {
  const match = ENGINE_TAG_RE.exec(text);
  if (!match) return null;
  const tag = match[1].toLowerCase();
  return tag === "a" || tag === "b" || tag === "c" ? tag : null;
}

/** Parse webhook.site requests (heartbeats arrive as GET ?m=<message>). */
export function parseWebhookRequests(body: unknown): Array<{ at: number; text: string }> {
  interface RequestItem {
    url?: string;
    content?: string;
    created_at?: string;
  }
  const record = body as { data?: RequestItem[]; request?: RequestItem };
  const out: Array<{ at: number; text: string }> = [];
  const items: RequestItem[] = record?.data ?? (record?.request ? [record.request] : []);
  for (const item of items) {
    const at = item.created_at ? Date.parse(item.created_at) : 0;
    let text = (item.content ?? "").trim();
    if (!text && item.url) {
      try {
        const url = new URL(item.url);
        text = url.searchParams.get("m") ?? "";
      } catch {
        text = "";
      }
    }
    if (text) out.push({ at, text });
  }
  return out.sort((x, y) => x.at - y.at);
}

/** Parse ntfy JSON-lines polling output. */
export function parseNtfyLines(raw: string): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { time?: number; message?: string };
      if (parsed.message) out.push({ at: (parsed.time ?? 0) * 1000, text: parsed.message });
    } catch {
      /* skip malformed lines */
    }
  }
  return out.sort((x, y) => x.at - y.at);
}

/** Merge and interpret beacon events into a lifecycle signal. */
export function interpretBeacon(events: Array<{ at: number; text: string }>): BeaconSignal {
  const sorted = [...events].sort((x, y) => x.at - y.at);
  let liveUrl: string | null = null;
  let liveUrlAt: number | null = null;
  let liveUrlA: string | null = null;
  let liveUrlB: string | null = null;
  let liveUrlC: string | null = null;
  let off = false;
  let offAt: number | null = null;
  for (const event of sorted) {
    const url = extractUrl(event.text);
    if (url) {
      liveUrl = url;
      liveUrlAt = event.at;
      off = false;
      offAt = null;
      /* Per-slot attribution requires an explicit tag; untagged heartbeats
         stay generic and are attributed only through the wake path — this
         prevents one engine's tunnel from silently satisfying another. */
      const tag = extractEngineTag(event.text);
      if (tag === "a") liveUrlA = url;
      else if (tag === "b") liveUrlB = url;
      else if (tag === "c") liveUrlC = url;
    }
    if (OFF_RE.test(event.text)) {
      off = true;
      offAt = event.at;
    }
  }
  return {
    liveUrl,
    liveUrlAt,
    liveUrlA,
    liveUrlB,
    liveUrlC,
    off,
    offAt,
    events: sorted.slice(-8).reverse().map(({ at, text }) => ({ at, text: text.slice(0, 200) })),
  };
}

export interface BeaconFetchResult {
  signal: BeaconSignal;
  sources: { webhook: "ok" | "error"; ntfy: "ok" | "error" };
}

/** Fetch both beacons (primary + backup) and merge them. */
export async function fetchBeaconSignal(fetchImpl: typeof fetch = fetch): Promise<BeaconFetchResult> {
  const events: Array<{ at: number; text: string }> = [];
  const sources = { webhook: "error" as "ok" | "error", ntfy: "error" as "ok" | "error" };

  try {
    const response = await fetchImpl(`${BEACON_URL}/requests`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      events.push(...parseWebhookRequests(await response.json()));
      sources.webhook = "ok";
    }
  } catch {
    /* primary beacon unreachable — the backup still covers us */
  }

  try {
    const response = await fetchImpl(BEACON_BACKUP, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      events.push(...parseNtfyLines(await response.text()));
      sources.ntfy = "ok";
    }
  } catch {
    /* backup beacon unreachable */
  }

  return { signal: interpretBeacon(events), sources };
}
