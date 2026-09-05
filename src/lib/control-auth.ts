/**
 * Control-plane credential delivery for the browser/native client.
 *
 * Every sensitive route (`/api/agent/stream`, `/api/engine/state`,
 * `/api/netlify/*`, `/api/tools/exec`) now requires the control token. The
 * token must NOT be baked into the JS bundle, a `NEXT_PUBLIC_` variable, or
 * IndexedDB — those are all readable by anything that can open the app's
 * storage. Instead it is handed to the page at runtime by the native shell:
 *
 *   Android (Capacitor bridge):  window.AetherNative.controlToken() -> string
 *
 * The value is held in memory only. On a plain web deployment with no native
 * shell there is no token source, and the server's default-deny policy applies
 * (503 unless AETHER_ALLOW_LOCAL_ANONYMOUS=1 is set for local development).
 */

interface AetherNativeBridge {
  controlToken?(): string | Promise<string>;
}

declare global {
  interface Window {
    AetherNative?: AetherNativeBridge;
  }
}

let cached: string | null = null;
let inflight: Promise<string | null> | null = null;

/** Resolve the control token from the native bridge. Memory-only. */
export async function getControlToken(): Promise<string | null> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const bridge = typeof window === "undefined" ? undefined : window.AetherNative;
    if (!bridge?.controlToken) return null;
    try {
      const value = await bridge.controlToken();
      cached = typeof value === "string" && value.length > 0 ? value : null;
    } catch {
      cached = null;
    }
    return cached;
  })();

  const result = await inflight;
  inflight = null;
  return result;
}

/** Headers carrying the control token, or an empty object when unavailable. */
export async function controlAuthHeaders(): Promise<Record<string, string>> {
  const token = await getControlToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Forget the cached token (sign-out, or after a 401/403 so the shell can reissue). */
export function clearControlToken(): void {
  cached = null;
}
