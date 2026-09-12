import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as streamPost } from "@/app/api/agent/stream/route";

/* Stub the control layer so the stream route targets the local fixture engine. */
vi.mock("@/server/engine/netlify", () => ({
  ensureAliveHandler: vi.fn(),
  engineOffHandler: vi.fn(),
}));

/**
 * End-to-end NDJSON streaming through the REAL /api/agent/stream route.
 * ensureAliveHandler is stubbed to report an alive engine whose URL is a real
 * local HTTP server that speaks the engine's NDJSON /api/chat protocol. This
 * proves the route forwards real streamed content, tool calls, and done:true —
 * no fake/demo response path.
 */

let server: Server | null = null;
let baseUrl = "";

/* The stream route is now behind requireControlAuth (audit C1/C4). */
const CONTROL_TOKEN = "test-control-token-0123456789abcdef";
beforeEach(() => {
  process.env.AETHER_CONTROL_TOKEN = CONTROL_TOKEN;
});

function startEngine(behavior: "answer" | "tool" | "thinking" | "drop-mid-content" | "drop-silent") {
  return new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/ps") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "fixture-model" }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/chat") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        if (behavior === "tool") {
          /* The engine executes tools internally; tool activity surfaces as
             thinking lines, then the final answer streams. */
          res.write(JSON.stringify({ message: { role: "assistant", thinking: "🛠️ web_search({\"query\": \"x\"})" }, done: false }) + "\n");
          res.write(JSON.stringify({ message: { role: "assistant", thinking: "↳ web_search returned 2 sources" }, done: false }) + "\n");
          res.write(JSON.stringify({ message: { role: "assistant", content: "Here are the results." }, done: false }) + "\n");
          res.end(JSON.stringify({ done: true }) + "\n");
        } else if (behavior === "drop-mid-content") {
          /* The engine dies partway through an answer: real content arrives and
             then the socket is destroyed with no terminal event. This is the
             case that used to be reported as a completed turn. */
          /* Flush the partial answer before tearing the socket down, otherwise
             nothing reaches the client and the test proves the wrong path. */
          res.write(JSON.stringify({ message: { role: "assistant", content: "The answer beg" }, done: false }) + "\n");
          res.write(JSON.stringify({ message: { role: "assistant", content: "ins here and then" }, done: false }) + "\n", () => {
            res.destroy();
          });
          return;
        } else if (behavior === "drop-silent") {
          /* The engine dies before saying anything at all. */
          res.write("", () => {
            res.destroy();
          });
          return;
        } else if (behavior === "thinking") {
          res.write(JSON.stringify({ message: { role: "assistant", thinking: "considering the request" }, done: false }) + "\n");
          res.write(JSON.stringify({ message: { role: "assistant", content: "Hello! " }, done: false }) + "\n");
          res.write(JSON.stringify({ message: { role: "assistant", content: "How can I help?" }, done: false }) + "\n");
          res.end(JSON.stringify({ done: true }) + "\n");
        } else {
          res.write(JSON.stringify({ message: { role: "assistant", content: "Hello! " }, done: false }) + "\n");
          res.write(JSON.stringify({ message: { role: "assistant", content: "How can I help?" }, done: false }) + "\n");
          res.end(JSON.stringify({ done: true }) + "\n");
        }
        return;
      }
      if (req.method === "POST" && req.url === "/api/tools/web_search") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, text: "search results", results: [{ title: "S", url: "https://s.example" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server!.address() as AddressInfo).port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterAll(() => {
  server?.close();
});

async function stubAlive(url: string) {
  const netlify = await import("@/server/engine/netlify");
  vi.mocked(netlify.ensureAliveHandler).mockResolvedValue({
    status: 200,
    /* The public body carries no URL (audit C2); the stream route dials via
       `internal`, which is the only place a tunnel URL may live. */
    body: { status: "alive", urlPresent: true, model: "fixture-model" },
    internal: { url, slot: "a" },
  });
}

describe("real NDJSON streaming through /api/agent/stream", () => {
  it("streams a real answer (content chunks + done:true, no system role)", async () => {
    baseUrl = await startEngine("answer");
    await stubAlive(baseUrl);

    const response = await streamPost(
      new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${CONTROL_TOKEN}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: false }),
      }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const content = lines.map((l) => l.message?.content ?? "").join("");
    expect(content).toBe("Hello! How can I help?");
    expect(lines.some((l) => l.done === true)).toBe(true);
    expect(lines.some((l) => l.message?.role === "system")).toBe(false);
  });

  it("surfaces safe thinking activity and forwards content", async () => {
    baseUrl = await startEngine("thinking");
    await stubAlive(baseUrl);
    const response = await streamPost(
      new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${CONTROL_TOKEN}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "think" }], tools: false }),
      }),
    );
    const text = await response.text();
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((l) => l.message?.thinking)).toBe(true);
    expect(lines.map((l) => l.message?.content ?? "").join("")).toBe("Hello! How can I help?");
  });

  it("relays the engine's internal tool activity (surfaced as thinking) and final answer", async () => {
    baseUrl = await startEngine("tool");
    await stubAlive(baseUrl);
    const response = await streamPost(
      new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${CONTROL_TOKEN}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "search" }] }),
      }),
    );
    const text = await response.text();
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    /* Tool activity is surfaced as safe thinking lines. */
    const thinking = lines.filter((l) => l.message?.thinking);
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking.some((l) => String(l.message.thinking).includes("web_search"))).toBe(true);
    /* The final answer is relayed. */
    expect(lines.map((l) => l.message?.content ?? "").join("")).toBe("Here are the results.");
  });
});

describe("a dropped engine connection is never reported as a completed turn", () => {
  /* Reproduced against a fixture engine that destroys its socket. Before the
     fix, a stream that carried content and then died emitted `done: true` with
     no error, so the UI showed a finished answer that was actually cut off
     mid-sentence -- the silent failure this route exists to prevent. */

  it("keeps the partial answer AND says it was truncated", async () => {
    const url = await startEngine("drop-mid-content");
    await stubAlive(url);
    const response = await streamPost(
      new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${CONTROL_TOKEN}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: false }),
      }),
    );
    const lines = (await response.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const content = lines.map((l) => l.message?.content ?? "").join("");
    /* The real work is preserved... */
    expect(content).toBe("The answer begins here and then");
    /* ...and the truncation is stated rather than hidden behind done:true. */
    const terminal = lines[lines.length - 1];
    expect(terminal.done).toBe(true);
    expect(terminal.truncated).toBe(true);
    expect(terminal.error?.message).toMatch(/incomplete/i);
    expect(terminal.error?.retriable).toBe(true);
  });

  it("reports a plain failure when nothing arrived at all", async () => {
    const url = await startEngine("drop-silent");
    await stubAlive(url);
    const response = await streamPost(
      new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${CONTROL_TOKEN}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: false }),
      }),
    );
    const lines = (await response.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const terminal = lines[lines.length - 1];
    /* No partial text to keep, and NOT marked truncated: this is a plain
       failure, not a truncation. The wording differs by failure shape -- a
       socket destroyed before any byte says the stream broke, a stream that
       ends cleanly with nothing says there was no content -- but both must be
       an error and neither may claim the turn completed. */
    expect(terminal.truncated).toBeUndefined();
    expect(terminal.done).toBeUndefined();
    expect(terminal.error?.retriable).toBe(true);
    expect(terminal.error?.message).toMatch(/broke|no content/i);
    expect(lines.map((l) => l.message?.content ?? "").join("")).toBe("");
  });
});
