import { getEngineManager } from "@/server/engine/manager";
import { fetchCheckpoint, transferWorkspace } from "@/server/engine/workspace-transfer";
import {
  ENGINE_OFF_HEADER,
  MODEL_NAME,
  engineOffKey,
  streamIdleTimeoutMs,
  streamTotalTimeoutMs,
  type EngineId,
} from "@/server/engine/contract";
import { ensureAliveHandler, type PublicResolveBody } from "@/server/engine/netlify";
import type { EngineRouting } from "@/providers/engine-chat";
import { requireControlAuth } from "@/server/auth";
import { ENGINE_IDS } from "@/server/engine/contract";

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

  /* FIX (audit R3): hydrate durable engine state before anything reads it. On a
     serverless host this instance may be brand new and its module memory empty. */
  const engineManager = await getEngineManager();

  let body: { messages?: unknown; engine?: string; session?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const messages = enrichMessages(sanitizeMessages(body.messages));
  if (messages.length === 0) {
    return Response.json({ ok: false, error: "No usable messages (system messages are never sent)." }, { status: 400 });
  }
  /* Routing mode: AUTO may fail over; a named slot is strict and never
     silently switched. Validated against ENGINE_IDS so a new slot is honoured
     instead of being downgraded to auto, which would look like the pin
     working and then quietly route elsewhere. */
  const mode: EngineRouting =
    typeof body.engine === "string" && (ENGINE_IDS as string[]).includes(body.engine)
      ? (body.engine as EngineRouting)
      : "auto";
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
    const wakeBody = wake.body as PublicResolveBody;
    /*
     * The engine URL lives on `internal`, never on the public body (audit C2).
     * This route is the only consumer that genuinely needs to dial the engine.
     */
    const engineUrl = wake.internal?.url;
    if (wakeBody.status !== "alive" || !engineUrl) {
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

    const base = engineUrl;
    const slot: EngineId = mode === "auto" ? engineManager.snapshot().active : mode;

    let base2 = base;
    let slot2 = slot;
    let didFailover = false;
    /* Events raised before the stream exists: a failover happens while the
       first connection attempt is still failing. Drained when it starts. */
    const pendingEvents: unknown[] = [];
    /*
     * The newest checkpoint of this session, pulled off the engine while it is
     * still alive.
     *
     * A checkpoint the engine writes to its own disk is worthless once the
     * kernel dies -- the tunnel goes with it. The only party guaranteed to
     * outlive the engine is whoever is reading the stream, so this route keeps
     * the copy and hands it to the transfer if failover ever needs it. Without
     * this, an engine that dies mid-task takes every file the task produced
     * with it, and "continue from the last verified step" is not possible.
     */
    const sessionId = typeof body.session === "string" && body.session ? body.session : "default";
    let heldCheckpoint: ArrayBuffer | null = null;
    let checkpointInFlight = false;
    const pullCheckpoint = (engineUrl: string) => {
      if (checkpointInFlight || !offKey) return;
      checkpointInFlight = true;
      fetchCheckpoint(engineUrl, sessionId, offKey)
        .then((buf) => {
          if (buf) heldCheckpoint = buf;
        })
        .catch(() => {
          /* Best effort: a failed pull must never disturb the stream. */
        })
        .finally(() => {
          checkpointInFlight = false;
        });
    };

    const idleTimeoutMs = streamIdleTimeoutMs();
    const totalTimeoutMs = streamTotalTimeoutMs();
    /* Server-side only; never sent to the browser. */
    const offKey = engineOffKey();

    const openChat = async (): Promise<Response | null> => {
      for (;;) {
        if (request.signal.aborted) return null;
        /* Fresh idle/total budget per connection attempt. */
        const guard = createIdleTimeoutSignal(request.signal, idleTimeoutMs, totalTimeoutMs);
        try {
          const response = await fetch(`${base2.replace(/\/$/, "")}/api/chat`, {
            method: "POST",
            /*
             * FIX (audit C5): the engine now authenticates every POST. Without
             * this header the engine answers 403 — previously /api/chat was open
             * to anyone who learned the tunnel URL, and it exposes run_command.
             */
            headers: {
              "content-type": "application/json",
              ...(offKey ? { [ENGINE_OFF_HEADER]: offKey } : {}),
            },
            /* The session id binds the engine's workspace for this turn. Without
               it every conversation shares one directory on the engine. */
            body: JSON.stringify({
              model: MODEL_NAME,
              messages,
              stream: true,
              session: typeof body.session === "string" && body.session ? body.session : "default",
            }),
            signal: guard.signal,
          });
          if (!response.ok || !response.body) throw new Error(`Engine chat responded ${response.status}.`);
          return response;
        } catch (error) {
          if (request.signal.aborted) return null;
          /* Fail over only on a connection-level failure, before any content. */
          if (allowFailover && !didFailover) {
            const deadUrl = base2;
            const deadSlot = slot2;
            engineManager.reportFailure(slot2);
            const failover = await engineManager.failover(slot2);
            if (failover.state === "alive" && failover.url) {
              /* Carry the workspace across, or the task resumes on an engine
                 that does not have the files it already made. Best-effort:
                 the old engine is often the thing that broke, and the task
                 still continues on its history and plan without the files. */
              const session = String(body.session ?? "default");
              const moved = await transferWorkspace(
                deadUrl,
                failover.url,
                session,
                offKey ?? "",
                fetch,
                heldCheckpoint,
              ).catch(() => ({ status: "failed" as const, detail: "transfer threw" }));
              /* Queued, not sent directly: `send` belongs to the stream built
                 below this closure, so calling it here would be a
                 use-before-initialisation. The stream drains the queue first. */
              pendingEvents.push({
                failover: {
                  from: deadSlot,
                  to: failover.slot,
                  workspace: moved.status,
                  files: moved.status === "restored" ? moved.files : 0,
                },
              });
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
        for (const event of pendingEvents.splice(0)) send(event);
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

        /* Whether anything at all reached the client this turn. Declared above
           endIncomplete so the closure can read it, and set in the forward loop. */
        let forwardedAny = false;

        /*
         * End a turn that never reached the engine's terminal event.
         *
         * This is the single place that decides what the user is told when an
         * engine disappears mid-turn, and it is reached from BOTH failure
         * shapes: a socket that throws (a killed engine, a dropped tunnel) and a
         * stream that simply ends. They used to be handled separately, and the
         * throwing one discarded everything that had already arrived -- so a
         * 3-minute answer cut off at the end surfaced as "The engine stream
         * broke" with the text gone.
         *
         * Partial output is real work and is always kept. What differs is only
         * whether there was any: with content, the turn is reported as
         * truncated so the user can continue it; without, it is a plain failure.
         */
        const endIncomplete = (why: string) => {
          engineManager.reportFailure(slot2);
          if (!forwardedAny) {
            terminate({
              error: { message: why, retriable: true, engine: slot2 },
            });
            return;
          }
          terminate({
            done: true,
            truncated: true,
            error: {
              message:
                "The engine connection dropped partway through, so this answer is incomplete. " +
                "What arrived has been kept; ask to continue and it will pick up from here.",
              retriable: true,
              engine: slot2,
            },
          });
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

          while (true) {
            let chunk: { done: boolean; value: Uint8Array | undefined };
            try {
              chunk = await reader.read();
            } catch {
              if (request.signal.aborted) break;
              const reason = guard.reason();
              endIncomplete(
                reason === "idle"
                  ? "The engine stopped responding."
                  : reason === "total"
                    ? "The generation exceeded its time limit."
                    : "The engine stream broke.",
              );
              return;
            }
            if (chunk.done) break;

            /* Any engine event proves liveness — reset the idle budget, and
               count it as a success so a recovered engine is reinstated rather
               than staying condemned by earlier failures. */
            guard.kick();
            engineManager.touch();
            engineManager.noteOutcome(slot2, true);

            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              let parsed: {
                message?: { content?: string; thinking?: string };
                done?: boolean;
                error?: string;
                tool_result?: unknown;
              };
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
              /* A tool result marks a completed step, which is exactly when the
                 engine has just written a fresh checkpoint. */
              if (parsed.tool_result) {
                pullCheckpoint(base2);
              }
              if (parsed.done === true) {
                sawDone = true;
                break;
              }
            }
            if (sawDone) break;
          }

          if (!sawDone && !request.signal.aborted) {
            endIncomplete("The engine returned no content.");
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
