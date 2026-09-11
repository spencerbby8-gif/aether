import { requireControlAuth } from "@/server/auth";
import { getEngineManager } from "@/server/engine/manager";
import { ENGINE_IDS, MODEL_NAME, type EngineId } from "@/server/engine/contract";
import { engineConfigured } from "@/server/engine/kaggle";
import { discoverAlive, probeFleetHealth } from "@/server/engine/resolve";

export const dynamic = "force-dynamic";

/**
 * Engine lifecycle state for the UI. Polling this does NOT reset the idle timer.
 *
 * FIX (audit §4.1 / C5): every per-slot field is now derived from a real
 * `/api/ps` probe of that slot's OWN attributed URL. Credential presence is
 * reported separately as `configured`, because "the env var is set" and "the
 * engine answers" are different facts — the old badge conflated them and showed
 * dead engines as "ready".
 *
 * FIX (audit A5): when a URL the manager had bound fails its health check, it is
 * evicted here rather than left in place to be reused on the next request.
 *
 * FIX (audit §6.6 / A8): no internal tunnel URL is ever returned. Clients get
 * `urlPresent` per slot instead.
 */
export async function GET(request: Request) {
  const denied = requireControlAuth(request);
  if (denied) return denied;

  /* FIX (audit R3): read durable state, not whatever module memory happens to
     hold on this instance. */
  const engineManager = await getEngineManager();

  const bound = engineManager.snapshot().engines;
  /* Derived from ENGINE_IDS rather than listed by hand. Hardcoding {a,b,c}
     here is how a fourth engine ends up present everywhere except the health
     probe, which then reports it as unknown instead of checking it. */
  const boundUrls = Object.fromEntries(
    ENGINE_IDS.map((id) => [id, bound[id].url]),
  ) as Record<EngineId, string | null>;
  const [live, health] = await Promise.all([
    discoverAlive(),
    probeFleetHealth(boundUrls),
  ]);

  /* Evict rotated tunnels the probe just proved unreachable. */
  for (const id of ENGINE_IDS) {
    if (health[id].staleUrl) engineManager.reportFailure(id);
  }
  /* Re-read AFTER evicting: otherwise this response reports the very URL it has
     just discarded, and the UI stays one poll behind reality (audit A5). */
  const snapshot = engineManager.snapshot();

  const engines = Object.fromEntries(
    ENGINE_IDS.map((id) => {
      const info = snapshot.engines[id];
      const h = health[id];
      return [
        id,
        {
          id: info.id,
          /** Real health from this slot's own /api/ps probe. */
          health: h.state,
          latencyMs: h.latencyMs,
          healthChecked: h.checked,
          /** Credential presence — deliberately distinct from health. */
          configured: engineConfigured(id),
          /*
           * Invariant: the stored state must never contradict the probe.
           *
           * `probeFleetHealth` only reports "waking" while the wake window is
           * genuinely still open, so a stored "waking" next to a probe verdict of
           * "offline" means the window expired and nothing announced. Honour the
           * probe rather than showing "Waking…" indefinitely.
           *
           * Scope, stated honestly: as of this commit the only writer of a stored
           * "waking" is EngineManager.wake(), which currently has no external
           * callers — so this branch is defensive and was NOT reproduced at
           * runtime. What WAS measured is the live equivalent: the per-slot
           * `health` field flips waking -> offline exactly when
           * ENGINE_WAKE_TRACK_TTL_MS expires (4 s TTL: waking at t=2..6 s,
           * offline from t=8 s).
           */
          state: info.state === "waking" && h.state === "offline" ? "off" : info.state,
          urlPresent: Boolean(info.url),
          lastSeen: info.lastSeen,
          /* lastError can contain Kaggle verdicts; keep it, it carries no
             secrets, but never let a URL through. */
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
      slot: live.slot ?? null,
    },
  });
}
