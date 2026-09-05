import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";

/**
 * Security perimeter for the LOCAL workspace tools (file + web).
 * Everything is server-enforced: the client can ask, the server decides.
 *
 *  - Filesystem access is confined to the Aether run workspace.
 *  - Network access is http(s) only, on standard ports, never to
 *    loopback/private/link-local/metadata addresses.
 *  - Known secret values are scrubbed from any tool output.
 *
 * Arbitrary command execution is NOT a local concern: it runs on the agent's
 * real execution environment (the engine) via the `run_command` engine tool.
 */

/** Authorized workspace root. Nothing outside it is reachable by tools. */
export const WORKSPACE_ROOT = path.resolve(process.cwd(), ".aether-run");

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

/* ---------------- network ---------------- */

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "instance-data"]);
const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost"];

function ipBlocked(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 127 || parts[0] === 10 || parts[0] === 0) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local + cloud metadata
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8")) return true;
    /* IPv4-mapped ::ffff:a.b.c.d */
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return ipBlocked(mapped[1]);
    return false;
  }
  return false;
}

/** Validate a URL for agent network access. Returns the normalized URL string. */
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
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new ToolSecurityError("Access denied: restricted host.");
  }
  if (ipBlocked(host)) {
    throw new ToolSecurityError("Access denied: private or loopback address.");
  }
  return url.toString();
}

/* ---------------- secrets ---------------- */

/** Scrub known secret values from any text leaving the server. */
export function redactSecrets(text: string): string {
  let out = text;
  const sensitive = [
    process.env.AETHER_AGENT_KEY,
    process.env.AETHER_AGENT_URL,
    process.env.DATABASE_URL,
    /* Phase 5 two-account engine secrets. */
    process.env.KAGGLE_KEY,
    process.env.KAGGLE_KEY_B,
    process.env.ENGINE_OFF_KEY,
  ];
  for (const value of sensitive) {
    if (value && value.length > 0) {
      out = out.split(value).join("[redacted]");
    }
  }
  /* Generic bearer/api-key style tokens. */
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{24,})/g, "[redacted-token]");
  return out;
}

/* ---------------- misc ---------------- */

export function shortId(prefix: string): string {
  return `${prefix}-${createHash("sha1").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 10)}`;
}

export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`, truncated: true };
}

/** Slugify for directory names. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "run";
}
