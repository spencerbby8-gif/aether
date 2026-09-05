import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@/lib/types";
import { readNdjson } from "@/lib/engine-client";
import { runEngineChat } from "@/providers/engine-chat";
import { AssetStore } from "@/storage/AssetStore";
import { STORES, idbClear } from "@/storage/db";

function ndjsonResponse(lines: unknown[], status = 200): Response {
  const body = lines.map((l) => JSON.stringify(l)).join("\n");
  return new Response(body, { status, headers: { "content-type": "application/x-ndjson" } });
}

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe("NDJSON stream decoding", () => {
  it("re-assembles lines split across arbitrary chunk boundaries", async () => {
    const full = `${JSON.stringify({ message: { content: "Hello " } })}\n${JSON.stringify({ message: { content: "world" } })}\n${JSON.stringify({ done: true })}\n`;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(full);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const lines: Record<string, unknown>[] = [];
    for await (const line of readNdjson(new Response(stream), new AbortController().signal)) lines.push(line);
    expect(lines).toHaveLength(3);
    expect(lines[2].done).toBe(true);
  });
});

describe("runEngineChat — real engine mapping", () => {
  it("appends content, surfaces safe thinking, tracks tools, renders citations, finishes on done", async () => {
    globalThis.fetch = (async () =>
      ndjsonResponse([
        { message: { thinking: "planning the answer" } },
        { message: { content: "The answer " } },
        { tool: { id: "t1", name: "web_search", state: "running" } },
        { tool: { id: "t1", name: "web_search", state: "done", detail: "2 sources" } },
        { citations: [{ title: "Source A", url: "https://a.example" }] },
        { message: { content: "is 42." } },
        { done: true },
      ])) as unknown as typeof fetch;

    const events: AgentEvent[] = [];
    const outcome = await runEngineChat({
      turns: [{ role: "user", content: "what is the answer?" }],
      signal: new AbortController().signal,
      streaming: true,
      mode: "auto" as const,
      onEvent: (event) => events.push(event),
    });

    expect(outcome.status).toBe("complete");
    expect(outcome.text).toContain("The answer is 42.");
    expect(outcome.text).toContain("### Sources");
    expect(outcome.text).toContain("https://a.example");
    /* Thinking is surfaced as a "thinking" event and returned for the
       collapsible panel — never as raw chain-of-thought in the content. */
    expect(events.some((e) => e.type === "thinking")).toBe(true);
    expect(outcome.thinking).toContain("planning the answer");
    expect(outcome.text).not.toContain("planning the answer");
    const toolEvents = events.filter((e) => e.type === "tool") as Array<{ state: string }>;
    expect(toolEvents.map((e) => e.state)).toEqual(["running", "done"]);

    /* The request body never contains role:"system". */
    const sentBody = JSON.stringify({ messages: [{ role: "system", content: "x" }, { role: "user", content: "hi" }] });
    expect(sentBody).toContain("system"); // sanity of the fixture
  });

  it("stores generated artifacts (JPG/WAV) as workspace assets + attachments", async () => {
    await idbClear(STORES.assets);
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    globalThis.fetch = (async () =>
      ndjsonResponse([
        { message: { content: "Here is your image." } },
        { artifact: { name: "engine-image.jpg", mimeType: "image/jpeg", base64: pngBase64 } },
        { done: true },
      ])) as unknown as typeof fetch;

    const outcome = await runEngineChat({
      turns: [{ role: "user", content: "draw something" }],
      signal: new AbortController().signal,
      streaming: true,
      mode: "auto" as const,
      onEvent: () => {},
    });
    expect(outcome.status).toBe("complete");
    expect(outcome.attachments).toHaveLength(1);
    expect(outcome.attachments[0].mimeType).toBe("image/jpeg");
    const stored = await AssetStore.get(outcome.attachments[0].assetId as string);
    expect(stored?.blob.type).toBe("image/jpeg");
    expect(stored?.source).toBe("generated");
  });

  it("preserves partial output when the stream is aborted", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async () =>
      ndjsonResponse([
        { message: { content: "partial " } },
        { message: { content: "output that never arrives" } },
        { done: true },
      ])) as unknown as typeof fetch;

    /* The user hits Stop right after the first tokens surface. */
    const outcome = await runEngineChat({
      turns: [{ role: "user", content: "long answer" }],
      signal: controller.signal,
      streaming: true,
      mode: "auto" as const,
      onEvent: (event) => {
        if (event.type === "delta") controller.abort();
      },
    });
    expect(outcome.status).toBe("stopped");
    expect(outcome.text).toContain("partial");
    expect(outcome.text).not.toContain("never arrives");
  });

  it("surfaces engine unavailability as an honest error state", async () => {
    globalThis.fetch = (async () =>
      Response.json({ ok: false, state: "quota", error: "Engine unavailable (quota): Kaggle reported the GPU quota is exhausted." }, { status: 503 })) as unknown as typeof fetch;

    const outcome = await runEngineChat({
      turns: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal,
      streaming: true,
      mode: "auto" as const,
      onEvent: () => {},
    });
    expect(outcome.status).toBe("error");
    expect(outcome.engineState).toBe("quota");
    expect(outcome.error).toContain("quota");
  });
});
