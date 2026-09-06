import { promises as fs } from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT } from "@/server/tools/security";
import { verifyArtifactUrl } from "@/server/auth";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

/**
 * Serves artifacts produced by real tool runs, strictly from the artifacts dir.
 *
 * FIX (audit B7 / §6): this was an unauthenticated read of the run workspace.
 * Media tags cannot send an Authorization header, so access is granted by a
 * signed, expiring URL minted server-side instead — see signArtifactUrl().
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "";
  /* <runId>/<fileName> — both segments tightly constrained. */
  if (!/^[a-zA-Z0-9_-]{1,64}\/[a-zA-Z0-9._-]{1,128}$/.test(id) || id.includes("..")) {
    return Response.json({ error: "Invalid artifact id." }, { status: 400 });
  }
  if (!verifyArtifactUrl(id, params.get("exp"), params.get("sig"))) {
    return Response.json({ error: "Missing or expired artifact signature." }, { status: 403 });
  }
  const target = path.resolve(WORKSPACE_ROOT, "artifacts", id);
  if (!target.startsWith(path.resolve(WORKSPACE_ROOT, "artifacts") + path.sep)) {
    return Response.json({ error: "Invalid artifact id." }, { status: 400 });
  }
  try {
    const buffer = await fs.readFile(target);
    return new Response(buffer, {
      headers: {
        "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "public, max-age=3600",
      },
    });
  } catch {
    return Response.json({ error: "Artifact not found." }, { status: 404 });
  }
}
