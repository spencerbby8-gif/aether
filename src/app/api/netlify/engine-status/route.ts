import { discoverAlive } from "@/server/engine/resolve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * ENGINE STATE (read-only, never wakes).
 * GET /api/netlify/engine-status →
 *   { state: "live"|"offline"|"waking", alive, url, model, checked, latencyMs }
 * `alive` is only true when /api/ps has CONFIRMED the engine responds with
 * a loaded model — never reported from a stale beacon alone. This is the
 * ACTUALLY-LIVE signal the header power-button shows.
 */
export async function GET() {
  const result = await discoverAlive();
  const state = result.alive ? "live" : result.waking ? "waking" : "offline";
  return Response.json({ state, ...result }, { headers: { "cache-control": "no-store" } });
}
