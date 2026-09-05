import { engineManager } from "@/server/engine/manager";
import { MODEL_NAME, type EngineId } from "@/server/engine/contract";
import { ensureAliveHandler } from "@/server/engine/netlify";
import type { ResolveResult } from "@/server/engine/resolve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 900; // long-running generations

/**
 * Real NDJSON chat against the engine.
 *
 * The engine IS the agent: its `/api/chat` runs the full agent loop — the
 * model decides to call tools (run_command, web_search, fetch_page,
 * crawl_site, generate_image, generate_voice), the engine executes them on
 * the engine host, and it streams the result back as NDJSON. Aether relays
 * that stream; it does NOT re-implement tool execution locally.
 *
 * Contract: POST {engineUrl}/api/chat with {model: MODEL_NAME, messages, stream:true}.
 *  - appends message.content, surfaces safe message.thinking activity
 *  - finishes on done:true
 *  - never sends role:"system"
 *  - AUTO may fail over A→B before any content is forwarded; manual A/B never switch.
 */

interface ChatMessage {
  role: string;
  content: string;
}

const MAX_HISTORY = 24;

/**
 * Reasoning enrichment. The engine disables native chain-of-thought
 * (`think: False`), so we encourage thorough reasoning through the prompt
 * instead. This guidance tells the model to reason through the problem,
 * verify its answer, and correct mistakes before responding.
 */
const REASONING_DIRECTIVE =
  " [Reasoning guidance: think through this carefully before answering. Break the problem into steps, verify each step, and if you find an error go back and correct it. Only give your final answer after you are confident it is correct. If a tool would help you verify, use it.]";

/**
 * Image-quality enrichment. The engine's model writes the prompt that reaches
 * the image generator, so the phrasing of the user's request directly controls
 * output quality. When the user asks for an image we append concise, concrete
 * photographic directives — subject detail, lighting, lens, composition —
 * which the model folds into a far richer generation prompt. This is prompt
 * guidance only: no image is ever faked or substituted.
 */
const IMAGE_INTENT =
  /\b(generate|create|make|draw|paint|render|produce|show)\b[^.!?]{0,40}\b(image|picture|photo|photograph|artwork|art|illustration|render|wallpaper|logo|portrait|scene|painting)\b/i;

const IMAGE_QUALITY_DIRECTIVE =
  " [Image quality guidance: when you call generate_image, write a single richly detailed prompt of 40-70 words describing the subject precisely, plus lighting (e.g. soft golden-hour rim light, or diffused studio softbox), composition/framing (e.g. tight macro shot, low-angle wide), lens and depth of field (e.g. 85mm f/1.4, shallow depth of field, creamy bokeh), texture and material detail, colour grading, and finish with \"photorealistic, ultra-detailed, sharp focus, high dynamic range, 8k\". Never send a short vague prompt.]";

function enrichMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return messages;
  if (last.content.includes("[Reasoning guidance")) return messages;

  let content = last.content;

  /* Add image quality guidance only for image requests. */
  if (IMAGE_INTENT.test(content) && !content.includes("[Image quality guidance")) {
    content += IMAGE_QUALITY_DIRECTIVE;
  }

  /* Add reasoning guidance for all requests. */
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

export async function POST(request: Request) {
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
  /* Routing mode: AUTO may fail over; A/B are strict — never silently switched. */
  const mode: "auto" | "a" | "b" | "c" =
    body.engine === "a" || body.engine === "b" || body.engine === "c" ? body.engine : "auto";
  const allowFailover = mode === "auto";

  engineManager.beginOperation();
  engineManager.touch();
  try {
    /* Wake + discovery through the verified control layer (resolve.ts).
       AUTO → dual-account with A→B quota failover; manual A/B → strict. */
    const account = mode === "auto" ? undefined : mode;
    const wake = await ensureAliveHandler(account);
    const wakeBody = wake.body as ResolveResult;
    if (wakeBody.status !== "alive" || !wakeBody.url) {
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
    const slot = mode === "auto" ? (engineManager.snapshot().active as EngineId) : mode;

    /* Relay the engine's /api/chat agent loop. On a pre-content failure in
       AUTO mode we fail over once; manual A/B never switch silently. */
    let base2 = base;
    let slot2 = slot;
    let didFailover = false;

    const openChat = async (): Promise<Response | null> => {
      for (;;) {
        if (request.signal.aborted) return null;
        try {
          /* Connection timeout so a hung engine can't hold the stream open. */
          const response = await fetch(`${base2.replace(/\/$/, "")}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: MODEL_NAME, messages, stream: true }),
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
          });
          if (!response.ok || !response.body) throw new Error(`Engine chat responded ${response.status}.`);
          return response;
        } catch (error) {
          if (request.signal.aborted) return null;
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
          if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        };
        const safeClose = () => {
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        };

        try {
          const response = await openChat();
          if (!response) {
            safeClose();
            return;
          }
          const reader = response.body!.getReader();
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
              send({ error: { message: "The engine stream broke.", retriable: true } });
              break;
            }
            if (chunk.done) break;
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
                send({ error: { message: parsed.error } });
                continue;
              }
              const message = parsed.message;
              if (message?.thinking) {
                /* Forward the full thinking event so the reasoning panel shows
                 * the complete execution log — no artificial truncation. */
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
            send({ error: { message: "The engine returned no content.", retriable: true } });
          }
          send({ done: true });
        } catch (error) {
          if (!request.signal.aborted) {
            send({
              error: {
                message: allowFailover
                  ? (error as Error)?.message ?? "Stream failed."
                  : `Engine ${slot2.toUpperCase()} failed: ${(error as Error)?.message ?? "stream failed."} (manual routing — no silent switch)`,
                engine: slot2,
                retriable: true,
              },
            });
          }
        } finally {
          safeClose();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-aether-engine": slot2,
      },
    });
  } finally {
    engineManager.endOperation();
  }
}
