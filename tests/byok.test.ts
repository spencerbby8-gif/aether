import { describe, expect, it, vi } from "vitest";
import {
  discoverByokModels,
  nonStreamingToNdjson,
  openAiSseToNdjson,
  requestByokChat,
  sanitizeConnection,
} from "@/server/byok";

const connection = { provider: "openai" as const, baseUrl: "", apiKey: "sk-test-secret" };

async function lines(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const text = await new Response(stream).text();
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("BYOK connection policy", () => {
  it("uses the registry endpoint for built-in providers", () => {
    const safe = sanitizeConnection({ ...connection, baseUrl: "http://127.0.0.1/private" });
    expect(safe.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("requires public HTTPS for custom providers", () => {
    expect(() => sanitizeConnection({ provider: "custom", baseUrl: "http://example.com/v1", apiKey: "key" })).toThrow(/HTTPS/);
    expect(() => sanitizeConnection({ provider: "custom", baseUrl: "https://127.0.0.1/v1", apiKey: "key" })).toThrow(/private|loopback/);
    expect(sanitizeConnection({ provider: "custom", baseUrl: "https://example.com/v1/", apiKey: "key" }).baseUrl).toBe("https://example.com/v1");
  });

  it("requires a key and validates message shape", async () => {
    expect(() => sanitizeConnection({ provider: "openai", apiKey: "" })).toThrow(/API key/);
    await expect(requestByokChat({ connection, model: "gpt-test", messages: [], temperature: 0.7, maxTokens: 100, stream: true, timeoutMs: 60_000 }, new AbortController().signal, vi.fn())).rejects.toThrow(/Between 1 and 60/);
  });
});

describe("BYOK provider HTTP contract", () => {
  it("discovers only provider-reported model IDs", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }, { name: "ignored" }] }));
    const result = await discoverByokModels(connection, fetcher);
    expect(result.models).toEqual(["model-a", "model-b"]);
    expect(fetcher).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer sk-test-secret" }),
    }));
  });

  it("sends the selected model, instructions, limits and streaming flag", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 }));
    const controller = new AbortController();
    await requestByokChat({
      connection,
      model: "gpt-test",
      messages: [{ role: "system", content: "Be precise" }, { role: "user", content: "Hello" }],
      temperature: 0.2,
      maxTokens: 321,
      stream: true,
      timeoutMs: 30_000,
    }, controller.signal, fetcher);
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gpt-test",
      messages: [{ role: "system", content: "Be precise" }, { role: "user", content: "Hello" }],
      temperature: 0.2,
      max_tokens: 321,
      stream: true,
    });
  });

  it("converts chunked OpenAI SSE into Aether NDJSON", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: [DONE]\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    });
    const events = await lines(openAiSseToNdjson(body));
    expect(events).toEqual([{ message: { content: "Hello" } }, { message: { content: "!" } }, { done: true }]);
  });

  it("handles a non-streaming provider response", async () => {
    const response = Response.json({ choices: [{ message: { content: "Complete answer" } }] });
    expect(await lines(await nonStreamingToNdjson(response))).toEqual([{ message: { content: "Complete answer" } }, { done: true }]);
  });

  it("redacts a key if an upstream error reflects it", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { message: "Rejected sk-test-secret" } }, { status: 401 }));
    await expect(discoverByokModels(connection, fetcher)).rejects.toThrow("Rejected [redacted]");
  });
});
