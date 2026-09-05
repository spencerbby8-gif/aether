import { requireControlAuth } from "@/server/auth";
import { engineOffHandler } from "@/server/engine/netlify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POWER OFF — POST /api/netlify/engine-off
 *
 * FIX (audit C4): authenticated, and GET is no longer accepted. A state-changing
 * operation must not be triggerable by a cross-origin <img src> or a stray
 * crawler; only an authenticated POST shuts engines down.
 *
 * Returns {status:"off", killed:[{url,result}], message}. A 403 means the engine
 * rejected ENGINE_OFF_KEY; a 502 means at least one engine did not confirm
 * shutdown, so the caller must not assume the fleet is down.
 */
export async function POST(request: Request) {
  const denied = requireControlAuth(request);
  if (denied) return denied;
  const { status, body } = await engineOffHandler();
  return Response.json(body, { status });
}

export async function GET() {
  return Response.json(
    { ok: false, error: "engine-off is a state-changing operation; use POST with a control token." },
    { status: 405, headers: { allow: "POST" } },
  );
}
