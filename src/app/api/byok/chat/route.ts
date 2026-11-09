import { NextResponse } from "next/server";
import { requireControlAuth } from "@/server/auth";
import {
  ByokError,
  nonStreamingToNdjson,
  openAiSseToNdjson,
  requestByokChat,
  type ByokChatRequest,
} from "@/server/byok";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** Stream a request-only BYOK credential to its provider; never persist it. */
export async function POST(request: Request) {
  const denied = requireControlAuth(request);
  if (denied) return denied;
  if (Number(request.headers.get("content-length") ?? 0) > 1_500_000) {
    return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  }
  try {
    const body = (await request.json()) as ByokChatRequest;
    const upstream = await requestByokChat(body, request.signal);
    const stream = body.stream ? openAiSseToNdjson(upstream.body, body.connection?.apiKey ?? "") : await nonStreamingToNdjson(upstream);
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    const status = error instanceof ByokError ? error.status : 502;
    const message = error instanceof Error ? error.message : "The provider could not be reached.";
    return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
  }
}
