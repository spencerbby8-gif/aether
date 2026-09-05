import type { ToolResult, ToolSchema } from "@/lib/types";
import { fsList, fsRead, fsRemove, fsSearch, fsWrite } from "./fs";
import { ToolSecurityError } from "./security";
import { webScreenshot } from "./screenshot";
import { WebProvider } from "./web";

/**
 * Server-side ToolRegistry — LOCAL workspace tools only (file + web).
 *
 * Command execution is NOT here on purpose. Arbitrary command execution
 * belongs on the agent's real execution environment (the engine), exposed as
 * the `run_command` engine tool and executed via `executeEngineTool`. Keeping
 * shell/process/package execution off this host preserves the execution
 * boundary: this server never runs model-directed commands.
 */

const web = new WebProvider();

export const SERVER_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "fs.list",
    description: "List files in the task's workspace directory.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Relative path (default .)" } } },
  },
  {
    name: "fs.read",
    description: "Read a file from the task's workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "fs.write",
    description: "Create or overwrite a file inside the task's workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "fs.remove",
    description: "Delete a single file from the task's workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "fs.search",
    description: "Search file contents in the task's workspace.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "web.fetch",
    description: "Fetch a URL and return its readable content (http/https only, size and time limited).",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "web.crawl",
    description: "Crawl from a seed URL with depth/page/request limits and duplicate detection.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxDepth: { type: "number", description: "1–2" },
        maxPages: { type: "number", description: "1–8" },
        maxRequests: { type: "number", description: "1–16" },
      },
      required: ["url"],
    },
  },
  {
    name: "web.search",
    description: "Search the web and return normalized sources for citations.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "web.screenshot",
    description: "Take a PNG screenshot of a page. Returns an artifact.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
];

type Handler = (args: Record<string, unknown>, taskId: string) => Promise<ToolResult>;

const handlers: Record<string, Handler> = {
  "fs.list": (args, taskId) => fsList(args, taskId),
  "fs.read": (args, taskId) => fsRead(args, taskId),
  "fs.write": (args, taskId) => fsWrite(args, taskId),
  "fs.remove": (args, taskId) => fsRemove(args, taskId),
  "fs.search": (args, taskId) => fsSearch(args, taskId),
  "web.fetch": (args) => web.webFetch(args),
  "web.crawl": (args) => web.webCrawl(args),
  "web.search": (args) => web.webSearch(args),
  "web.screenshot": (args, taskId) => webScreenshot(args, taskId),
};

export async function executeTool(name: string, args: Record<string, unknown>, taskId: string): Promise<ToolResult> {
  const handler = handlers[name];
  if (!handler) {
    return { ok: false, text: `Unknown tool "${name}". Available: ${Object.keys(handlers).join(", ")}` };
  }
  try {
    return await handler(args ?? {}, taskId || "default");
  } catch (error) {
    if (error instanceof ToolSecurityError) {
      return { ok: false, text: error.message };
    }
    const message = (error as NodeJS.ErrnoException)?.message ?? "Tool execution failed.";
    return { ok: false, text: /ENOENT/.test(message) ? "File or path not found in the workspace." : message };
  }
}
