import { requireControlAuth } from "@/server/auth";
import { discoverAlive } from "@/server/engine/resolve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * ENGINE STATE (read-only, never wakes).
 * GET /api/netlify/engine-status →
 *   { state: "live"|"offline"|"waking", alive, urlPresent, model, checked, latencyMs }
 *
 * FIX (audit C4 / §6.6): authenticated, and the internal tunnel URL is no
 * longer returned. `urlPresent` tells the UI an engine is addressable without
 * disclosing the address, which combined with the public beacons was a direct
 * path to the engine's unauthenticated endpoints.
 */
export async function GET(request: Request) {
  const denied = requireControlAuth(request);
  if (denied) return denied;
  const result = await discoverAlive();
  const state = result.alive ? "live" : result.waking ? "waking" : "offline";
  const { url, ...rest } = result;
  return Response.json(
    { state, ...rest, urlPresent: Boolean(url) },
    { headers: { "cache-control": "no-store" } },
  );
}
