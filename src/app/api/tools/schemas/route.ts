import { SERVER_TOOL_SCHEMAS } from "@/server/tools";

export const dynamic = "force-dynamic";

/** Publishes the real-tool capability manifest to the client registry. */
export async function GET() {
  return Response.json({ phase: 3, tools: SERVER_TOOL_SCHEMAS });
}
