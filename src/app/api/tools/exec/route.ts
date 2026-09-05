import { requireControlAuth } from "@/server/auth";
import { executeTool } from "@/server/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/* Real executions (npm install, crawls) may take a while. */
export const maxDuration = 120;

/**
 * Executes one guarded real tool on the server and returns its result.
 *
 * FIX (audit C4): authenticated. This endpoint can read and write files inside
 * the run workspace and make outbound HTTP requests, so it must not be open.
 *
 * FIX (§6.7): failures now return a real HTTP status (400 for a rejected or
 * invalid request, 502 for an upstream fetch failure) instead of 200-with-an-
 * error-body, so clients and monitors can branch correctly.
 */
export async function POST(request: Request) {
  const denied = requireControlAuth(request);
  if (denied) return denied;

  let body: { tool?: string; args?: Record<string, unknown>; taskId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, text: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.tool !== "string" || body.tool.length === 0) {
    return Response.json({ ok: false, text: "A tool name is required." }, { status: 400 });
  }

  const result = await executeTool(body.tool, body.args ?? {}, body.taskId ?? "default");

  /* Map tool outcomes onto honest HTTP statuses using the classification the
     tool layer reports — never by pattern-matching the message text. */
  const status = result.ok ? 200 : result.kind === "policy" || result.kind === "invalid" ? 400 : result.kind === "upstream" ? 502 : 500;
  return Response.json(result, { status });
}
