import { requireControlAuth } from "@/server/auth";
import { engineManager } from "@/server/engine/manager";
import { ENGINE_IDS, MODEL_NAME } from "@/server/engine/contract";
import { discoverAlive } from "@/server/engine/resolve";

export const dynamic = "force-dynamic";

/**
 * Engine lifecycle state for the UI. Polling this does NOT reset the idle timer.
 *
 * FIX (audit C5): `engines` now reports each slot's OWN attributed state, and
 * `live` reports whether ANY engine is actually serving. These are deliberately
 * distinct signals: "Engine B is selected" and "an engine is live" are not the
 * same fact, and the UI must not collapse them.
 *
 * FIX (§6.6): the internal tunnel URL is never returned. Clients get
 * `urlPresent` per slot instead.
 */
export async function GET(request: Request) {
  const denied = requireControlAuth(request);
  if (denied) return denied;

  const snapshot = engineManager.snapshot();
  const live = await discoverAlive();

  /* Strip internal URLs from every per-engine entry. */
  const engines = Object.fromEntries(
    ENGINE_IDS.map((id) => {
      const info = snapshot.engines[id];
      return [
        id,
        {
          id: info.id,
          state: info.state,
          urlPresent: Boolean(info.url),
          lastSeen: info.lastSeen,
          /* lastError can contain Kaggle verdicts; keep it, it carries no secrets,
             but never let a URL through. */
          lastError: info.lastError ? String(info.lastError).replace(/https?:\/\/\S+/g, "[url]") : undefined,
        },
      ];
    }),
  );

  return Response.json({
    ...snapshot,
    engines,
    /* Manager events are free text (wake verdicts, bind notes) and can carry a
       tunnel URL, so they get the same scrub as lastError. */
    events: (snapshot.events ?? []).map((e) => ({
      ...e,
      text: String(e.text ?? "").replace(/https?:\/\/\S+/g, "[url]"),
    })),
    model: MODEL_NAME,
    live: {
      alive: live.alive,
      urlPresent: Boolean(live.url),
      waking: live.waking,
      latencyMs: live.latencyMs,
      checked: live.checked,
    },
  });
}
