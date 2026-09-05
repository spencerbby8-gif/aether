import type { ArtifactMeta, AttachmentMeta, ToolSchema } from "@/lib/types";
import { formatBytes, scoreRelevance } from "@/lib/utils";
import { ConversationStore, FileStore, MemoryStore } from "@/storage";

/**
 * Tool orchestration foundation.
 * The runtime receives schemas, hands them to the model, validates the
 * model's calls against the schema, executes, and feeds results back.
 * Phase 2 tools run locally against IndexedDB; Phase 3 real tools execute
 * on the server via RemoteToolExecutor and join the same registry.
 */

export interface ToolContext {
  taskId: string;
  conversationId: string;
  projectId: string | null;
  /** The task goal — useful default input for generative tools. */
  goalHint?: string;
  /** Safe progress reporting into the agent timeline (never hidden reasoning). */
  onProgress?: (detail: string) => void;
}

/** Structured tool result — artifacts, media attachments and exit codes. */
export interface ToolOutput {
  text: string;
  artifacts?: ArtifactMeta[];
  attachments?: AttachmentMeta[];
  exitCode?: number;
}

export interface ToolExecutor {
  schema: ToolSchema;
  /** When true, the observation is also captured into the task's output. */
  capturesOutput?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext, signal: AbortSignal): Promise<string | ToolOutput>;
}

export class ToolRegistry {
  private executors = new Map<string, ToolExecutor>();

  register(executor: ToolExecutor): this {
    this.executors.set(executor.schema.name, executor);
    return this;
  }

  schemas(): ToolSchema[] {
    return Array.from(this.executors.values()).map((e) => e.schema);
  }

  get(name: string): ToolExecutor | undefined {
    return this.executors.get(name);
  }

  /** Returns an error description, or null when the arguments satisfy the schema. */
  validateArgs(schema: ToolSchema, args: Record<string, unknown>): string | null {
    const props = schema.parameters.properties ?? {};
    for (const required of schema.parameters.required ?? []) {
      const value = args[required];
      if (value === undefined || value === null || value === "") {
        return `Missing required argument "${required}" for tool "${schema.name}".`;
      }
    }
    for (const [key, value] of Object.entries(args)) {
      const prop = props[key];
      if (!prop) return `Unknown argument "${key}" for tool "${schema.name}".`;
      if (prop.type === "string" && typeof value !== "string") {
        return `Argument "${key}" of tool "${schema.name}" must be a string.`;
      }
      if (prop.type === "number" && typeof value !== "number") {
        return `Argument "${key}" of tool "${schema.name}" must be a number.`;
      }
      if (prop.type === "boolean" && typeof value !== "boolean") {
        return `Argument "${key}" of tool "${schema.name}" must be a boolean.`;
      }
      if (prop.enum && typeof value === "string" && !prop.enum.includes(value)) {
        return `Argument "${key}" of tool "${schema.name}" must be one of: ${prop.enum.join(", ")}.`;
      }
    }
    return null;
  }
}

function asQuery(args: Record<string, unknown>): string {
  return typeof args.query === "string" && args.query.trim() ? args.query.trim() : "";
}

/** Built-in local tools — everything executes on this device against the workspace. */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    schema: {
      name: "workspace.search",
      description: "Search past conversations and messages in the local workspace.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to search for" } },
        required: ["query"],
      },
    },
    async execute(args) {
      const results = await ConversationStore.search(asQuery(args), 5);
      if (results.length === 0) return "No matches in the workspace.";
      return results.map((r) => `• ${r.conversation.title} — ${r.snippet.slice(0, 120)}`).join("\n");
    },
  });

  registry.register({
    schema: {
      name: "workspace.files",
      description: "List files stored in the workspace, optionally filtered by relevance.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Optional relevance filter" } },
      },
    },
    async execute(args) {
      const files = await FileStore.list();
      if (files.length === 0) return "No files are stored in this workspace yet.";
      const query = asQuery(args);
      const relevant = query
        ? files
            .map((f) => ({ f, score: scoreRelevance(query, f.name) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 6)
            .map((x) => x.f)
        : files.slice(0, 6);
      return relevant.map((f) => `• ${f.name} (${f.mimeType}, ${formatBytes(f.size)})`).join("\n");
    },
  });

  registry.register({
    schema: {
      name: "memory.read",
      description: "Recall relevant entries from local agent memory.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to recall" } },
        required: ["query"],
      },
    },
    async execute(args) {
      const entries = await MemoryStore.relevant(asQuery(args), 5);
      if (entries.length === 0) return "Nothing relevant in memory yet.";
      return entries.map((e) => `• [${e.scope}] ${e.content}`).join("\n");
    },
  });

  registry.register({
    schema: {
      name: "memory.save",
      description: "Store an important fact or decision in local memory.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The fact to remember" },
          scope: { type: "string", enum: ["fact", "conversation", "project", "task"] },
        },
        required: ["content"],
      },
    },
    async execute(args, ctx) {
      const scope = typeof args.scope === "string" && ["fact", "conversation", "project", "task"].includes(args.scope)
        ? (args.scope as "fact" | "conversation" | "project" | "task")
        : "fact";
      await MemoryStore.add({ scope, content: String(args.content), refId: ctx.conversationId });
      return `Saved to local memory (${scope}).`;
    },
  });

  registry.register({
    schema: {
      name: "preference.save",
      description: "Store a user preference. Requires explicit user approval.",
      requiresApproval: true,
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "The preference to remember" } },
        required: ["content"],
      },
    },
    async execute(args, ctx) {
      await MemoryStore.add({ scope: "preference", content: String(args.content), refId: ctx.conversationId });
      return "Preference saved with your approval.";
    },
  });

  registry.register({
    schema: {
      name: "task.note",
      description: "Append a working note to the current task's output.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Note content" } },
        required: ["text"],
      },
    },
    capturesOutput: true,
    async execute(args) {
      return String(args.text);
    },
  });

  return registry;
}

/* ------------------------------------------------------------------ */
/* Phase 3 — real tools executed on the server.                        */
/* ------------------------------------------------------------------ */

/**
 * Executes a tool by POSTing to /api/tools/exec. All permission checks,
 * sandboxing and timeouts are enforced server-side; the client merely
 * relays the model's call and surfaces the guarded result.
 */
export function remoteToolExecutor(schema: ToolSchema): ToolExecutor {
  return {
    schema,
    async execute(args, ctx, signal) {
      let response: Response;
      try {
        response = await fetch("/api/tools/exec", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool: schema.name, args, taskId: ctx.taskId }),
          signal,
        });
      } catch (error) {
        if ((error as Error)?.name === "AbortError" || signal.aborted) throw error;
        throw new Error("The tool service could not be reached (offline?).");
      }
      let body: { ok?: boolean; text?: string; artifacts?: ArtifactMeta[]; exitCode?: number };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        throw new Error(`Malformed tool response (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        throw new Error(body.text ?? `Tool endpoint error (HTTP ${response.status}).`);
      }
      if (!body.ok) {
        throw new Error(body.text ?? "Tool execution failed.");
      }
      return { text: body.text ?? "(no output)", artifacts: body.artifacts, exitCode: body.exitCode };
    },
  };
}

/**
 * Build the full registry: local workspace/memory tools, Phase 4 media
 * tools, plus every server-published local tool.
 *
 * Real engine tools (run_command, web_search, etc.) are NOT registered here:
 * the engine executes them internally inside its own `/api/chat` agent loop,
 * so there is no per-tool endpoint to call. Command execution happens on the
 * engine host through the engine's agent loop, relayed by /api/agent/stream.
 */
export async function createFullRegistry(): Promise<{ registry: ToolRegistry; remoteTools: number }> {
  const registry = createDefaultRegistry();
  const { createMediaTools } = await import("./media-tools");
  for (const executor of createMediaTools()) {
    registry.register(executor);
  }
  try {
    const response = await fetch("/api/tools/schemas", { cache: "no-store" });
    if (!response.ok) return { registry, remoteTools: 0 };
    const body = (await response.json()) as { tools?: ToolSchema[] };
    const schemas = Array.isArray(body.tools) ? body.tools : [];
    for (const schema of schemas) {
      if (schema && typeof schema.name === "string" && schema.parameters) {
        registry.register(remoteToolExecutor(schema));
      }
    }
    return { registry, remoteTools: schemas.length };
  } catch {
    return { registry, remoteTools: 0 };
  }
}
