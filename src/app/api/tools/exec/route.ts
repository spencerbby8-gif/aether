import { executeTool } from "@/server/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/* Real executions (npm install, crawls) may take a while. */
export const maxDuration = 120;

/** Executes one guarded real tool on the server and returns its result. */
export async function POST(request: Request) {
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
  return Response.json(result);
}
