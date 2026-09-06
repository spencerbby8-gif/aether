import { SERVER_TOOL_SCHEMAS } from "@/server/tools";
import { requireControlAuth } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * Publishes the real-tool capability manifest to the client registry.
 *
 * FIX (audit B7): this enumerates what the server is willing to execute
 * (fs.*, web.*, run_command), which is useful reconnaissance for anyone probing
 * the deployment. It now requires the control token. The client registry already
 * degrades gracefully to zero remote tools when this call is refused.
 */
export async function GET(request: Request) {
  const denied = requireControlAuth(request);
  if (denied) return denied;

  return Response.json({ tools: SERVER_TOOL_SCHEMAS }, { headers: { "cache-control": "no-store" } });
}
