import { ensureAliveHandler } from "@/server/engine/netlify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * WAKE / DISCOVERY — GET|POST /api/netlify/ensure-alive
 * (local/Next equivalent of /.netlify/functions/ensure-alive).
 * Returns the real handoff shapes:
 *   {status:"alive", url, engines, model, ageMinutes}
 *   {status:"waking", etaMinutes, reason}
 *   {status:"error", message}  (502 — e.g. all accounts out of quota)
 * Optional ?engine=a|b for strict single-account wake; omitted = AUTO (A→B).
 */
function accountFrom(param: string | null): "a" | "b" | "c" | undefined {
  return param === "a" || param === "b" || param === "c" ? param : undefined;
}

export async function GET(request: Request) {
  const account = accountFrom(new URL(request.url).searchParams.get("engine"));
  const { status, body } = await ensureAliveHandler(account);
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  let engine: string | null = new URL(request.url).searchParams.get("engine");
  const body = (await request.json().catch(() => null)) as { engine?: string } | null;
  engine = engine ?? body?.engine ?? null;
  const { status, body: result } = await ensureAliveHandler(accountFrom(engine));
  return Response.json(result, { status });
}
