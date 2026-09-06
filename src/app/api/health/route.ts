import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

/**
 * Aether liveness probe — database-free by design.
 *
 * All workspace data lives client-side in IndexedDB; the server only mediates
 * engine lifecycle, tools and media. This route must never initialize a database
 * or require database environment variables, so it works during build-time
 * page-data collection and on any host.
 *
 * FIX (audit C2 / B3): deliberately left unauthenticated — deploy platforms poll
 * it — but reduced to a bare liveness signal. It used to publish the internal
 * architecture to any anonymous caller (workspace backend, agent mode, media
 * provider state, engine topology) along with a stale "phase" number. Capability
 * discovery now lives behind the control token.
 */
export async function GET() {
  return Response.json(
    { ok: true, service: "aether", version: APP_VERSION },
    { headers: { "cache-control": "no-store" } },
  );
}
