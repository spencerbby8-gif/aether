import type { ByokProviderId, ByokRequestConnection } from "@/lib/byok";
import { normalizeBaseUrl, providerDefinition } from "@/lib/byok";
import { assertUrlAllowed, guardedFetch } from "@/server/tools/security";

export interface ByokChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ByokChatRequest {
  connection: ByokRequestConnection;
  model: string;
  messages: ByokChatMessage[];
  temperature: number;
  maxTokens: number;
  stream: boolean;
  timeoutMs: number;
}

export class ByokError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ByokError";
    this.status = status;
  }
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

function withoutSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[redacted]").slice(0, 500) : message.slice(0, 500);
}

async function upstreamError(response: Response, secret: string): Promise<never> {
  let detail = `Provider request failed (HTTP ${response.status}).`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string; message?: string };
    const candidate = typeof body.error === "string" ? body.error : body.error?.message ?? body.message;
    if (candidate) detail = withoutSecret(candidate, secret);
  } catch {
    /* Keep the status-only error; never reflect an arbitrary response body. */
  }
  throw new ByokError(detail, response.status);
}

/** Validate and canonicalise the request-only credential envelope. */
export function sanitizeConnection(input: unknown): ByokRequestConnection {
  if (!input || typeof input !== "object") throw new ByokError("A provider connection is required.");
  const value = input as Partial<ByokRequestConnection>;
  if (typeof value.provider !== "string" || typeof value.apiKey !== "string" || !value.apiKey.trim()) {
    throw new ByokError("An API key is required.");
  }
  if (value.apiKey.length > 4096) throw new ByokError("The API key is too long.");
  const provider = value.provider as ByokProviderId;
  const definition = providerDefinition(provider);
  /* Built-in providers always use their registry endpoint. Custom endpoints
     are deliberately explicit and must use public HTTPS. */
  const baseUrl = normalizeBaseUrl(provider === "custom" ? String(value.baseUrl ?? "") : definition.baseUrl, provider);
  let parsed: URL;
  try {
    parsed = new URL(assertUrlAllowed(baseUrl));
  } catch (error) {
    throw new ByokError(error instanceof Error ? error.message : "Invalid provider URL.");
  }
  if (parsed.protocol !== "https:") throw new ByokError("Provider connections require HTTPS.");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ByokError("Provider URLs cannot contain credentials, query strings, or fragments.");
  }
  return { provider, baseUrl: parsed.toString().replace(/\/$/, ""), apiKey: value.apiKey.trim() };
}

export function sanitizeMessages(input: unknown): ByokChatMessage[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 60) {
    throw new ByokError("Between 1 and 60 messages are required.");
  }
  return input.map((item) => {
    const message = item as Partial<ByokChatMessage>;
    if (!message || !["system", "user", "assistant"].includes(String(message.role)) || typeof message.content !== "string") {
      throw new ByokError("Messages contain an invalid role or content.");
    }
    if (message.content.length > 64_000) throw new ByokError("A message exceeds the 64,000 character limit.");
    return { role: message.role as ByokChatMessage["role"], content: message.content };
  });
}

export async function discoverByokModels(
  input: unknown,
  fetcher: Fetcher = guardedFetch,
): Promise<{ models: string[] }> {
  const connection = sanitizeConnection(input);
  const response = await fetcher(`${connection.baseUrl}/models`, {
    headers: { authorization: `Bearer ${connection.apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return upstreamError(response, connection.apiKey);
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(payload.data)) throw new ByokError("The provider returned an invalid model list.", 502);
  const models = Array.from(
    new Set(payload.data.flatMap((model) => (typeof model.id === "string" && model.id ? [model.id] : []))),
  ).sort((a, b) => a.localeCompare(b));
  return { models };
}

export async function requestByokChat(
  request: ByokChatRequest,
  parentSignal: AbortSignal,
  fetcher: Fetcher = guardedFetch,
): Promise<Response> {
  const connection = sanitizeConnection(request.connection);
  const messages = sanitizeMessages(request.messages);
  const model = String(request.model ?? "").trim();
  if (!model || model.length > 300) throw new ByokError("A valid model ID is required.");
  const timeoutMs = Math.min(180_000, Math.max(10_000, Number(request.timeoutMs) || 60_000));
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([parentSignal, timeout]);
  let response: Response;
  try {
    response = await fetcher(`${connection.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.apiKey}`,
        "content-type": "application/json",
        accept: request.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: Math.min(2, Math.max(0, Number(request.temperature) || 0)),
        max_tokens: Math.min(32_768, Math.max(1, Math.round(Number(request.maxTokens) || 2048))),
        stream: Boolean(request.stream),
      }),
      signal,
    });
  } catch (error) {
    if (parentSignal.aborted) throw error;
    if (timeout.aborted) throw new ByokError(`The provider did not respond within ${timeoutMs / 1000} seconds.`, 504);
    throw new ByokError(withoutSecret(error instanceof Error ? error.message : "The provider could not be reached.", connection.apiKey), 502);
  }
  if (!response.ok) return upstreamError(response, connection.apiKey);
  return response;
}

function encodeLine(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

/** Convert OpenAI SSE to Aether's existing NDJSON chat event contract. */
export function openAiSseToNdjson(body: ReadableStream<Uint8Array> | null, secret = ""): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!body) {
        controller.enqueue(encodeLine({ error: { message: "The provider returned an empty stream." } }));
        controller.close();
        return;
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let failed = false;
      const emitPayload = (raw: string) => {
        if (!raw || raw === "[DONE]") return;
        try {
          const event = JSON.parse(raw) as {
            choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
            error?: { message?: string };
          };
          if (event.error?.message) {
            failed = true;
            controller.enqueue(encodeLine({ error: { message: withoutSecret(event.error.message, secret) } }));
            return;
          }
          const content = event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.message?.content;
          if (typeof content === "string" && content) {
            controller.enqueue(encodeLine({ message: { content } }));
          }
        } catch {
          /* Ignore provider keep-alives and malformed individual events. */
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
            emitPayload(data);
            boundary = buffer.indexOf("\n\n");
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          const data = buffer.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          emitPayload(data);
        }
        if (!failed) controller.enqueue(encodeLine({ done: true }));
        controller.close();
      } catch (error) {
        controller.enqueue(encodeLine({ error: { message: withoutSecret(error instanceof Error ? error.message : "Provider stream failed.", secret) } }));
        controller.close();
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export async function nonStreamingToNdjson(response: Response): Promise<ReadableStream<Uint8Array>> {
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = payload.choices?.[0]?.message?.content;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (typeof content === "string" && content) controller.enqueue(encodeLine({ message: { content } }));
      controller.enqueue(encodeLine({ done: true }));
      controller.close();
    },
  });
}
