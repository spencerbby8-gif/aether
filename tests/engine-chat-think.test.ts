// @vitest-environment jsdom
/**
 * End-to-end proof that the reasoning-marker fix is WIRED, not just unit
 * correct. Drives the real runEngineChat() against a stream that contains the
 * exact leak measured live on engine C, split across deltas the way the engine
 * actually sends it.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runEngineChat } from "@/providers/engine-chat";

const OPEN = "<th" + "ink>";
const CLOSE = "</th" + "ink>";

let server: Server;
let base = "";
/** Which canned reply the replay server should send next. */
let scenario: "leak" | "reasoning" = "leak";

/** The reply the engine really produced, chopped into small deltas. */
const LEAKED_REPLY = [
  "Paris is the ",
  "capital of France. ",
  CLOSE.slice(0, 4),
  CLOSE.slice(4),
  " Paris is the capital.",
];

const REASONING_REPLY = [
  "The answer is 42. ",
  OPEN.slice(0, 3),
  OPEN.slice(3),
  "let me verify 40 + 2",
  CLOSE,
  " Confirmed.",
];

function start(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks = scenario === "reasoning" ? REASONING_REPLY : LEAKED_REPLY;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      let i = 0;
      const tick = () => {
        if (i >= chunks.length) {
          res.write(JSON.stringify({ done: true }) + "\n");
          res.end();
          return;
        }
        res.write(JSON.stringify({ message: { content: chunks[i++] } }) + "\n");
        setTimeout(tick, 1);
      };
      tick();
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
      resolve();
    });
  });
}

beforeAll(async () => {
  await start();
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("/")) return real(`${base}${url}`, init);
    return real(input as never, init);
  }) as typeof fetch;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function drive(which: "leak" | "reasoning") {
  scenario = which;
  const seen: string[] = [];
  const outcome = await runEngineChat({
    turns: [{ role: "user", content: "go" }],
    signal: new AbortController().signal,
    streaming: true,
    mode: "auto",
    onEvent: (e) => {
      if (e.type === "delta") seen.push(e.text);
    },
  });
  return { outcome, streamed: seen.join("") };
}

describe("runEngineChat reasoning-marker handling", () => {
  it("never lets a stray closing marker reach the answer", async () => {
    const { outcome, streamed } = await drive("leak");
    expect(outcome.status).toBe("complete");
    expect(outcome.text).not.toContain("think>");
    expect(outcome.text).toBe("Paris is the capital of France.  Paris is the capital.");
    // And nothing partial was ever streamed to the UI either.
    expect(streamed).not.toContain("think>");
  });

  it("routes reasoning to the reasoning channel, not the answer", async () => {
    const { outcome, streamed } = await drive("reasoning");
    expect(outcome.status).toBe("complete");
    expect(outcome.text).not.toContain("think>");
    expect(outcome.text).not.toContain("let me verify");
    expect(outcome.text).toBe("The answer is 42.  Confirmed.");
    expect(streamed).not.toContain("think>");
  });
});
