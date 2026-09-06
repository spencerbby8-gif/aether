import { requireControlAuth } from "@/server/auth";
import { ensureAliveHandler } from "@/server/engine/netlify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * WAKE / DISCOVERY — GET|POST /api/netlify/ensure-alive
 *
 * FIX (audit C4): authenticated. Waking pushes a Kaggle GPU kernel, so an
 * unauthenticated caller could exhaust the account's weekly GPU quota.
 *
 * Returns the real handoff shapes:
 *   {status:"alive", url, engines, model, ageMinutes}
 *   {status:"waking", etaMinutes, reason}
 *   {status:"error", message}  (502 — e.g. all accounts out of quota)
 * Optional ?engine=a|b|c for strict single-account wake; omitted = AUTO (A→B→C).
 */
/**
 * FIX (audit B3/C5): an absent ?engine means AUTO (A→B→C). A PRESENT but invalid
 * value used to be silently downgraded to AUTO as well, so a caller asking for
 * engine "z" got a fleet-wide wake and a 502 with no indication that its own
 * request was malformed. Invalid slots are now rejected with 400. Slot letters
 * are accepted case-insensitively, matching ENGINE_TAG_RE in resolve.ts.
 */
type Account = "a" | "b" | "c";

function accountFrom(param: string | null): Account | undefined | null {
  if (param === null || param === "") return undefined; // absent -> AUTO
  const lowered = param.trim().toLowerCase();
  return lowered === "a" || lowered === "b" || lowered === "c" ? lowered : null; // null -> invalid
}

function invalidSlotResponse(raw: string): Response {
  return Response.json(
    {
      status: "error",
      slot: null,
      message: `Invalid engine slot "${raw}". Use a, b, c, or omit the parameter for AUTO (A→B→C).`,
    },
    { status: 400 },
  );
}

export async function GET(request: Request) {
  const denied = requireControlAuth(request);
  if (denied) return denied;
  const raw = new URL(request.url).searchParams.get("engine");
  const account = accountFrom(raw);
  if (account === null) return invalidSlotResponse(raw ?? "");
  const { status, body } = await ensureAliveHandler(account);
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  const denied = requireControlAuth(request);
  if (denied) return denied;
  let engine: string | null = new URL(request.url).searchParams.get("engine");
  const body = (await request.json().catch(() => null)) as { engine?: string } | null;
  engine = engine ?? body?.engine ?? null;
  const account = accountFrom(engine);
  if (account === null) return invalidSlotResponse(engine ?? "");
  const { status, body: result } = await ensureAliveHandler(account);
  return Response.json(result, { status });
}
