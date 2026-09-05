import { engineManager } from "@/server/engine/manager";
import { MODEL_NAME, streamIdleTimeoutMs, streamTotalTimeoutMs, type EngineId } from "@/server/engine/contract";
import { ensureAliveHandler } from "@/server/engine/netlify";
import type { ResolveResult } from "@/server/engine/resolve";
import { requireControlAuth } from "@/server/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 900; // long-running generations

/**
 * Real NDJSON chat against the engine.
 *
 * The engine IS the agent: its `/api/chat` runs the full agent loop — the
 * model decides to call tools (run_command, web_search, fetch_page,
 * crawl_site, generate_image, generate_voice), the engine executes them on the
 * engine host, and it streams the result back as NDJSON. Aether relays that
 * stream; it does NOT re-implement tool execution locally.
 *
 * Contract: POST {engineUrl}/api/chat with {model: MODEL_NAME, messages, stream:true}
 *  - appends message.content, surfaces safe message.thinking activity
 *  - ALWAYS terminates with exactly one of {done:true} or {error}
 *  - never sends role:"system"
 *  - AUTO may fail over A→B→C before any content is forwarded; manual A/B/C never switch
 *
 * FIX (audit R1): the upstream fetch is bounded by an IDLE timeout that resets
 * on every engine event, plus a large total ceiling — not a 45s total deadline.
 * The engine legitimately spends minutes in its tool loop emitting "thinking"
 * keep-alives; a 45s total deadline killed every long generation mid-flight,
 * which is the "stuck on Thinking, then silence" bug.
 *
 * FIX (audit R4): the operation is held for the whole life of the stream and
 * released when the stream actually ends or the client cancels — not when the
 * handler returns the Response object.
 */

interface ChatMessage {
  role: string;
  content: string;
}

const MAX_HISTORY = 24;

/**
 * Reasoning enrichment. The engine disables native chain-of-thought
 * (`think: False`), so we encourage thorough reasoning through the prompt.
 */
const REASONING_DIRECTIVE =
  " [Reasoning guidance: think through this carefully before answering. Break the problem into steps, verify each step, and if you find an error go back and correct it. Only give your final answer after you are confident it is correct. If a tool would help you verify, use it.]";

/**
 * Image-quality enrichment. The engine's model writes the prompt that reaches
 * the image generator, so phrasing directly controls output quality.
 */
const IMAGE_INTENT =
  /\b(generate|create|make|draw|paint|render|produce|show)\b[^.!?]{0,40}\b(image|picture|photo|photograph|artwork|art|illustration|render|wallpaper|logo|portrait|scene|painting)\b/i;

const IMAGE_QUALITY_DIRECTIVE =
  ' [Image quality guidance: when you call generate_image, write a single richly detailed prompt of 40-70 words describing the subject precisely, plus lighting (e.g. soft golden-hour rim light, or diffused studio softbox), composition/framing (e.g. tight macro shot, low-angle wide), lens and depth of field (e.g. 85mm f/1.4, shallow depth of field, creamy bokeh), texture and material detail, colour grading, and finish with "photorealistic, ultra-detailed, sharp focus, high dynamic range, 8k". Never send a short vague prompt.]';

function enrichMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return messages;
  if (last.content.includes("[Reasoning guidance")) return messages;

  let content = last.content;
  if (IMAGE_INTENT.test(content) && !content.includes("[Image quality guidance")) {
    content += IMAGE_QUALITY_DIRECTIVE;
  }
  content += REASONING_DIRECTIVE;

  const enriched = [...messages];
  enriched[enriched.length - 1] = { role: last.role, content };
  return enriched;
}

function sanitizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((m): m is ChatMessage => Boolean(m) && typeof m === "object")
    .filter((m) => m.role !== "system" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * An AbortSignal that aborts after `idleMs` of INACTIVITY, reset by kick(),
 * plus a hard `totalMs` ceiling. This is what lets a long agent loop run while
 * still guaranteeing we never hang forever.
 */
function createIdleTimeoutSignal(
  parent: AbortSignal,
  idleMs: number,
  totalMs: number,
): { signal: AbortSignal; kick: () => void; reason: () => "idle" | "total" | "client" | null } {
  const controller = new AbortController();
  let reason: "idle" | "total" | "client" | null = null;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (reason) return;
      reason = "idle";
      controller.abort(new Error(`Engine silent for ${Math.round(idleMs / 1000)}s.`));
    }, idleMs);
    idleTimer.unref?.();
  };
  armIdle();

  const totalTimer = setTimeout(() => {
    if (reason) return;
    reason = "total";
    controller.abort(new Error(`Generation exceeded the ${Math.round(totalMs / 1000)}s ceiling.`));
  }, totalMs);
  totalTimer.unref?.();

  const onParentAbort = () => {
    if (reason) return;
    reason = "client";
    controller.abort(parent.reason ?? new Error("Client cancelled."));
  };
  if (parent.aborted) onParentAbort();
  else parent.addEventListener("abort", onParentAbort, { once: true });

  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    parent.removeEventListener("abort", onParentAbort);
  };
  controller.signal.addEventListener("abort", cleanup, { once: true });

  return {
    signal: controller.signal,
    kick: () => {
      if (!reason) armIdle();
    },
    reason: () => reason,
  };
}

export async function POST(request: Request) {
  /* FIX (audit C4): chat drives the engine fleet and consumes GPU quota, so it
     is an authenticated control surface. */
  const authError = requireControlAuth(request);
  if (authError) return authError;

  let body: { messages?: unknown; engine?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const messages = enrichMessages(sanitizeMessages(body.messages));
  if (messages.length === 0) {
    return Response.json({ ok: false, error: "No usable messages (system messages are never sent)." }, { status: 400 });
  }
  /* Routing mode: AUTO may fail over; A/B/C are strict — never silently switched. */
  const mode: "auto" | "a" | "b" | "c" =
    body.engine === "a" || body.engine === "b" || body.engine === "c" ? body.engine : "auto";
  const allowFailover = mode === "auto";

  /* Hold the operation across the ENTIRE stream, released exactly once. */
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    engineManager.endOperation();
  };
  engineManager.beginOperation();
  engineManager.touch();

  try {
    const account = mode === "auto" ? undefined : mode;
    const wake = await ensureAliveHandler(account);
    const wakeBody = wake.body as ResolveResult;
    if (wakeBody.status !== "alive" || !wakeBody.url) {
      release();
      const errorMessage =
        wakeBody.status === "waking"
          ? `Engine is still waking (${wakeBody.reason ?? "boot in progress"}) — it will be ready shortly.`
          : wakeBody.message ?? "No engine available.";
      return Response.json(
        { ok: false, state: wakeBody.status, engine: mode === "auto" ? null : mode, error: errorMessage.slice(0, 400) },
        { status: 503 },
      );
    }

    const base = wakeBody.url;
    const slot: EngineId = mode === "auto" ? engineManager.snapshot().active : mode;

    let base2 = base;
    let slot2 = slot;
    let didFailover = false;

    const idleTimeoutMs = streamIdleTimeoutMs();
    const totalTimeoutMs = streamTotalTimeoutMs();

    const openChat = async (): Promise<Response | null> => {
      for (;;) {
        if (request.signal.aborted) return null;
        /* Fresh idle/total budget per connection attempt. */
        const guard = createIdleTimeoutSignal(request.signal, idleTimeoutMs, totalTimeoutMs);
        try {
          const response = await fetch(`${base2.replace(/\/$/, "")}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: MODEL_NAME, messages, stream: true }),
            signal: guard.signal,
          });
          if (!response.ok || !response.body) throw new Error(`Engine chat responded ${response.status}.`);
          return response;
        } catch (error) {
          if (request.signal.aborted) return null;
          /* Fail over only on a connection-level failure, before any content. */
          if (allowFailover && !didFailover) {
            engineManager.reportFailure(slot2);
            const failover = await engineManager.failover(slot2);
            if (failover.state === "alive" && failover.url) {
              base2 = failover.url;
              slot2 = failover.slot;
              didFailover = true;
              continue;
            }
          }
          throw error;
        }
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const send = (line: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          } catch {
            closed = true;
          }
        };
        /* Guarantee exactly one terminal event, then close. */
        let terminated = false;
        const terminate = (line: unknown) => {
          if (terminated) return;
          terminated = true;
          send(line);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
          release();
        };

        /* Idle guard covering the streaming phase (connection guard above
           covers only the connect). */
        const guard = createIdleTimeoutSignal(request.signal, idleTimeoutMs, totalTimeoutMs);
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

        /* Client cancelled (stop button / navigated away): tear down upstream
           so the engine sees the disconnect instead of generating into void. */
        const onClientAbort = () => {
          reader?.cancel(new Error("client cancelled")).catch(() => {});
        };
        request.signal.addEventListener("abort", onClientAbort, { once: true });

        try {
          const response = await openChat();
          if (!response) {
            terminate({ done: true, cancelled: true });
            return;
          }
          reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let sawDone = false;
          let forwardedAny = false;

          while (true) {
            let chunk: { done: boolean; value: Uint8Array | undefined };
            try {
              chunk = await reader.read();
            } catch {
              if (request.signal.aborted) break;
              const reason = guard.reason();
              terminate({
                error: {
                  message:
                    reason === "idle"
                      ? "The engine stopped responding."
                      : reason === "total"
                        ? "The generation exceeded its time limit."
                        : "The engine stream broke.",
                  retriable: true,
                  engine: slot2,
                },
              });
              return;
            }
            if (chunk.done) break;

            /* Any engine event proves liveness — reset the idle budget. */
            guard.kick();
            engineManager.touch();

            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              let parsed: { message?: { content?: string; thinking?: string }; done?: boolean; error?: string };
              try {
                parsed = JSON.parse(trimmed);
              } catch {
                continue; // tolerate keep-alive/partial lines
              }
              if (parsed.error) {
                send({ error: { message: parsed.error, engine: slot2 } });
                continue;
              }
              const message = parsed.message;
              if (message?.thinking) {
                send({ message: { role: "assistant", thinking: String(message.thinking) } });
                forwardedAny = true;
              }
              if (message?.content) {
                send({ message: { role: "assistant", content: message.content } });
                forwardedAny = true;
              }
              if (parsed.done === true) {
                sawDone = true;
                break;
              }
            }
            if (sawDone) break;
          }

          if (!sawDone && !forwardedAny && !request.signal.aborted) {
            terminate({ error: { message: "The engine returned no content.", retriable: true, engine: slot2 } });
            return;
          }
          terminate({ done: true });
        } catch (error) {
          if (request.signal.aborted) {
            terminate({ done: true, cancelled: true });
            return;
          }
          terminate({
            error: {
              message: allowFailover
                ? ((error as Error)?.message ?? "Stream failed.")
                : `Engine ${slot2.toUpperCase()} failed: ${(error as Error)?.message ?? "stream failed."} (manual routing — no silent switch)`,
              engine: slot2,
              retriable: true,
            },
          });
        } finally {
          request.signal.removeEventListener("abort", onClientAbort);
          reader?.cancel().catch(() => {});
          release();
        }
      },
      cancel() {
        release();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-aether-engine": slot2,
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    release();
    return Response.json(
      { ok: false, error: (error as Error)?.message ?? "Internal error while starting the stream." },
      { status: 500 },
    );
  }
}
