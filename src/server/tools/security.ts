import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import path from "node:path";
import { Agent } from "undici";

/**
 * Security perimeter for the LOCAL workspace tools (file + web).
 * Everything is server-enforced: the client can ask, the server decides.
 *
 *  - Filesystem access is confined to the Aether run workspace.
 *  - Network access is http(s) only, on standard ports, and the ADDRESS ACTUALLY
 *    CONNECTED TO is validated — never just the hostname literal.
 *  - Known secret values are scrubbed from any tool output.
 *
 * FIX (audit R6): the previous guard only inspected `url.hostname` as a string.
 * It therefore allowed `http://[::ffff:169.254.169.254]/` (URL normalises the
 * host to `[::ffff:a9fe:a9fe]`, so the IPv4-mapped regex never matched) and any
 * hostname that resolves to a private address (`localtest.me` → 127.0.0.1,
 * `nip.io`, or a rebound domain). A request to the AWS metadata address was
 * observed reaching the service. The guard now resolves DNS and validates every
 * candidate address, and installs a connect-time lookup hook so the address
 * that is ACTUALLY dialed is re-validated — which also closes the
 * resolve-then-rebind (TOCTOU) window.
 */

/** Authorized workspace root. Nothing outside it is reachable by tools. */
export const WORKSPACE_ROOT = path.resolve(process.cwd(), process.env.AETHER_WORKSPACE_DIR ?? ".aether-run");

export function workspaceDir(...segments: string[]): string {
  return path.join(WORKSPACE_ROOT, ...segments);
}

/** Resolve a tool-supplied path inside the workspace. Throws on escape. */
export function resolveWorkspacePath(input: string, base?: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 512) {
    throw new ToolSecurityError("A non-empty path is required.");
  }
  if (input.includes("\0")) throw new ToolSecurityError("Invalid path.");
  const root = base ?? WORKSPACE_ROOT;
  const resolved = path.resolve(root, input.replace(/^\/+/, ""));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ToolSecurityError("Access denied: path escapes the Aether workspace.");
  }
  return resolved;
}

export function ensureInsideWorkspace(target: string): void {
  if (target !== WORKSPACE_ROOT && !target.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new ToolSecurityError("Access denied: outside the Aether workspace.");
  }
}

export class ToolSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolSecurityError";
  }
}

/* ---------------- network: address policy ---------------- */

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "metadata.goog",
]);
const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".lan"];

/**
 * Normalise any textual IP form to a canonical IPv4/IPv6 string so that the
 * hex/decimal/octal/IPv4-mapped spellings cannot slip past a naive check.
 * Returns null when the input is not an IP literal.
 */
export function canonicalIp(input: string): string | null {
  let host = input.trim().toLowerCase().replace(/^\[|\]$/g, "");

  /* IPv4-mapped IPv6: ::ffff:1.2.3.4 or ::ffff:0102:0304 */
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mappedDotted) host = mappedDotted[1];
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    host = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }

  /* Pure-integer / hex / octal IPv4 spellings. */
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (n >= 0 && n <= 0xffffffff) {
      host = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
  } else if (/^0x[0-9a-f]+$/.test(host)) {
    const n = parseInt(host, 16);
    if (n >= 0 && n <= 0xffffffff) {
      host = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
  } else if (/^0[0-7]+$/.test(host)) {
    const n = parseInt(host, 8);
    if (n >= 0 && n <= 0xffffffff) {
      host = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
  } else if (/^\d{1,3}(\.\d{1,3}){0,2}$/.test(host)) {
    /* Short-form IPv4 (e.g. 127.1) — expand it. */
    const parts = host.split(".").map((p) => Number(p));
    while (parts.length < 4) parts.splice(3, 0, 0);
    host = parts.join(".");
  }

  if (net.isIPv4(host) || net.isIPv6(host)) return host;
  return null;
}

/** True when an ADDRESS (already canonical) must never be contacted. */
export function ipBlocked(ip: string): boolean {
  const canonical = canonicalIp(ip);
  const target = canonical ?? ip.trim().toLowerCase();

  if (net.isIPv4(target)) {
    const parts = target.split(".").map(Number);
    if (parts.some((p) => !Number.isFinite(p))) return true;
    const [a, b] = parts;
    if (a === 127 || a === 10 || a === 0) return true; // loopback, private, "this network"
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (net.isIPv6(target)) {
    const lower = target.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
      return true; // link-local
    }
    if (lower.startsWith("ff")) return true; // multicast
    /* Any remaining IPv4-mapped form (defence in depth). */
    const mapped = canonicalIp(lower);
    if (mapped && net.isIPv4(mapped)) return ipBlocked(mapped);
    return false;
  }

  /* Not an IP literal at all — the caller must resolve it first. */
  return false;
}

/** Hostname-level policy, applied before any DNS work. */
function hostnameBlocked(host: string): boolean {
  if (BLOCKED_HOSTS.has(host)) return true;
  return BLOCKED_SUFFIXES.some((s) => host.endsWith(s));
}

/** Validate a URL's shape and literal host. Returns the normalized URL string. */
export function assertUrlAllowed(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolSecurityError("Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolSecurityError("Only http and https URLs are allowed.");
  }
  const explicitPort = url.port;
  if (explicitPort && explicitPort !== "80" && explicitPort !== "443") {
    throw new ToolSecurityError("Only standard ports (80/443) are allowed.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new ToolSecurityError("A host is required.");
  if (hostnameBlocked(host)) {
    throw new ToolSecurityError("Access denied: restricted host.");
  }
  /* Literal IPs are checked immediately; hostnames are checked at connect time
     by the guarded dispatcher (see guardedFetch). */
  const literal = canonicalIp(host);
  if (literal && ipBlocked(literal)) {
    throw new ToolSecurityError("Access denied: private or loopback address.");
  }
  return url.toString();
}

/**
 * Resolve a hostname and assert that EVERY address it resolves to is allowed.
 * Used as an explicit pre-flight check so rejections produce a clean error.
 */
export async function assertHostResolvesAllowed(host: string): Promise<string[]> {
  const literal = canonicalIp(host);
  if (literal) {
    if (ipBlocked(literal)) throw new ToolSecurityError("Access denied: private or loopback address.");
    return [literal];
  }
  if (hostnameBlocked(host)) throw new ToolSecurityError("Access denied: restricted host.");

  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new ToolSecurityError("Could not resolve host.");
  }
  if (addresses.length === 0) throw new ToolSecurityError("Could not resolve host.");
  for (const addr of addresses) {
    if (ipBlocked(addr.address)) {
      throw new ToolSecurityError("Access denied: host resolves to a private or loopback address.");
    }
  }
  return addresses.map((a) => a.address);
}

/**
 * A dispatcher that re-validates the address at CONNECT time. This is what
 * actually closes the hole: whatever IP the resolver hands back for the real
 * connection is checked, so a hostname that passes the pre-flight and then
 * rebinds to 169.254.169.254 is still refused.
 */
let guardedDispatcher: Agent | null = null;

export function getGuardedDispatcher(): Agent {
  if (guardedDispatcher) return guardedDispatcher;
  guardedDispatcher = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        const cb = typeof options === "function" ? options : callback;
        dns.lookup(hostname, { ...(typeof options === "object" ? options : {}), all: true }, (err, addresses) => {
          if (err) {
            (cb as (e: NodeJS.ErrnoException | null, a: unknown, f?: number) => void)(err, null);
            return;
          }
          const list = (addresses as dns.LookupAddress[]) ?? [];
          const blocked = list.find((a) => ipBlocked(a.address));
          if (blocked || list.length === 0) {
            const error = new Error(
              `Access denied: ${hostname} resolves to a private or loopback address.`,
            ) as NodeJS.ErrnoException;
            error.code = "EACCES";
            (cb as (e: NodeJS.ErrnoException | null, a: unknown, f?: number) => void)(error, null);
            return;
          }
          const first = list[0];
          (cb as (e: NodeJS.ErrnoException | null, a: string, f: number) => void)(null, first.address, first.family);
        });
      },
    },
  });
  return guardedDispatcher;
}

/**
 * fetch() that enforces the network policy end to end. Always use this for
 * agent/tool-originated requests — never bare fetch.
 */
export async function guardedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const raw = typeof input === "string" ? input : input.toString();
  const normalized = assertUrlAllowed(raw);
  const host = new URL(normalized).hostname.replace(/^\[|\]$/g, "");
  /* Pre-flight gives a clear, actionable error message. */
  await assertHostResolvesAllowed(host);
  return fetch(normalized, { ...init, dispatcher: getGuardedDispatcher() } as RequestInit);
}

/* ---------------- secrets ---------------- */

/** Every env var whose VALUE must never appear in output leaving the server. */
function sensitiveValues(): Array<string | undefined> {
  return [
    process.env.AETHER_AGENT_KEY,
    process.env.AETHER_AGENT_URL,
    process.env.DATABASE_URL,
    /* Every engine account — A, B and C, keys AND usernames. */
    process.env.KAGGLE_KEY,
    process.env.KAGGLE_KEY_B,
    process.env.KAGGLE_KEY_C,
    process.env.KAGGLE_USERNAME,
    process.env.KAGGLE_USERNAME_B,
    process.env.KAGGLE_USERNAME_C,
    process.env.ENGINE_OFF_KEY,
    process.env.AETHER_CONTROL_TOKEN,
    process.env.BEACON_SECRET,
    process.env.ENGINE_KERNEL_A,
    process.env.ENGINE_KERNEL_B,
    process.env.ENGINE_KERNEL_C,
    process.env.ENGINE_URL_A,
    process.env.ENGINE_URL_B,
    process.env.ENGINE_URL_C,
  ];
}

/** Scrub known secret values from any text leaving the server. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const value of sensitiveValues()) {
    if (value && value.length >= 4) {
      out = out.split(value).join("[redacted]");
    }
  }
  /* Generic bearer/api-key style tokens. */
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{24,})/g, "[redacted-token]");
  /* Never let an engine tunnel URL out through a tool result. */
  out = out.replace(/https?:\/\/[a-z0-9-]+\.trycloudflare\.com[^\s"'<)]*/gi, "[engine-url]");
  return out;
}

/* ---------------- misc ---------------- */

export function shortId(prefix: string): string {
  return `${prefix}-${createHash("sha1").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 10)}`;
}

/** HMAC helper shared with the beacon signer. */
export function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/** Constant-time string equality. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`, truncated: true };
}

/** Slugify for directory names. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "run"
  );
}
