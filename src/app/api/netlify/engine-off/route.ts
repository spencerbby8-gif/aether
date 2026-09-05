import { engineOffHandler } from "@/server/engine/netlify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POWER OFF — GET|POST /api/netlify/engine-off
 * (local/Next equivalent of /.netlify/functions/engine-off).
 * One button kills every alive engine on the beacons.
 * Returns {status:"off", killed:[{url,result}], message}; 403 if the engine
 * rejects ENGINE_OFF_KEY.
 */
export async function GET() {
  const { status, body } = await engineOffHandler();
  return Response.json(body, { status });
}

export async function POST() {
  const { status, body } = await engineOffHandler();
  return Response.json(body, { status });
}
