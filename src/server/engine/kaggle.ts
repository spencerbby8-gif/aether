import type { EngineId, EngineState } from "./contract";
import { getAetherNotebook } from "./aether-engine-source";

/** Legacy non-throwing wrapper around the handoff's fail-closed accessor. */
function getVerifiedSource(): { ok: boolean; source?: string; sha256?: string; reason?: string } {
  try {
    const source = getAetherNotebook();
    return { ok: true, source };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/**
 * Kaggle control plane — TWO independent Kaggle accounts, one per engine.
 *
 *   Engine A: KAGGLE_USERNAME  + KAGGLE_KEY   + ENGINE_KERNEL_A
 *   Engine B: KAGGLE_USERNAME_B + KAGGLE_KEY_B + ENGINE_KERNEL_B
 *
 * Credentials come ONLY from server env and are never serialized into any
 * response, log line, bundle or client-visible surface. Engine URLs are
 * never hardcoded: each engine announces its rotating trycloudflare URL
 * through the beacons after wake, and we discover it dynamically.
 */

const KAGGLE_API = "https://www.kaggle.com/api/v1";

export interface KaggleWakeResult {
  state: EngineState;
  detail: string;
}

export interface EngineCredentials {
  username: string;
  key: string;
}

/** Exact per-engine credential mapping — matches the Netlify configuration. */
export function credentialsFor(engine: EngineId): EngineCredentials | null {
  const env: Record<EngineId, { user?: string; key?: string }> = {
    a: { user: process.env.KAGGLE_USERNAME, key: process.env.KAGGLE_KEY },
    b: { user: process.env.KAGGLE_USERNAME_B, key: process.env.KAGGLE_KEY_B },
    c: { user: process.env.KAGGLE_USERNAME_C, key: process.env.KAGGLE_KEY_C },
  };
  const creds = env[engine];
  return creds.user && creds.key ? { username: creds.user, key: creds.key } : null;
}

/** Explicit kernel-slug override (ENGINE_KERNEL_A / _B / _C). */
export function kernelSlugOverride(engine: EngineId): string | null {
  const env: Record<EngineId, string | undefined> = {
    a: process.env.ENGINE_KERNEL_A,
    b: process.env.ENGINE_KERNEL_B,
    c: process.env.ENGINE_KERNEL_C,
  };
  const slug = env[engine];
  return slug && slug.includes("/") ? slug : null;
}

/* Discovered slugs are cached per engine for the process lifetime. */
const slugCache = new Map<EngineId, string>();

export function clearSlugCache(): void {
  slugCache.clear();
}

interface KaggleKernelListing {
  ref?: string;
  title?: string;
  lastRunTime?: string;
  dateCreated?: string;
}

export interface DiscoveryOutcome {
  slug: string | null;
  /** Safe diagnostics: Kaggle's verdicts (HTTP statuses / counts), never secrets. */
  verdict: string;
}

function parseListing(body: unknown): Array<{ ref: string; title: string; when: string }> {
  const record = body as KaggleKernelListing[] | { kernels?: KaggleKernelListing[] };
  const list = Array.isArray(record) ? record : (record?.kernels ?? []);
  return list
    .map((k) => ({ ref: typeof k.ref === "string" ? k.ref : "", title: k.title ?? "", when: k.lastRunTime ?? k.dateCreated ?? "" }))
    .filter((k) => k.ref.includes("/"));
}

async function fetchListing(url: string, creds: EngineCredentials, fetchImpl: typeof fetch): Promise<{ status: number; kernels: Array<{ ref: string; title: string; when: string }> }> {
  try {
    const response = await fetchImpl(url, {
      headers: { authorization: basicAuth(creds), accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { status: response.status, kernels: [] };
    return { status: response.status, kernels: parseListing(await response.json()) };
  } catch {
    return { status: 0, kernels: [] };
  }
}

/**
 * Resolve the kernel to wake for an engine:
 *   1. Explicit override: ENGINE_KERNEL_A / ENGINE_KERNEL_B.
 *   2. Discovery: list the account's kernels through the real Kaggle API
 *      (authenticated with that engine's credentials) — trying the
 *      authenticated user's own kernels first, then the user's public list —
 *      and pick the engine kernel: recognizable names first, then newest.
 * The Netlify contract therefore works with the five configured variables
 * alone; the overrides exist for pinning a specific kernel.
 */
export async function resolveKernelSlug(engine: EngineId, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  return (await discoverKernel(engine, fetchImpl)).slug;
}

/** Full discovery with safe diagnostics for failure reporting. */
export async function discoverKernel(engine: EngineId, fetchImpl: typeof fetch = fetch): Promise<DiscoveryOutcome> {
  const override = kernelSlugOverride(engine);
  if (override) return { slug: override, verdict: "override" };
  const cached = slugCache.get(engine);
  if (cached) return { slug: cached, verdict: "cached" };

  const creds = credentialsFor(engine);
  if (!creds) return { slug: null, verdict: "no-credentials" };

  const mine = await fetchListing(`${KAGGLE_API}/kernels/list?mine=true&pageSize=20`, creds, fetchImpl);
  const mineKernels = mine.kernels;
  const pickFrom = (list: Array<{ ref: string; title: string; when: string }>): string | null => {
    if (list.length === 0) return null;
    const recognizable = list.find((k) => /aether|nexus|engine|beacon|agent/i.test(`${k.ref} ${k.title}`));
    return (recognizable ?? [...list].sort((a, b) => b.when.localeCompare(a.when))[0]).ref;
  };

  const own = pickFrom(mineKernels);
  if (own) {
    slugCache.set(engine, own);
    return { slug: own, verdict: `discovered (mine=${mine.status}, ${mineKernels.length} kernels)` };
  }

  const byUser = await fetchListing(
    `${KAGGLE_API}/kernels/list?user=${encodeURIComponent(creds.username)}&pageSize=20`,
    creds,
    fetchImpl,
  );
  const pub = pickFrom(byUser.kernels);
  if (pub) {
    slugCache.set(engine, pub);
    return { slug: pub, verdict: `discovered (user=${byUser.status}, ${byUser.kernels.length} kernels)` };
  }

  return {
    slug: null,
    verdict: `no kernels visible (mine=${mine.status || "unreachable"}:${mineKernels.length}, user=${byUser.status || "unreachable"}:${byUser.kernels.length})`,
  };
}

/** @deprecated naming kept for clarity — use resolveKernelSlug for wake paths. */
export function kernelSlug(engine: EngineId): string | null {
  return kernelSlugOverride(engine);
}

/** True when a given engine has server-side credentials (slugs are discoverable). */
export function engineConfigured(engine: EngineId): boolean {
  return credentialsFor(engine) !== null;
}

function basicAuth(creds: EngineCredentials): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.key}`).toString("base64")}`;
}

/**
 * Request a kernel run (wake) for ONE engine using that engine's own
 * account credentials. Honest states:
 *  - error:  that engine's credentials/slug not configured server-side
 *  - waking: Kaggle accepted the run request
 *  - quota:  Kaggle refused on quota grounds
 */
export async function kaggleWakeKernel(engine: EngineId, fetchImpl: typeof fetch = fetch): Promise<KaggleWakeResult> {
  const creds = credentialsFor(engine);
  if (!creds) {
    return {
      state: "error",
      detail:
        engine === "a"
          ? "Engine A credentials (KAGGLE_USERNAME / KAGGLE_KEY) not configured on this server."
          : "Engine B credentials (KAGGLE_USERNAME_B / KAGGLE_KEY_B) not configured on this server.",
    };
  }
  const discovery = await discoverKernel(engine, fetchImpl);
  if (!discovery.slug) {
    /* No account identifiers in client-facing messages — verdicts are safe
       HTTP statuses/counts from Kaggle, never credentials. */
    return {
      state: "error",
      detail: `No Kaggle kernel found for engine ${engine.toUpperCase()} — ${discovery.verdict}. Set ENGINE_KERNEL_${engine.toUpperCase()} (format: username/kernel-slug) to pin it.`,
    };
  }
  const slug = discovery.slug;
  const [, kSlug] = slug.split("/");

  /* Wake = push the bundled VERIFIED engine source (SHA-256 pinned,
     runtime-verified right here via getAetherNotebook). No Kaggle source
     pulls, no env-var source requirement. Unverified content is never pushed. */
  const verified = getVerifiedSource();
  if (!verified.ok || !verified.source) {
    return { state: "error", detail: `Engine ${engine.toUpperCase()}: ${verified.reason ?? "verified source unavailable."}` };
  }

  try {
    const response = await fetchImpl(`${KAGGLE_API}/kernels/push`, {
      method: "POST",
      headers: {
        authorization: basicAuth(creds),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: slug,
        metadata: {
          id: slug,
          title: kSlug,
          code_file: "notebook.ipynb",
          language: "python",
          kernel_type: "notebook",
          is_private: true,
          enable_gpu: true,
          enable_internet: true,
          dataset_sources: [],
          competition_sources: [],
          kernel_sources: [],
        },
        blob: verified.source,
        userName: creds.username,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (response.ok) {
      return {
        state: "waking",
        detail: `Kaggle accepted the run request for engine ${engine.toUpperCase()} (verified notebook source).`,
      };
    }
    if (response.status === 403 && /quota/i.test(text)) {
      return { state: "quota", detail: `Kaggle reported the GPU quota is exhausted for engine ${engine.toUpperCase()}.` };
    }
    if (response.status === 401) {
      return { state: "error", detail: `Kaggle rejected the credentials for engine ${engine.toUpperCase()} (401).` };
    }
    return { state: "error", detail: `Kaggle API responded ${response.status} for engine ${engine.toUpperCase()}.` };
  } catch {
    return { state: "error", detail: "The Kaggle API could not be reached." };
  }
}

/** Best-effort kernel status probe using the engine's own credentials. */
export async function kaggleKernelStatus(engine: EngineId, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const creds = credentialsFor(engine);
  const slug = kernelSlug(engine);
  if (!creds || !slug) return null;
  const [userName, kSlug] = slug.split("/");
  try {
    const response = await fetchImpl(
      `${KAGGLE_API}/kernels/status?userName=${encodeURIComponent(userName)}&kernelSlug=${encodeURIComponent(`${userName}/${kSlug}`)}`,
      { headers: { authorization: basicAuth(creds) }, signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { status?: string };
    return body.status ?? null;
  } catch {
    return null;
  }
}

/** Protected shutdown: the server-only ENGINE_OFF_KEY authorizes engine-off. */
export function engineOffKey(): string | null {
  return process.env.ENGINE_OFF_KEY || null;
}
