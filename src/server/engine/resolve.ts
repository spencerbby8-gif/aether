import { getAetherNotebook } from "./aether-engine-source";
import {
  ENGINE_CHAT_PATH,
  ENGINE_HEALTH_PATH,
  ENGINE_IDS,
  ENGINE_OFF_HEADER,
  ENGINE_OFF_PATH,
  beaconBackupUrl,
  beaconSecret,
  beaconUrl,
  engineOffKey,
  engineUrlOverride,
  type EngineId,
  KAGGLE_API,
  wakeTrackTtlMs,
} from "./contract";
import { verifyAnnouncement } from "./beacon";
import {
  durableGuardActive,
  hydrateEngineState,
  recordWakeDispatch,
  wakeDispatchedWithin,
} from "./state-store";
import { shutdownConfirmed, shutdownEngineUrl } from "./shutdown";

/**
 * Aether engine control layer — THE single server-side control implementation.
 *
 * FIX (audit R2): the divergent Kaggle client that lived in kaggle.ts (Basic
 * auth + snake_case push body + heuristic kernel discovery) is gone. Everything
 * here uses the documented Kaggle REST contract: `Authorization: Bearer <key>`
 * with a camelCase push body, and an explicit kernel slug per engine. One
 * behaviour, one place.
 *
 * FIX (audit C2): beacon endpoints come from env, and when BEACON_SECRET is set
 * an announcement must carry a valid HMAC or it is ignored.
 *
 * FIX (audit C5): per-slot resolution is attributed. A slot resolves from its
 * own ENGINE_URL_<slot> override or its own tagged announcement; an untagged
 * announcement can only be adopted in AUTO mode.
 *
 * No Kaggle source is ever pulled; the push body is the pinned, SHA-256-verified
 * notebook from getAetherNotebook().
 */

const DEFAULT_KERNEL_SLUG = "qwen-3-8-27b-uncensored-chat";
const KERNEL_TITLE = "Qwen 3.8 27B Uncensored Chat";

export const ENGINE_MODEL = "hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS";

export interface EngineLink {
  url: string;
  ageMinutes: number;
  /** Slot the announcement attributed itself to, when it did. */
  slot: EngineId | null;
}

export interface ResolveResult {
  status: "alive" | "waking" | "error";
  url?: string;
  engines?: EngineLink[];
  model?: string;
  ageMinutes?: number;
  etaMinutes?: number;
  reason?: string;
  message?: string;
  /** Which slot answered, when known. */
  slot?: EngineId | null;
}

export interface KillResult {
  status: "off" | "error";
  /**
   * `slot` is carried alongside the URL because the HTTP layer identifies
   * engines by slot and never exposes the URL (audit C2). It is null only when
   * a link was announced without a recognisable engine tag.
   */
  killed: Array<{ url: string; result: string; slot?: EngineId | null }>;
  message?: string;
}

interface Account {
  slot: EngineId;
  user: string;
  key: string;
  ds: string[];
}

/** Per-engine kernel slug, pinnable via ENGINE_KERNEL_<A|B|C>. */
export function kernelSlugFor(slot: EngineId): string {
  const env: Record<EngineId, string | undefined> = {
    a: process.env.ENGINE_KERNEL_A,
    b: process.env.ENGINE_KERNEL_B,
    c: process.env.ENGINE_KERNEL_C,
  };
  const raw = env[slot];
  if (!raw) return DEFAULT_KERNEL_SLUG;
  /* Accept either "slug" or "username/slug"; we only need the slug part. */
  return raw.includes("/") ? raw.split("/").pop()! : raw;
}

/**
 * Three-account fleet. AUTO failover order is A → B → C (the array order).
 * Credentials come ONLY from server env — never exposed to the client.
 */
export function accounts(filter?: EngineId): Account[] {
  const defs: Account[] = [
    {
      slot: "a",
      user: process.env.KAGGLE_USERNAME ?? "",
      key: process.env.KAGGLE_KEY ?? "",
      ds: process.env.KAGGLE_DATASET_A ? [process.env.KAGGLE_DATASET_A] : [],
    },
    {
      slot: "b",
      user: process.env.KAGGLE_USERNAME_B ?? "",
      key: process.env.KAGGLE_KEY_B ?? "",
      ds: process.env.KAGGLE_DATASET_B ? [process.env.KAGGLE_DATASET_B] : [],
    },
    {
      slot: "c",
      user: process.env.KAGGLE_USERNAME_C ?? "",
      key: process.env.KAGGLE_KEY_C ?? "",
      ds: process.env.KAGGLE_DATASET_C ? [process.env.KAGGLE_DATASET_C] : [],
    },
  ];
  const all = defs.filter((a) => a.key && a.user);
  return filter ? all.filter((a) => a.slot === filter) : all;
}

async function fetchJson(
  url: string,
  opts: RequestInit = {},
  timeoutMs = 12_000,
): Promise<{ code: number; json: unknown; text?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...opts, signal: controller.signal });
    const text = await response.text();
    try {
      return { code: response.status, json: JSON.parse(text) }
    } catch {
      return { code: response.status, json: null, text: text.slice(0, 200) };
    }
  } finally {
    clearTimeout(timer);
  }
}

const LIVE_LINK_RE = /https?:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const ENGINE_TAG_RE = /engine\s*[:=]?\s*([abc])\b/i;

function slotFromText(text: string): EngineId | null {
  const m = ENGINE_TAG_RE.exec(text);
  if (!m) return null;
  const t = m[1].toLowerCase();
  return t === "a" || t === "b" || t === "c" ? t : null;
}

/**
 * Newest LIVE LINKs from the configured beacons (newest first, deduped).
 * Returns [] when no beacon is configured — the caller then falls back to
 * explicit ENGINE_URL_* overrides.
 */
export async function getEngineLinks(beaconTimeoutMs = 15_000): Promise<EngineLink[]> {
  const primary = beaconUrl();
  const backup = beaconBackupUrl();
  if (!primary && !backup) return [];

  const out: EngineLink[] = [];
  const jobs = await Promise.allSettled([
    primary
      ? fetchJson(`${primary.replace(/\/+$/, "")}/requests?sorting=newest`, {}, beaconTimeoutMs)
      : Promise.resolve(null),
    backup
      ? fetch(backup, { signal: AbortSignal.timeout(beaconTimeoutMs) }).then((r) => r.text())
      : Promise.resolve(null),
  ]);

  const beacon = jobs[0].status === "fulfilled" ? jobs[0].value : null;
  if (beacon) {
    for (const it of (beacon.json as { data?: Array<{ query?: { m?: string }; created_at?: string }> })?.data ?? []) {
      const m = it.query?.m ?? "";
      if (!m.includes("LIVE LINK")) continue;
      if (!verifyAnnouncement(m)) continue; // reject unsigned/spoofed
      const u = LIVE_LINK_RE.exec(m);
      if (u) {
        out.push({
          url: u[0],
          ageMinutes: Math.round((Date.now() - new Date(it.created_at ?? 0).getTime()) / 60_000),
          slot: slotFromText(m),
        });
      }
    }
  }

  if (jobs[1].status === "fulfilled" && typeof jobs[1].value === "string") {
    for (const line of jobs[1].value.split("\n")) {
      try {
        const d = JSON.parse(line) as { message?: string; time?: number };
        const m = d.message ?? "";
        if (!m.includes("LIVE LINK")) continue;
        if (!verifyAnnouncement(m)) continue;
        const u = LIVE_LINK_RE.exec(m);
        if (u) {
          out.push({
            url: u[0],
            ageMinutes: Math.round((Date.now() - (d.time ?? 0) * 1000) / 60_000),
            slot: slotFromText(m),
          });
        }
      } catch {
        /* skip malformed line */
      }
    }
  }

  const best: Record<string, EngineLink> = {};
  for (const l of out) {
    const existing = best[l.url];
    /* Prefer the newest sighting, and keep an attributed slot over an unknown one. */
    if (!existing || l.ageMinutes < existing.ageMinutes || (!existing.slot && l.slot)) best[l.url] = l;
  }
  return Object.values(best)
    .sort((a, b) => a.ageMinutes - b.ageMinutes)
    .slice(0, 6);
}

/** An engine is alive when GET {url}/api/ps → 200 + non-empty models[]. */
export async function isEngineAlive(url: string, timeoutMs = 9_000): Promise<boolean> {
  try {
    const { code, json } = await fetchJson(`${url.replace(/\/$/, "")}${ENGINE_HEALTH_PATH}`, {}, timeoutMs);
    const ps = json as { models?: unknown[] } | null;
    return code === 200 && !!ps && Array.isArray(ps.models) && ps.models.length > 0;
  } catch {
    return false;
  }
}

export interface DiscoverResult {
  alive: boolean;
  url: string | null;
  model: string | null;
  checked: number;
  /** True when a kernel is booting/queued (only knowable with credentials). */
  waking: boolean;
  /** How long the live determination took (ms) — performance telemetry. */
  latencyMs: number;
  /** Slot of the live engine when it was attributed. */
  slot?: EngineId | null;
}

/**
 * Discovery cache. Status polling hits this endpoint every few seconds; without
 * a cache each poll re-fetches the beacons and probes every tunnel.
 */
const DISCOVERY_CACHE_TTL_MS = 4_000;
let discoveryCache: { at: number; result: DiscoverResult } | null = null;

/**
 * Wake-in-progress tracking, per slot. Lets the status endpoint report "waking"
 * truthfully for the full boot instead of reverting to "off".
 */
const wakePushAt = new Map<EngineId, number>();

export function markWakeDispatched(slot?: EngineId): void {
  if (slot) wakePushAt.set(slot, Date.now());
  else for (const id of ENGINE_IDS) wakePushAt.set(id, Date.now());
}

function isWakeInFlight(slot?: EngineId): boolean {
  const now = Date.now();
  if (slot) {
    const at = wakePushAt.get(slot);
    return at !== undefined && now - at < wakeTrackTtlMs();
  }
  return [...wakePushAt.values()].some((at) => now - at < wakeTrackTtlMs());
}

/** Test hook: clear caches between scenarios. */
export function resetDiscoveryCache(): void {
  discoveryCache = null;
  wakePushAt.clear();
  healthCache = null;
}

/** Candidate URLs for a slot: explicit override first, then attributed beacon. */
async function candidatesFor(slot: EngineId, strict: boolean): Promise<EngineLink[]> {
  const override = engineUrlOverride(slot);
  if (override) return [{ url: override, ageMinutes: 0, slot }];
  const links = await getEngineLinks();
  const tagged = links.filter((l) => l.slot === slot);
  if (strict) return tagged;
  return [...tagged, ...links.filter((l) => l.slot === null)];
}

/**
 * Discover an already-alive engine WITHOUT waking anything.
 * Checks explicit per-slot overrides first, then beacon announcements, and
 * health-checks candidates in parallel. Never reports live without /api/ps.
 */
export async function discoverAlive(): Promise<DiscoverResult> {
  const cached = discoveryCache;
  if (cached && Date.now() - cached.at < DISCOVERY_CACHE_TTL_MS) return cached.result;

  const started = Date.now();

  /* Explicit overrides are authoritative and cheap — check them first. */
  const overrides = ENGINE_IDS.map((id) => ({ id, url: engineUrlOverride(id) })).filter(
    (o): o is { id: EngineId; url: string } => Boolean(o.url),
  );
  for (const o of overrides) {
    if (await isEngineAlive(o.url)) {
      const result: DiscoverResult = {
        alive: true,
        url: o.url,
        model: ENGINE_MODEL,
        checked: overrides.length,
        waking: false,
        latencyMs: Date.now() - started,
        slot: o.id,
      };
      discoveryCache = { at: Date.now(), result };
      return result;
    }
  }

  const links = await getEngineLinks();
  const results = await Promise.all(links.map(async (link) => ({ link, alive: await isEngineAlive(link.url) })));
  const live = results.find((r) => r.alive);
  if (live) {
    const result: DiscoverResult = {
      alive: true,
      url: live.link.url,
      model: ENGINE_MODEL,
      checked: links.length,
      waking: false,
      latencyMs: Date.now() - started,
      slot: live.link.slot,
    };
    discoveryCache = { at: Date.now(), result };
    return result;
  }

  /* No live engine. Is a boot in progress? */
  let waking = isWakeInFlight();
  if (!waking) {
    try {
      for (const acc of accounts()) {
        const st = await kernelStatus(acc, 4_000);
        if (st === "queued" || st === "starting" || st === "running") {
          waking = true;
          break;
        }
      }
    } catch {
      waking = false;
    }
  }
  const result: DiscoverResult = {
    alive: false,
    url: null,
    model: null,
    checked: links.length,
    waking,
    latencyMs: Date.now() - started,
    slot: null,
  };
  discoveryCache = { at: Date.now(), result };
  return result;
}

export async function kernelStatus(acc: Account, timeoutMs = 15_000): Promise<string | null> {
  const r = await fetchJson(
    `${KAGGLE_API}/kernels/status?userName=${encodeURIComponent(acc.user)}&kernelSlug=${encodeURIComponent(kernelSlugFor(acc.slot))}`,
    { headers: { Authorization: `Bearer ${acc.key}` } },
    timeoutMs,
  );
  const json = r.json as { status?: string } | null;
  return json?.status ?? null;
}

/** Push the verified notebook to one engine's kernel. Documented contract. */
export async function wakeKernel(acc: Account): Promise<unknown> {
  const notebook = getAetherNotebook(acc.slot); // throws on any byte drift — never pushes unverified
  const body = {
    slug: `${acc.user}/${kernelSlugFor(acc.slot)}`,
    newTitle: KERNEL_TITLE,
    text: notebook,
    language: "python",
    kernelType: "notebook",
    isPrivate: true,
    enableGpu: true,
    enableInternet: true,
    kernelDataSources: acc.ds,
  };
  const r = await fetchJson(
    `${KAGGLE_API}/kernels/push`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${acc.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    30_000,
  );
  const json = r.json as { error?: string; hasError?: boolean } | null;
  if (json && (json.error || json.hasError)) {
    throw new Error(`Kaggle push rejected: ${json.error ?? "unknown"}`);
  }
  if (r.code >= 400 || !r.json) {
    throw new Error(`Kaggle push HTTP ${r.code} ${r.text ?? ""}`);
  }
  return r.json;
}

/** Wake one specific slot. Exposed so the manager and the routes share one path. */
export async function wakeSlot(slot: EngineId): Promise<{ state: "waking" | "quota" | "error"; detail: string }> {
  const [acc] = accounts(slot);
  if (!acc) {
    const envNames: Record<EngineId, string> = {
      a: "KAGGLE_KEY / KAGGLE_USERNAME",
      b: "KAGGLE_KEY_B / KAGGLE_USERNAME_B",
      c: "KAGGLE_KEY_C / KAGGLE_USERNAME_C",
    };
    return { state: "error", detail: `${envNames[slot]} not configured on this server.` };
  }
  try {
    const st = await kernelStatus(acc, 10_000);
    if (st === "queued" || st === "starting" || st === "running") {
      return { state: "waking", detail: `kernel ${st} on ${acc.user}` };
    }
    /*
     * FIX (audit R3): refuse to push a kernel that ANOTHER INSTANCE already
     * pushed. `wakePushAt` above is per-process, so on a serverless host two
     * instances answering the same wake request each pushed their own kernel —
     * measured in the runtime proof as 2 Kaggle pushes for one logical wake,
     * against a 30 h/week GPU quota.
     *
     * Gated on a durable backend being configured: within one process
     * `activeWakes` and `isWakeInFlight()` already prevent a duplicate, so there
     * is nothing for this guard to add.
     */
    if (durableGuardActive()) {
      await hydrateEngineState();
      if (wakeDispatchedWithin(slot, wakeTrackTtlMs())) {
        return {
          state: "waking",
          detail: `wake already dispatched for engine ${slot} — not pushing a duplicate kernel`,
        };
      }
    }
    await wakeKernel(acc);
    markWakeDispatched(slot);
    recordWakeDispatch(slot);
    return { state: "waking", detail: `wake push sent to ${acc.user}` };
  } catch (error) {
    const msg = String((error as Error)?.message ?? error);
    if (msg.includes("session count")) return { state: "waking", detail: `session transition in progress on ${acc.user}` };
    if (msg.toLowerCase().includes("quota")) return { state: "quota", detail: `GPU quota exhausted on ${acc.user}` };
    return { state: "error", detail: msg };
  }
}

/**
 * Wake / discover. Returns an alive engine URL, or wakes whichever account has
 * quota left (deterministic A→B→C failover), or reports waking/error.
 *
 * `account` selects strict routing: "a"|"b"|"c" limits the wake to that slot
 * only (no silent switch); omitted/"auto" walks the fleet in order.
 */
export async function resolveEngine(account?: EngineId, deadlineMs = 25_000): Promise<ResolveResult> {
  const deadline = Date.now() + deadlineMs;
  const timeLeft = () => deadline - Date.now();

  /* 1) Explicit per-slot override — authoritative, needs no credentials. */
  if (account) {
    const override = engineUrlOverride(account);
    if (override) {
      if (await isEngineAlive(override, Math.min(5_000, Math.max(1_000, timeLeft())))) {
        return { status: "alive", url: override, model: ENGINE_MODEL, ageMinutes: 0, slot: account };
      }
      return {
        status: "error",
        slot: account,
        message: `ENGINE_URL_${account.toUpperCase()} is set but the engine did not answer ${ENGINE_HEALTH_PATH}.`,
      };
    }
  } else {
    for (const id of ENGINE_IDS) {
      const override = engineUrlOverride(id);
      if (override && (await isEngineAlive(override, 4_000))) {
        return { status: "alive", url: override, model: ENGINE_MODEL, ageMinutes: 0, slot: id };
      }
    }
  }

  /* 2) Any announced engine already alive? */
  const strict = Boolean(account);
  const links = strict ? await candidatesFor(account!, true) : await getEngineLinks(Math.min(8_000, Math.max(2_000, timeLeft())));
  const probeBudget = Math.min(5_000, Math.max(1_000, timeLeft()));
  const alive: EngineLink[] = [];
  await Promise.all(
    links.map(async (l) => {
      if (await isEngineAlive(l.url, probeBudget)) alive.push(l);
    }),
  );
  if (alive.length > 0) {
    const first = alive[0];
    return {
      status: "alive",
      url: first.url,
      engines: alive,
      model: ENGINE_MODEL,
      ageMinutes: first.ageMinutes,
      slot: first.slot ?? account ?? null,
    };
  }
  if (timeLeft() <= 0) {
    return { status: "waking", etaMinutes: 10, reason: "discovery timed out — a boot may still be in progress", slot: account ?? null };
  }

  /* 3) Nothing alive — waking needs credentials. */
  const accs = accounts(account);
  if (accs.length === 0) {
    const envNames: Record<EngineId, string> = {
      a: "KAGGLE_KEY / KAGGLE_USERNAME",
      b: "KAGGLE_KEY_B / KAGGLE_USERNAME_B",
      c: "KAGGLE_KEY_C / KAGGLE_USERNAME_C",
    };
    return { status: "error", slot: account ?? null, message: `${envNames[account ?? "a"]} env vars not set on the server.` };
  }

  /* 4) Wake the first account that can, in deterministic A→B→C order. */
  const failures: string[] = [];
  for (const acc of accs) {
    if (timeLeft() <= 0) {
      return { status: "waking", etaMinutes: 10, reason: "wake dispatch timed out — a boot may still be in progress", slot: acc.slot };
    }
    const outcome = await wakeSlot(acc.slot);
    if (outcome.state === "waking") {
      return { status: "waking", etaMinutes: 10, reason: outcome.detail, slot: acc.slot };
    }
    if (outcome.state === "quota") {
      failures.push(`${acc.user}: out of GPU quota`);
      continue; // deterministic failover to the next slot
    }
    /* Non-quota failure: terminal for a strict single-slot wake. */
    if (account) return { status: "error", slot: acc.slot, message: outcome.detail };
    failures.push(`${acc.user}: ${outcome.detail}`);
  }
  return { status: "error", slot: account ?? null, message: `no engine could be woken (${failures.join("; ")})` };
}

/**
 * Kill-all. Finds every alive engine (overrides + beacons) and POSTs {url}/off
 * with the X-Engine-Key header — the engine's real contract.
 *
 * Reports honestly: a slot is only "shutdown" on HTTP 200. A 403 means the key
 * was rejected; anything else means we could not confirm, and the caller must
 * not treat the fleet as down.
 */
export async function killAllEngines(): Promise<KillResult> {
  const KEY = engineOffKey();
  if (!KEY) {
    return { status: "error", killed: [], message: "ENGINE_OFF_KEY env var not set on the server." };
  }

  const targets: EngineLink[] = [];
  for (const id of ENGINE_IDS) {
    const override = engineUrlOverride(id);
    if (override) targets.push({ url: override, ageMinutes: 0, slot: id });
  }
  const announced = (await getEngineLinks()).filter((l) => l.ageMinutes < 360);
  for (const l of announced) if (!targets.some((t) => t.url === l.url)) targets.push(l);

  if (targets.length === 0) {
    return { status: "off", killed: [], message: "no running engines found - all engines already off" };
  }

  const killed: Array<{ url: string; result: string; slot?: EngineId | null }> = [];
  for (const t of targets) {
    /* The one and only shutdown implementation (audit B1). */
    const result = await shutdownEngineUrl(t.url, KEY, {
      isAlive: (u) => isEngineAlive(u, 4_000),
    });
    killed.push({ url: t.url, result, slot: t.slot ?? null });
  }

  const confirmed = killed.filter((k) => shutdownConfirmed(k.result as never));
  const failed = killed.length - confirmed.length;
  return {
    status: failed > 0 && confirmed.length === 0 ? "error" : "off",
    killed,
    message:
      failed === 0
        ? `${confirmed.length} engine(s) shut down - quota saved`
        : `${confirmed.length} shut down, ${failed} NOT confirmed (${killed.filter((k) => k.result !== "shutdown" && k.result !== "already-off").map((k) => k.result).join(", ")})`,
  };
}

/** Convenience re-export so callers have one import for the chat path. */
export { ENGINE_CHAT_PATH };

/* ------------------------------------------------------------------------ */
/* Per-slot fleet health                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Real per-engine health, from an actual `/api/ps` probe.
 *
 * FIX (audit §4.1 / P2.12): the UI used to render "ready"/"no key" from
 * `engineConfigured()`, i.e. "is the env var set" — so a dead engine displayed
 * as ready and a healthy engine with a rotated key displayed as broken. Health
 * and credential presence are different facts and are now reported separately.
 */
export interface SlotHealth {
  slot: EngineId;
  state: "live" | "waking" | "offline";
  /** Round-trip time of the successful /api/ps probe, when there was one. */
  latencyMs: number | null;
  /** True when at least one candidate URL was actually probed. */
  checked: boolean;
  /** A previously bound URL failed its health check and must be evicted (audit A5). */
  staleUrl: boolean;
}

export type FleetHealth = Record<EngineId, SlotHealth>;

const HEALTH_CACHE_TTL_MS = 5_000;
let healthCache: { at: number; result: FleetHealth } | null = null;

/**
 * Probe every slot independently. A slot is "live" only when its OWN attributed
 * URL answers `/api/ps` — never inherited from another slot's engine.
 *
 * `bound` lets the caller (the state route) contribute the URLs the manager has
 * already bound, so a rotated tunnel is detected and reported as stale instead
 * of continuing to be trusted.
 */
export async function probeFleetHealth(
  bound: Partial<Record<EngineId, string | null>> = {},
  opts: { force?: boolean } = {},
): Promise<FleetHealth> {
  if (!opts.force && healthCache && Date.now() - healthCache.at < HEALTH_CACHE_TTL_MS) {
    return healthCache.result;
  }

  /* One beacon read shared by all three slots — not one per slot. */
  const links = await getEngineLinks();

  const probe = async (slot: EngineId): Promise<SlotHealth> => {
    const override = engineUrlOverride(slot);
    const tagged = links.filter((l) => l.slot === slot).map((l) => l.url);
    const boundUrl = bound[slot] ?? null;
    /* Order matters: explicit override, then what we last bound, then beacon. */
    const candidates = [...new Set([override, boundUrl, ...tagged].filter((u): u is string => Boolean(u)))];

    let checked = false;
    let staleUrl = false;
    for (const url of candidates) {
      const started = Date.now();
      const alive = await isEngineAlive(url);
      checked = true;
      if (alive) {
        return { slot, state: "live", latencyMs: Date.now() - started, checked, staleUrl: false };
      }
      /* A URL we had bound but can no longer reach is stale, by definition. */
      if (url === boundUrl) staleUrl = true;
    }

    if (isWakeInFlight(slot)) return { slot, state: "waking", latencyMs: null, checked, staleUrl };
    return { slot, state: "offline", latencyMs: null, checked, staleUrl };
  };

  const entries = await Promise.all(ENGINE_IDS.map(probe));
  const result = Object.fromEntries(entries.map((e) => [e.slot, e])) as FleetHealth;
  healthCache = { at: Date.now(), result };
  return result;
}

/** Test hook. */
export function resetHealthCache(): void {
  healthCache = null;
}
