import crypto from "node:crypto";
import { ENGINE_IDS, beaconBackupUrl, beaconSecret, beaconUrl, type EngineId } from "./contract";

/**
 * Beacon parsing — engines announce their rotating tunnel URLs by posting
 * status lines. Lines look like:
 *   "AGENT LIVE LINK: https://xxx.trycloudflare.com (tools: ...)"
 *   "alive: https://xxx.trycloudflare.com (idle 3 min)"
 *   "ENGINE OFF via UI - quota saved"
 *
 * FIX (audit C2): when BEACON_SECRET is configured, an announcement is only
 * accepted if it carries a valid HMAC. This stops an anonymous party who can
 * reach the beacon topic from injecting a fake engine URL (which would redirect
 * all chat traffic to them) or a fake "ENGINE OFF".
 *
 * FIX (audit C5): announcements may carry an explicit engine identity
 * ("engine=b"). Untagged announcements are recorded as unattributed and can
 * never satisfy a strict per-slot request.
 */

export interface BeaconSignal {
  /** Most recent live URL announced by any engine, if any. */
  liveUrl: string | null;
  liveUrlAt: number | null;
  /** Live URL explicitly tagged for engine A, B, or C, when announced. */
  liveUrlA: string | null;
  liveUrlB: string | null;
  liveUrlC: string | null;
  liveUrlD: string | null;
  /** Every per-slot URL keyed by slot, so a caller never has to enumerate
   *  them by hand and silently miss the newest one. */
  liveUrlBySlot: Record<EngineId, string | null>;
  /** True when the most recent lifecycle event was a shutdown. */
  off: boolean;
  offAt: number | null;
  /** Per-slot shutdown, when the announcement was attributed. */
  offSlot: EngineId | null;
  /** Raw parsed events, newest first (for diagnostics). */
  events: Array<{ at: number; text: string }>;
  /** Announcements rejected for a bad/missing signature. */
  rejectedUnsigned: number;
}

const LIVE_RE = /(?:AGENT LIVE LINK|alive)[:\s]+(https?:\/\/[^\s)]+)/i;
const OFF_RE = /ENGINE OFF/i;
/* Engines may tag their heartbeats with their slot: "engine=b alive: ..." */
const ENGINE_TAG_RE = /engine\s*[:=]?\s*([abcd])\b/i;
/* Signature is carried as a trailing "sig=<hex>" or "X-Aether-Sig: <hex>". */
const SIG_RE = /(?:\bsig=|X-Aether-Sig:\s*)([a-f0-9]{64})/i;

function extractUrl(text: string): string | null {
  const match = LIVE_RE.exec(text);
  return match ? match[1].replace(/[.,;]+$/, "") : null;
}

function extractEngineTag(text: string): EngineId | null {
  const match = ENGINE_TAG_RE.exec(text);
  if (!match) return null;
  const tag = match[1].toLowerCase();
  /* Validated against ENGINE_IDS. A hand-written comparison chain here is a
     second place a new slot can be dropped, and the regex above would still
     match it -- so the tag would parse and then be discarded as unknown. */
  return (ENGINE_IDS as string[]).includes(tag) ? (tag as EngineId) : null;
}

/** Strip the signature token so the signature covers the payload only. */
function stripSig(text: string): string {
  return text.replace(SIG_RE, "").trim();
}

/**
 * Verify an announcement. With no BEACON_SECRET configured every announcement
 * is accepted (single-tenant / local development). With a secret configured,
 * an announcement must carry sig=<hmac-sha256(payload, secret)>.
 */
export function verifyAnnouncement(text: string): boolean {
  const secret = beaconSecret();
  if (!secret) return true;
  const match = SIG_RE.exec(text);
  if (!match) return false;
  const expected = crypto.createHmac("sha256", secret).update(stripSig(text)).digest("hex");
  const provided = match[1].toLowerCase();
  /* Constant-time comparison. */
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
}

/** Parse webhook.site-style requests (heartbeats arrive as GET ?m=<message>). */
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
  /* Per-slot attribution built from ENGINE_IDS. The old form was three
     separate locals and an if/else chain, which is exactly where a fourth
     engine gets dropped: an engine=d announcement would set liveUrl but
     attribute to no slot at all. */
  const liveUrlBySlot: Record<EngineId, string | null> = Object.fromEntries(
    ENGINE_IDS.map((id) => [id, null]),
  ) as Record<EngineId, string | null>;
  let off = false;
  let offAt: number | null = null;
  let offSlot: EngineId | null = null;
  let rejectedUnsigned = 0;

  for (const event of sorted) {
    /* Untrusted announcements are counted and ignored entirely. */
    if (!verifyAnnouncement(event.text)) {
      rejectedUnsigned += 1;
      continue;
    }
    const url = extractUrl(event.text);
    const tag = extractEngineTag(event.text);
    if (url) {
      liveUrl = url;
      liveUrlAt = event.at;
      off = false;
      offAt = null;
      offSlot = null;
      /* Per-slot attribution requires an explicit tag. */
      if (tag) liveUrlBySlot[tag] = url;
    }
    if (OFF_RE.test(event.text)) {
      off = true;
      offAt = event.at;
      offSlot = tag;
    }
  }
  return {
    liveUrl,
    liveUrlAt,
    liveUrlA: liveUrlBySlot.a,
    liveUrlB: liveUrlBySlot.b,
    liveUrlC: liveUrlBySlot.c,
    liveUrlD: liveUrlBySlot.d,
    liveUrlBySlot,
    off,
    offAt,
    offSlot,
    events: sorted.slice(-8).reverse().map(({ at, text }) => ({ at, text: stripSig(text).slice(0, 200) })),
    rejectedUnsigned,
  };
}

export interface BeaconFetchResult {
  signal: BeaconSignal;
  sources: { webhook: "ok" | "error" | "disabled"; ntfy: "ok" | "error" | "disabled" };
}

/** Fetch both beacons (primary + backup) and merge them. */
export async function fetchBeaconSignal(fetchImpl: typeof fetch = fetch): Promise<BeaconFetchResult> {
  const events: Array<{ at: number; text: string }> = [];
  const sources: BeaconFetchResult["sources"] = { webhook: "disabled", ntfy: "disabled" };

  const primary = beaconUrl();
  if (primary) {
    try {
      const response = await fetchImpl(`${primary.replace(/\/+$/, "")}/requests`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        events.push(...parseWebhookRequests(await response.json()));
        sources.webhook = "ok";
      } else {
        sources.webhook = "error";
      }
    } catch {
      sources.webhook = "error";
    }
  }

  const backup = beaconBackupUrl();
  if (backup) {
    try {
      const response = await fetchImpl(backup, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        events.push(...parseNtfyLines(await response.text()));
        sources.ntfy = "ok";
      } else {
        sources.ntfy = "error";
      }
    } catch {
      sources.ntfy = "error";
    }
  }

  return { signal: interpretBeacon(events), sources };
}
