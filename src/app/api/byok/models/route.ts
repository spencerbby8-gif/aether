import { NextResponse } from "next/server";
import { requireControlAuth } from "@/server/auth";
import { ByokError, discoverByokModels } from "@/server/byok";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Request-only credential use: no provider key is persisted by this route. */
export async function POST(request: Request) {
  const denied = requireControlAuth(request);
  if (denied) return denied;
  if (Number(request.headers.get("content-length") ?? 0) > 32_000) {
    return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  }
  try {
    const body = (await request.json()) as { connection?: unknown };
    const result = await discoverByokModels(body.connection);
    return NextResponse.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof ByokError ? error.status : 502;
    const message = error instanceof Error ? error.message : "The provider could not be reached.";
    return NextResponse.json({ ok: false, error: message }, { status, headers: { "cache-control": "no-store" } });
  }
}
