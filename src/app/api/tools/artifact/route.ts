import { promises as fs } from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT } from "@/server/tools/security";

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

/** Serves artifacts produced by real tool runs, strictly from the artifacts dir. */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  /* <runId>/<fileName> — both segments tightly constrained. */
  if (!/^[a-zA-Z0-9_-]{1,64}\/[a-zA-Z0-9._-]{1,128}$/.test(id) || id.includes("..")) {
    return Response.json({ error: "Invalid artifact id." }, { status: 400 });
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
