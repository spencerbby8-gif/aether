import type { AgentEvent, AttachmentMeta, ChatTurn } from "@/lib/types";
import { uid } from "@/lib/utils";
import { readNdjson } from "@/lib/engine-client";
import { controlAuthHeaders } from "@/lib/control-auth";
import { AssetStore } from "@/storage/AssetStore";

/** How long to wait for response HEADERS. Not a limit on the stream itself. */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Real engine chat — POST /api/agent/stream (our server proxies the Kaggle
 * engine's NDJSON). Appends message.content, surfaces safe thinking
 * activity, renders tool calls/citations/artifacts, finishes on done:true.
 * Partial output is preserved on abort and error.
 */

export type EngineRouting = "auto" | "a" | "b" | "c";

export interface EngineChatOutcome {
  status: "complete" | "stopped" | "error";
  text: string;
  error?: string;
  engineState?: string;
  engine?: string;
  attachments: AttachmentMeta[];
  thinking?: string;
}

/* Bounded wake wait. A real GPU boot takes minutes, but the REQUEST must not
   hold the chat hostage for that long. We wait a bounded window, then report
   honestly so the user can retry; the engine keeps booting regardless. */
const WAKE_WAIT_MS = 60_000;
const WAKE_TICK_MS = 5_000;

/* Last-resort ceiling on a single chat request, so runEngineChat ALWAYS
 * resolves even if every other guard fails — a permanently pending Promise left
 * streamingIdRef set and blocked the session for good (the "stuck on Thinking"
 * bug).
 *
 * This is deliberately NOT the mechanism that detects a hung engine: that is the
 * 60s idle watchdog in the read loop, which fires when the engine stops sending
 * anything. A total cap this low (it was 120s) killed perfectly healthy long
 * generations, because the engine legitimately spends minutes in its tool loop.
 * Aligned with the server's own stream ceiling so the client never gives up on a
 * request the server is still honouring. */
const REQUEST_TIMEOUT_MS = 900_000;

/**
 * If the fleet is mid-boot, wait for it instead of failing. Each tick
 * re-issues a bounded wake (discovery keeps running server-side) and checks
 * state — mode-aware: manual routing waits for THAT engine, AUTO for any.
 */
async function waitWhileWaking(
  signal: AbortSignal,
  mode: EngineRouting,
  onEvent: (event: AgentEvent) => void,
): Promise<"alive" | "gave-up"> {
  const deadline = Date.now() + WAKE_WAIT_MS;
  const started = Date.now();
  const query = mode === "auto" ? "" : `?engine=${mode}`;
  let ticks = 0;
  while (Date.now() < deadline) {
    if (signal.aborted) return "gave-up";
    ticks += 1;

    /* Poll the real ensure-alive contract route; it both discovers an alive
       engine and keeps a wake in flight server-side. */
    let status: string | null = null;
    let reason = "";
    try {
      const response = await fetch(`/api/netlify/ensure-alive${query}`, {
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      });
      const body = (await response.json()) as { status?: string; reason?: string; message?: string };
      status = body.status ?? null;
      reason = body.reason ?? body.message ?? "";
    } catch {
      /* transient — keep polling */
    }

    if (status === "alive") return "alive";
    if (status === "error") return "gave-up"; // quota / misconfigured — fail honestly

    onEvent({
      type: "status",
      text:
        ticks === 1
          ? `Engine waking — ${reason || "booting the GPU kernel (this can take several minutes)"}…`
          : `Still waking the engine… (${Math.round((Date.now() - started) / 1000)}s)`,
    });

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(WAKE_TICK_MS, remaining)));
  }
  return "gave-up";
}

/**
 * Clean the engine's agent-loop thinking output for display.
 * The engine emits status lines with decorative emojis ("⚙️ agent step 1...",
 * "⏳", "🛠️ web_search(...)"). This strips the emojis, drops pure-noise
 * lines (⏳ / spinner), and reformats tool calls into clean text so the
 * reasoning panel reads as a professional execution log.
 */
export function cleanThinkingLine(raw: string): string | null {
  const line = raw.trim();
  if (!line) return null;

  /* Drop pure spinner/waiting indicators — they carry no information. */
  if (/^[\u23f3\u23f8\u23f9]+$/u.test(line)) return null;
  if (line === "\u23f3" || line === "\u231b" || line === "...") return null;

  /* Strip decorative emoji and tidy separators. */
  let cleaned = line
    .replace(/\u2699\ufe0f/g, "")          // ⚙️
    .replace(/\ud83d\udee0\ufe0f/g, "")     // 🛠️
    .replace(/\u23f3/g, "")                 // ⏳
    .replace(/\u21b3/g, "\u2192")           // ↳ → → (result indicator)
    .replace(/[\u200d\ufe0f]/g, "")         // zero-width joiner / variation selector
    .replace(/[^\S\n]+/g, " ")              // collapse whitespace
    .trim();

  if (!cleaned) return null;

  /* Format tool calls cleanly: "web_search({"query":"..."})" */
  cleaned = cleaned.replace(/^(\w+)\((\{.*\})\)$/, (_m, name: string, args: string) => {
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      const brief = Object.entries(parsed)
        .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
        .join(" ");
      return `${name}(${brief})`;
    } catch {
      return `${name}(${args.slice(0, 60)})`;
    }
  });

  return cleaned;
}

function citationsMarkdown(citations: Array<{ title: string; url: string }>): string {
  const unique = Array.from(new Map(citations.map((c) => [c.url, c])).values()).slice(0, 8);
  if (unique.length === 0) return "";
  return `\n\n### Sources\n${unique.map((c) => `- [${c.title || c.url}](${c.url})`).join("\n")}`;
}

export async function saveArtifact(artifact: { name: string; mimeType: string; base64: string }): Promise<AttachmentMeta | null> {
  try {
    const bytes = Uint8Array.from(atob(artifact.base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: artifact.mimeType });
    const kind = artifact.mimeType.startsWith("image/")
      ? ("image" as const)
      : artifact.mimeType.startsWith("video/")
        ? ("video" as const)
        : artifact.mimeType.startsWith("audio/")
          ? ("audio" as const)
          : null;
    if (!kind) return null;
    const stored = await AssetStore.save(
      {
        name: artifact.name,
        kind,
        mimeType: artifact.mimeType,
        size: blob.size,
        source: "generated",
        origin: { tool: "engine" },
        derivedFrom: null,
        note: "Generated by the real engine.",
      },
      blob,
    );
    return {
      id: stored.id,
      kind: kind === "image" ? "image" : "file",
      name: artifact.name,
      mimeType: artifact.mimeType,
      size: blob.size,
      assetId: stored.id,
    };
  } catch {
    return null;
  }
}

export async function runEngineChat(options: {
  turns: ChatTurn[];
  signal: AbortSignal;
  streaming: boolean;
  mode: EngineRouting;
  onEvent: (event: AgentEvent) => void;
}): Promise<EngineChatOutcome> {
  /* HARD TIMEOUT: race the actual work against a timer so a hung engine
   * stream can never block the session permanently. Without this, a stream
   * that produces nothing and never closes leaves the Promise pending
   * forever — streamingIdRef stays set and no new message can start. */
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

  /* Combine the user's abort signal with our timeout. */
  const combinedSignal = AbortSignal.any([options.signal, timeoutController.signal]);

  try {
    return await runEngineChatInner({ ...options, signal: combinedSignal });
  } catch (error) {
    if (timeoutController.signal.aborted && !options.signal.aborted) {
      return {
        status: "error",
        text: "",
        error: `The engine did not respond within ${REQUEST_TIMEOUT_MS / 1000}s. It may still be processing — try again.`,
        attachments: [],
      };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runEngineChatInner(options: {
  turns: ChatTurn[];
  signal: AbortSignal;
  streaming: boolean;
  mode: EngineRouting;
  onEvent: (event: AgentEvent) => void;
}): Promise<EngineChatOutcome> {
  const { turns, signal, streaming, mode, onEvent } = options;
  const attachments: AttachmentMeta[] = [];
  const citations: Array<{ title: string; url: string }> = [];
  let content = "";
  let thinking = "";
  let failed: string | undefined;
  let engineState: string | undefined;
  let engineUsed: string | undefined;

  /* Only user/assistant ever reach the engine — role:"system" is never sent. */
  const messages = turns
    .filter((t) => t.role === "user" || t.role === "assistant")
    .map((t) => ({ role: t.role, content: t.content }));

  /**
   * A CONNECT deadline only. `AbortSignal.timeout()` stays armed for the whole
   * request lifetime, so wiring it straight into the fetch aborted every
   * generation at 30s — the client-side twin of the server's old 45s deadline.
   * Instead: arm a controller, and disarm it the moment response headers
   * arrive. After that the stream is governed solely by the caller's Stop
   * signal and the idle watchdog below.
   */
  const connectTimers: Array<ReturnType<typeof setTimeout>> = [];
  const connectSignal = () => {
    const ac = new AbortController();
    connectTimers.push(setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS));
    const relay = () => ac.abort();
    signal.addEventListener("abort", relay, { once: true });
    return ac.signal;
  };
  const disarmConnectDeadline = () => {
    for (const t of connectTimers) clearTimeout(t);
    connectTimers.length = 0;
  };

  let response: Response;
  const authHeaders = await controlAuthHeaders();
  const postStream = () =>
    fetch("/api/agent/stream", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ messages, tools: true, engine: mode }),
      signal: connectSignal(),
    });

  try {
    response = await postStream();

    /* Engine is booting: wait for it to come up, then retry once.
       A non-waking 503 (quota, misconfigured) falls through to an error. */
    if (response.status === 503) {
      const peek = (await response.clone().json().catch(() => null)) as { state?: string } | null;
      if (peek?.state === "waking") {
        const woke = await waitWhileWaking(signal, mode, onEvent);
        if (woke === "alive" && !signal.aborted) {
          response = await postStream();
        }
      }
    }
  } catch (error) {
    disarmConnectDeadline();
    if (signal.aborted) {
      return { status: "stopped", text: "", attachments };
    }
    /* Only a connect-phase abort is a timeout; anything later is a real error. */
    if ((error as Error)?.name === "AbortError") {
      return {
        status: "error",
        text: "",
        error: `The engine did not respond within ${CONNECT_TIMEOUT_MS / 1000}s.`,
        attachments,
      };
    }
    return { status: "error", text: "", error: "The engine stream could not be reached.", attachments };
  }

  /* Headers are in: the connect deadline has done its job. */
  disarmConnectDeadline();

  if (!response.ok) {
    let detail = `Engine stream error (HTTP ${response.status}).`;
    try {
      const body = (await response.json()) as { error?: string; state?: string; engine?: string };
      if (body?.error) detail = body.error;
      engineState = body?.state;
      engineUsed = body?.engine;
    } catch {
      /* keep status detail */
    }
    return { status: "error", text: "", error: detail, engineState, engine: engineUsed, attachments };
  }

  /* Stream-read watchdog: if no line arrives for 60s, abort the stream.
   * Without this a hung engine (sends nothing, never closes) would block
   * the request forever — the primary cause of "stuck on Thinking". */
  const IDLE_TIMEOUT_MS = 60_000;
  const idleController = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleController.abort(), IDLE_TIMEOUT_MS);
  };
  resetIdle();

  const streamSignal = AbortSignal.any([signal, idleController.signal]);

  try {
    for await (const line of readNdjson(response, streamSignal)) {
      resetIdle(); // data arrived — reset the idle watchdog
      if (signal.aborted) break;
      const message = line.message as { content?: string; thinking?: string } | undefined;
      if (message?.content) {
        content += message.content;
        onEvent({ type: "delta", text: message.content });
      }
      if (message?.thinking) {
        /* Clean the engine's agent-loop status: strip decorative emojis and
         * drop pure-noise lines so the reasoning panel reads professionally. */
        const cleaned = cleanThinkingLine(message.thinking);
        if (cleaned) {
          thinking += (thinking ? "\n" : "") + cleaned;
          onEvent({ type: "thinking", text: thinking });
        }
      }
      const tool = line.tool as { id: string; name: string; state: "running" | "done" | "error"; detail?: string } | undefined;
      if (tool) {
        onEvent({ type: "tool", id: tool.id ?? uid(), name: tool.name, state: tool.state, detail: tool.detail });
      }
      const lineCitations = line.citations as Array<{ title: string; url: string }> | undefined;
      if (Array.isArray(lineCitations)) citations.push(...lineCitations);
      const artifact = line.artifact as { name: string; mimeType: string; base64: string } | undefined;
      if (artifact) {
        onEvent({ type: "status", text: `Generated ${artifact.name} (${artifact.mimeType})` });
        const attachment = await saveArtifact(artifact);
        if (attachment) attachments.push(attachment);
      }
      const error = line.error as { message?: string } | undefined;
      if (error?.message) failed = error.message;
      if (line.done === true) break;
    }
  } catch (error) {
    if (idleController.signal.aborted && !signal.aborted) {
      failed = `The engine stream went idle for ${IDLE_TIMEOUT_MS / 1000}s. Partial output preserved — try again.`;
    } else if (!signal.aborted) {
      failed = failed ?? (error as Error)?.message ?? "The engine stream broke.";
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  if (signal.aborted) {
    return { status: "stopped", text: content, thinking: thinking || undefined, attachments };
  }
  if (failed) {
    /* Partial output is preserved so Stop/retry never loses tokens. */
    return { status: "error", text: content, error: failed, engineState, thinking: thinking || undefined, attachments };
  }
  const cited = citations.length > 0 ? citationsMarkdown(citations) : "";
  if (cited) onEvent({ type: "delta", text: cited });
  return { status: "complete", text: content + cited, thinking: thinking || undefined, attachments };
}
