import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolResult } from "@/lib/types";
import {
  ToolSecurityError,
  ensureInsideWorkspace,
  resolveWorkspacePath,
  truncateText,
} from "./security";

/**
 * FsProvider — filesystem access confined to the per-task run directory.
 * Paths are relative to the run directory; escapes are rejected.
 */

const MAX_READ_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 200;

function runDir(taskId: string): string {
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
  return path.join("runs", safe);
}

async function ensureRunDir(taskId: string): Promise<string> {
  const base = resolveWorkspacePath(runDir(taskId));
  await fs.mkdir(base, { recursive: true });
  return base;
}

export async function fsList(args: Record<string, unknown>, taskId: string): Promise<ToolResult> {
  const base = await ensureRunDir(taskId);
  const target = resolveWorkspacePath(typeof args.path === "string" && args.path ? args.path : ".", base);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
    const kind = entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file";
    let size = "";
    if (!entry.isDirectory()) {
      try {
        size = String((await fs.stat(path.join(target, entry.name))).size);
      } catch {
        size = "?";
      }
    }
    lines.push(`${kind}  ${size.padStart(8)}  ${entry.name}`);
  }
  const note = entries.length > MAX_LIST_ENTRIES ? `\n…${entries.length - MAX_LIST_ENTRIES} more entries` : "";
  return {
    ok: true,
    text: lines.length > 0 ? `${lines.join("\n")}${note}` : "(empty directory)",
  };
}

export async function fsRead(args: Record<string, unknown>, taskId: string): Promise<ToolResult> {
  const base = await ensureRunDir(taskId);
  const target = resolveWorkspacePath(String(args.path ?? ""), base);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) throw new ToolSecurityError("Path is a directory — use fs.list.");
  const buffer = await fs.readFile(target);
  const truncated = buffer.length > MAX_READ_BYTES;
  const slice = truncated ? buffer.subarray(0, MAX_READ_BYTES) : buffer;
  const isBinary = slice.subarray(0, 1024).includes(0);
  const text = isBinary
    ? `(binary file, ${buffer.length} bytes)`
    : truncateText(slice.toString("utf-8"), MAX_READ_BYTES).text;
  return { ok: true, text: `path: ${args.path}\nsize: ${buffer.length} bytes\n---\n${text}` };
}

export async function fsWrite(args: Record<string, unknown>, taskId: string): Promise<ToolResult> {
  const base = await ensureRunDir(taskId);
  const target = resolveWorkspacePath(String(args.path ?? ""), base);
  ensureInsideWorkspace(target);
  const content = typeof args.content === "string" ? args.content : "";
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
    throw new ToolSecurityError("Content exceeds the 256 KB write limit.");
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
  return { ok: true, text: `Wrote ${Buffer.byteLength(content)} bytes to ${args.path}` };
}

export async function fsRemove(args: Record<string, unknown>, taskId: string): Promise<ToolResult> {
  const base = await ensureRunDir(taskId);
  const target = resolveWorkspacePath(String(args.path ?? ""), base);
  if (target === base) throw new ToolSecurityError("Refusing to delete the run directory itself.");
  await fs.rm(target, { recursive: false, force: false });
  return { ok: true, text: `Deleted ${args.path}` };
}

export async function fsSearch(args: Record<string, unknown>, taskId: string): Promise<ToolResult> {
  const base = await ensureRunDir(taskId);
  const needle = String(args.query ?? "").toLowerCase();
  if (!needle) throw new ToolSecurityError("A query is required.");
  const hits: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || hits.length >= 20) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (hits.length >= 20) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") await walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_READ_BYTES) continue;
          const content = await fs.readFile(full, "utf-8");
          const idx = content.toLowerCase().indexOf(needle);
          if (idx >= 0) {
            const line = content.slice(Math.max(0, idx - 60), idx + 120).replace(/\s+/g, " ").trim();
            hits.push(`${path.relative(base, full)}: …${line}…`);
          }
        } catch {
          /* skip unreadable files */
        }
      }
    }
  };
  await walk(base, 0);
  return { ok: true, text: hits.length > 0 ? hits.join("\n") : "No matches in the run workspace." };
}
