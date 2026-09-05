export const dynamic = "force-dynamic";

/**
 * Aether health check — database-free by design.
 * All workspace data lives client-side in IndexedDB; the server only
 * mediates engine lifecycle, tools and media. This route must never
 * initialize a database or require database environment variables,
 * so it works during build-time page-data collection and on any host.
 */
export async function GET() {
  return Response.json({
    ok: true,
    service: "aether",
    phase: 5,
    workspace: "indexeddb (client-side)",
    agent: process.env.AETHER_AGENT_URL ? "remote-configured" : "mock",
    runtime: "agent-v1",
    realTools: true,
    media: "mock-providers",
    engines: "three-kaggle-lifecycle",
  });
}
