import { engineManager } from "@/server/engine/manager";
import { MODEL_NAME } from "@/server/engine/contract";
import { discoverAlive } from "@/server/engine/resolve";

export const dynamic = "force-dynamic";

/**
 * Engine lifecycle state for the UI. Polling this does NOT reset the idle timer.
 *
 * Includes `live` — a FRESH /api/ps health check (never a cached/stale read).
 * An engine is only reported live here when /api/ps returns 200 + models[].
 * `engines` carries the manager's per-account tracking (credentials/targeting);
 * treat `live` as the single source of truth for "is an engine actually up".
 */
export async function GET() {
  const snapshot = engineManager.snapshot();
  /* Fresh health check — the truth about whether an engine is actually live. */
  const live = await discoverAlive();
  return Response.json({
    ...snapshot,
    model: MODEL_NAME,
    live: {
      alive: live.alive,
      url: live.url,
      waking: live.waking,
      latencyMs: live.latencyMs,
      checked: live.checked,
    },
  });
}
