import { describe, expect, it } from "vitest";
import { StreamingProvider } from "@/providers";
import type { AgentEvent } from "@/lib/types";

const EVENTS: AgentEvent[] = [
  { type: "phase", phase: "planning" },
  { type: "plan", taskId: "t1", steps: [{ id: "s1", title: "Search", tool: "workspace.search" }] },
  { type: "step", taskId: "t1", stepId: "s1", state: "running", title: "Search", attempt: 1 },
  { type: "tool_call", callId: "c1", tool: "workspace.search", description: "Searching" },
  { type: "tool", id: "c1", name: "workspace.search", state: "done", detail: "3 hits" },
  { type: "note", text: "Retrying step — attempt 2 of 3." },
  { type: "approval_request", requestId: "a1", taskId: "t1", stepId: "s2", tool: "preference.save", description: "Save preference?" },
  { type: "delta", text: "Final " },
  { type: "delta", text: "answer" },
  { type: "phase", phase: "completed" },
  { type: "task_done", taskId: "t1", status: "completed", output: "Final answer" },
];

async function collect(stream: ReadableStream<Uint8Array>): Promise<AgentEvent[]> {
  const decoded: AgentEvent[] = [];
  for await (const event of StreamingProvider.decode(stream)) decoded.push(event);
  return decoded;
}

describe("StreamingProvider", () => {
  it("round-trips the full Phase 2 event protocol", async () => {
    const encoded = EVENTS.map((event) => StreamingProvider.encode(event)).join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(encoded));
        controller.close();
      },
    });
    expect(await collect(stream)).toEqual(EVENTS);
  });

  it("handles frames split across arbitrary chunk boundaries", async () => {
    const encoded = EVENTS.map((event) => StreamingProvider.encode(event)).join("");
    const bytes = new TextEncoder().encode(encoded);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) {
      chunks.push(bytes.slice(i, i + 7));
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    expect(await collect(stream)).toEqual(EVENTS);
  });

  it("skips malformed frames without crashing", async () => {
    const raw =
      StreamingProvider.encode({ type: "delta", text: "ok" }) +
      "data: {this is not json}\n\n" +
      StreamingProvider.encode({ type: "done" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    });
    const decoded = await collect(stream);
    expect(decoded).toEqual([{ type: "delta", text: "ok" }, { type: "done" }]);
  });
});
