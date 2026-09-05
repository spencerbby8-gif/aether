import { getAetherNotebook } from "./aether-engine-source";

/**
 * Aether engine control layer — faithful TypeScript port of the verified
 * aether-engine-runtime Netlify Functions (ensure-alive.js / engine-off.js).
 *
 * This is the single server-side control layer. On Netlify the bundled
 * Netlify Functions at /.netlify/functions/* implement the same logic; these
 * routes/logic mirror them exactly so behavior is identical locally and in
 * production. No Kaggle source is ever pulled; the push body is the pinned,
 * SHA-256-verified notebook from getAetherNotebook().
 *
 * Kaggle auth is Bearer <account key>. Kernel slugs are built from the env
 * usernames: `${KAGGLE_USERNAME}/qwen-3-8-27b-uncensored-chat` (A) and
 * `${KAGGLE_USERNAME_B}/qwen-3-8-27b-uncensored-chat` (B).
 */

const KERNEL_SLUG = "qwen-3-8-27b-uncensored-chat";
const KERNEL_TITLE = "Qwen 3.8 27B Uncensored Chat";
const KAGGLE_API = "https://www.kaggle.com/api/v1";
const BEACON = "https://REMOVED_WEBHOOK_TOKEN/requests?sorting=newest";
const NTFY = "https://ntfy.sh/REMOVED_BEACON_TOPIC/json?poll=1&since=12h";
export const ENGINE_MODEL = "hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS";

export interface EngineLink {
  url: string;
  ageMinutes: number;
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
}

export interface KillResult {
  status: "off" | "error";
  killed: Array<{ url: string; result: string }>;
  message?: string;
}

interface Account {
  slot: "a" | "b" | "c";
  user: string;
  key: string;
  ds: string[];
}

/**
 * Three-account fleet. AUTO failover order is A → B → C (the array order).
 * Credentials come ONLY from server env — never exposed to the client.
 */
function accounts(filter?: "a" | "b" | "c"): Account[] {
  const accountA: Account = {
    slot: "a",
    user: process.env.KAGGLE_USERNAME ?? "",
    key: process.env.KAGGLE_KEY ?? "",
    ds: process.env.KAGGLE_DATASET_A ? [process.env.KAGGLE_DATASET_A] : [],
  };
  const accountB: Account = {
    slot: "b",
    user: process.env.KAGGLE_USERNAME_B ?? "",
    key: process.env.KAGGLE_KEY_B ?? "",
    ds: [],
  };
  const accountC: Account = {
    slot: "c",
    user: process.env.KAGGLE_USERNAME_C ?? "",
    key: process.env.KAGGLE_KEY_C ?? "",
    ds: [],
  };
  const all = [accountA, accountB, accountC].filter((a) => a.key && a.user);
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
      return { code: response.status, json: JSON.parse(text) };
    } catch {
      return { code: response.status, json: null, text: text.slice(0, 200) };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Newest LIVE LINKs from BOTH beacons (newest first, deduped). */
export async function getEngineLinks(beaconTimeoutMs = 15_000): Promise<EngineLink[]> {
  const out: EngineLink[] = [];
  const jobs = await Promise.allSettled([
    fetchJson(BEACON, {}, beaconTimeoutMs),
    fetch(NTFY, { signal: AbortSignal.timeout(beaconTimeoutMs) }).then((r) => r.text()),
  ]);
  const beacon = jobs[0].status === "fulfilled" ? jobs[0].value : null;
  if (beacon && (beacon.json as { data?: Array<{ query?: { m?: string }; created_at?: string }> })) {
    for (const it of (beacon.json as { data?: Array<{ query?: { m?: string }; created_at?: string }> }).data ?? []) {
      const m = it.query?.m ?? "";
      const u = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(m);
      if (u && m.includes("LIVE LINK")) {
        out.push({ url: u[0], ageMinutes: Math.round((Date.now() - new Date(it.created_at ?? 0).getTime()) / 60_000) });
      }
    }
  }
  if (jobs[1].status === "fulfilled" && typeof jobs[1].value === "string") {
    for (const line of jobs[1].value.split("\n")) {
      try {
        const d = JSON.parse(line) as { message?: string; time?: number };
        const u = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.message ?? "");
        if (u && (d.message ?? "").includes("LIVE LINK")) {
          out.push({ url: u[0], ageMinutes: Math.round((Date.now() - (d.time ?? 0) * 1000) / 60_000) });
        }
      } catch {
        /* skip malformed line */
      }
    }
  }
  const best: Record<string, EngineLink> = {};
  for (const l of out) if (!best[l.url] || l.ageMinutes < best[l.url].ageMinutes) best[l.url] = l;
  return Object.values(best).sort((a, b) => a.ageMinutes - b.ageMinutes).slice(0, 4);
}

/** An engine is alive when GET {url}/api/ps → 200 + non-empty models[]. */
export async function isEngineAlive(url: string, timeoutMs = 9_000): Promise<boolean> {
  try {
    const { code, json } = await fetchJson(`${url}/api/ps`, {}, timeoutMs);
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
}

/**
 * Discovery cache. Status polling hits this endpoint every few seconds;
 * without a cache each poll re-fetches two beacons and probes every tunnel,
 * which is slow enough to exceed the host's function timeout (the cause of
 * the stuck engine switch). A short TTL keeps the reported state truthful
 * while making repeated polls effectively free.
 */
const DISCOVERY_CACHE_TTL_MS = 4_000;
let discoveryCache: { at: number; result: DiscoverResult } | null = null;

/**
 * Wake-in-progress tracking. When ensure-alive successfully pushes a kernel,
 * we record it so the status endpoint can report "waking" — the engine is
 * booting but /api/ps isn't up yet. This is what keeps the UI's "Waking…"
 * state truthful for the full ~10 minute boot instead of reverting to
 * "Engine off" after a few seconds.
 */
const WAKE_TRACK_TTL_MS = 15 * 60_000; // a real boot can take up to ~15 min
let lastWakePushAt: number | null = null;

/** Record that a wake push was successfully dispatched. */
export function markWakeDispatched(): void {
  lastWakePushAt = Date.now();
}

/** True when a wake was dispatched recently and no engine is live yet. */
function isWakeInFlight(): boolean {
  return lastWakePushAt !== null && Date.now() - lastWakePushAt < WAKE_TRACK_TTL_MS;
}

/** Test hook: clear the discovery cache between scenarios. */
export function resetDiscoveryCache(): void {
  discoveryCache = null;
  lastWakePushAt = null;
}

/**
 * Discover an already-alive engine WITHOUT waking anything.
 * Reads the beacons, health-checks every advertised tunnel IN PARALLEL
 * (fast — bounded by the slowest single probe, not the sum), and returns
 * the first confirmed-live one. Used by the UI to show real engine state
 * / power control. Never reports an engine live unless /api/ps confirms it.
 */
export async function discoverAlive(): Promise<DiscoverResult> {
  const cached = discoveryCache;
  if (cached && Date.now() - cached.at < DISCOVERY_CACHE_TTL_MS) {
    return cached.result;
  }

  const started = Date.now();
  const links = await getEngineLinks();
  /* Parallel health probes — first success wins, all bounded. */
  const checks = links.map(async (link) => ({ url: link.url, alive: await isEngineAlive(link.url) }));
  const results = await Promise.all(checks);
  const live = results.find((r) => r.alive);
  if (live) {
    const result: DiscoverResult = {
      alive: true,
      url: live.url,
      model: ENGINE_MODEL,
      checked: links.length,
      waking: false,
      latencyMs: Date.now() - started,
    };
    discoveryCache = { at: Date.now(), result };
    return result;
  }
  /* No live engine. Detect a boot-in-progress if we can query kernel status. */
  /* No live engine. Is a boot in progress? Two signals, checked cheaply:
     1) we dispatched a wake push recently (no Kaggle API call needed)
     2) a kernel reports queued/starting/running (needs credentials) */
  let waking = isWakeInFlight();
  if (!waking) {
    try {
      const accs = accounts();
      for (const acc of accs) {
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
  };
  discoveryCache = { at: Date.now(), result };
  return result;
}

async function kernelStatus(acc: Account, timeoutMs = 15_000): Promise<string | null> {
  const r = await fetchJson(
    `${KAGGLE_API}/kernels/status?userName=${encodeURIComponent(acc.user)}&kernelSlug=${KERNEL_SLUG}`,
    { headers: { Authorization: `Bearer ${acc.key}` } },
    timeoutMs,
  );
  const json = r.json as { status?: string } | null;
  return json?.status ?? null;
}

async function wakeKernel(acc: Account): Promise<unknown> {
  const notebook = getAetherNotebook(); // throws on any byte drift — never pushes unverified
  const body = {
    slug: `${acc.user}/${KERNEL_SLUG}`,
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

/**
 * Wake / discover — faithful port of ensure-alive.js.
 * Returns an alive engine URL, or wakes whichever account has quota left
 * (A→B failover on quota), or reports waking/error.
 *
 * `account` selects strict routing: "a" or "b" limits the wake to that
 * account only (no silent switch); omitted/"auto" uses the handoff's
 * dual-account behavior (try A, then fail over to B on quota).
 */
export async function resolveEngine(account?: "a" | "b" | "c", deadlineMs = 25_000): Promise<ResolveResult> {
  const deadline = Date.now() + deadlineMs;
  const timeLeft = () => deadline - Date.now();

  /* 1) any engine already alive? An alive engine needs no credentials to use —
     check this FIRST so a live engine is always reachable even when account
     credentials are missing or rotated. Probes are PARALLEL and capped by the
     remaining budget so this route always answers promptly. */
  const links = await getEngineLinks(Math.min(8_000, Math.max(2_000, timeLeft())));
  const probeBudget = Math.min(5_000, Math.max(1_000, timeLeft()));
  const alive: EngineLink[] = [];
  await Promise.all(
    links.map(async (l) => {
      if (await isEngineAlive(l.url, probeBudget)) alive.push(l);
    }),
  );
  if (alive.length > 0) {
    return { status: "alive", url: alive[0].url, engines: alive, model: ENGINE_MODEL, ageMinutes: alive[0].ageMinutes };
  }
  if (timeLeft() <= 0) {
    return { status: "waking", etaMinutes: 10, reason: "discovery timed out — a boot may still be in progress" };
  }

  /* 2) nothing alive — waking needs credentials. */
  const accs = accounts(account);
  if (accs.length === 0) {
    const envNames: Record<string, string> = {
      a: "KAGGLE_KEY / KAGGLE_USERNAME",
      b: "KAGGLE_KEY_B / KAGGLE_USERNAME_B",
      c: "KAGGLE_KEY_C / KAGGLE_USERNAME_C",
    };
    return {
      status: "error",
      message: `${envNames[account ?? "a"]} env vars not set on the server.`,
    };
  }

  /* 3) wake the first account that can (skip dead quota / in-flight boots).
     Each step is capped by the remaining budget so the route always answers. */
  const quotaErrors: string[] = [];
  for (const acc of accs) {
    if (timeLeft() <= 0) {
      return { status: "waking", etaMinutes: 10, reason: "wake dispatch timed out — a boot may still be in progress" };
    }
    let st: string | null = null;
    try {
      st = await kernelStatus(acc, Math.min(10_000, Math.max(2_000, timeLeft())));
    } catch {
      st = null;
    }
    if (st === "queued") {
      return { status: "waking", etaMinutes: 10, reason: `version queued on ${acc.user}` };
    }
    if (links[0] && links[0].ageMinutes < 20 && st && st !== "complete" && st !== "error") {
      return { status: "waking", etaMinutes: Math.max(2, 10 - links[0].ageMinutes), reason: `boot in progress on ${acc.user}` };
    }
      try {
        await wakeKernel(acc);
        markWakeDispatched(); // status endpoint now reports "waking" for the boot
        return { status: "waking", etaMinutes: 10, reason: `wake push sent to ${acc.user}` };
      } catch (error) {
        const msg = String((error as Error)?.message ?? error);
        if (msg.includes("session count")) {
          return { status: "waking", etaMinutes: 10, reason: `session transition in progress on ${acc.user}` };
        }
        if (msg.toLowerCase().includes("quota")) {
          quotaErrors.push(`${acc.user}: out of GPU quota`);
          continue; // A→B failover: try next account
        }
        /* Non-quota push failure (e.g. Kaggle 401/5xx). For a strict
           single-account wake this is terminal; for AUTO keep trying the
           next account before reporting. */
        if (account) return { status: "error", message: msg };
        quotaErrors.push(`${acc.user}: ${msg}`);
        continue;
      }
    }
    return {
      status: "error",
      message: `no engine could be woken (${quotaErrors.join("; ")})`,
    };
  }

/**
 * Kill-all — faithful port of engine-off.js. Finds every alive engine on the
 * beacons and POSTs {url}/off with the X-Engine-Key header.
 */
export async function killAllEngines(fetchImpl: typeof fetch = fetch): Promise<KillResult> {
  void fetchImpl;
  const KEY = process.env.ENGINE_OFF_KEY;
  if (!KEY) return { status: "error", killed: [], message: "ENGINE_OFF_KEY env var not set on the server." };

  const links = (await getEngineLinks()).filter((l) => l.ageMinutes < 360); // current sessions only
  if (links.length === 0) {
    return { status: "off", killed: [], message: "no running engines found - all engines already off" };
  }

  const killed: Array<{ url: string; result: string }> = [];
  let forbidden = false;
  for (const l of links) {
    try {
      const r = await fetchJson(
        `${l.url}/off`,
        { method: "POST", headers: { "X-Engine-Key": KEY, "Content-Type": "application/json" } },
        10_000,
      );
      if (r.code === 200) killed.push({ url: l.url, result: "shutdown" });
      else if (r.code === 403) {
        forbidden = true;
        killed.push({ url: l.url, result: "rejected-key" });
      } else killed.push({ url: l.url, result: "unreachable" });
    } catch {
      killed.push({ url: l.url, result: "already off" });
    }
  }
  const anyShutdown = killed.some((k) => k.result === "shutdown");
  return {
    status: "off",
    killed,
    message: anyShutdown
      ? `${killed.filter((k) => k.result === "shutdown").length} engine(s) shut down - quota saved`
      : "no running engine reached - all already off",
  };
}
