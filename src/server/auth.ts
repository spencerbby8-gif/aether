import crypto from "node:crypto";

/**
 * Control-plane authorization.
 *
 * FIX (audit C4): the engine control plane (wake / off / status) and the tool
 * executor were reachable by anyone with the URL, with no cookie, no token and
 * no CSRF protection. With production credentials set that meant any visitor
 * could kill every engine or push Kaggle kernels and burn GPU quota. Every
 * sensitive route now calls requireControlAuth() and is default-deny.
 *
 * Design notes (honest about the limits):
 *  - The shared token proves "this is an Aether client", it is not a per-user
 *    identity. Aether is a private, self-hosted, single-tenant tool, so this is
 *    the right weight; it is not a substitute for multi-tenant auth.
 *  - The token is read from server env only. It is never returned by any
 *    endpoint, never written to a log line, and never placed in a bundle.
 *  - A token embedded in a distributed APK is obfuscation, not secrecy: a
 *    determined attacker with the binary can extract it. The real protections
 *    are (a) the engine's own key, (b) network-level restriction, and
 *    (c) rotating the token. This is documented rather than pretended away.
 *  - When no token is configured the routes are REFUSED, not opened. Local
 *    development must opt in explicitly with AETHER_ALLOW_LOCAL_ANONYMOUS=1.
 */

const HEADER = "authorization";
const ALT_HEADER = "x-aether-control";

export function controlToken(): string | null {
  const token = process.env.AETHER_CONTROL_TOKEN;
  return token && token.length >= 16 ? token : null;
}

function localAnonymousAllowed(): boolean {
  return process.env.AETHER_ALLOW_LOCAL_ANONYMOUS === "1";
}

/** Constant-time comparison that is safe for differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function extractToken(request: Request): string | null {
  const auth = request.headers.get(HEADER);
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const alt = request.headers.get(ALT_HEADER);
  return alt ? alt.trim() : null;
}

/**
 * Authorize a control/tool request.
 * Returns null when authorized, or a 401/403 Response to return to the client.
 */
export function requireControlAuth(request: Request): Response | null {
  const expected = controlToken();

  if (!expected) {
    /* No token configured: refuse by default. Local dev may opt in. */
    if (localAnonymousAllowed()) return null;
    return Response.json(
      {
        ok: false,
        error:
          "Control plane is not configured: set AETHER_CONTROL_TOKEN (>=16 chars) on the server. " +
          "For local development set AETHER_ALLOW_LOCAL_ANONYMOUS=1.",
      },
      { status: 503 },
    );
  }

  const provided = extractToken(request);
  if (!provided) {
    return Response.json(
      { ok: false, error: "Missing control token. Send Authorization: Bearer <token>." },
      { status: 401, headers: { "www-authenticate": "Bearer" } },
    );
  }
  if (!safeEqual(provided, expected)) {
    return Response.json({ ok: false, error: "Invalid control token." }, { status: 403 });
  }
  return null;
}

/** Redact a token if it ever reaches a log/format path. */
export function redactToken(value: string): string {
  const token = controlToken();
  if (!token) return value;
  return value.split(token).join("[redacted-control-token]");
}
