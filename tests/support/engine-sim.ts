/**
 * Engine simulator — implements the REAL Aether engine HTTP contract exactly as
 * decoded from the SHA-pinned notebook (src/server/engine/aether-engine-source.ts).
 *
 * This is the fixture every integration proof runs against. It is deliberately
 * faithful rather than convenient:
 *
 *   GET  /api/ps   -> 200 {models:[...]} only once warm
 *   POST /api/chat -> requires `X-Engine-Key` === OFF_KEY, then 200 ndjson
 *   POST /off      -> requires header `X-Engine-Key` === OFF_KEY, else 403
 *   (every POST is gated, exactly like the real engine since audit C5)
 *   GET  /files/x  -> generated media
 *   anything else  -> proxied to ollama (i.e. 502 for unknown routes)
 *
 * Crucially: there is NO `/api/off` route. The real engine proxies unknown
 * paths to ollama, which returns 502. Any control plane calling `/api/off`
 * is wrong, and this simulator reproduces that failure honestly.
 */
import http from "node:http";
import crypto from "node:crypto";

export const SIM_OFF_KEY = "sim-off-key-DO-NOT-SHIP";

export interface EngineSimOptions {
  /** Engine slot this instance represents ("a" | "b" | "c"). */
  slot?: "a" | "b" | "c";
  /** Seconds of "thinking" (tool loop) before any content. Default 0. */
  thinkSeconds?: number;
  /** Seconds of content streaming before done:true. Default 2. */
  contentSeconds?: number;
  /** Emit a thinking keep-alive every N ms while thinking. Default 500. */
  keepAliveMs?: number;
  /** Never finish — used to prove idle-timeout and stop/cancel behaviour. */
  hangForever?: boolean;
  /** Fail the first N chat requests with 500 — proves failover. */
  failFirstN?: number;
  /** Port to bind (0 = random). */
  port?: number;
  /** Reject /off unless the key matches. Default true. */
  enforceOffKey?: boolean;
}

export interface EngineSim {
  url: string;
  port: number;
  slot: string;
  close(): Promise<void>;
  /** Every request the engine received, in order: "METHOD path". */
  requests: string[];
  /** Chat requests whose client disconnected before done:true. */
  abortedChats: number;
  /** Successful shutdowns via the real /off contract. */
  offCount: number;
  /** Set to make the engine unhealthy (simulate a dead tunnel). */
  healthy: boolean;
  chatCount: number;
}

export async function startEngineSim(opts: EngineSimOptions = {}): Promise<EngineSim> {
  const slot = opts.slot ?? "a";
  const thinkSeconds = opts.thinkSeconds ?? 0;
  const contentSeconds = opts.contentSeconds ?? 2;
  const keepAliveMs = opts.keepAliveMs ?? 500;
  const enforceOffKey = opts.enforceOffKey ?? true;

  const sim: EngineSim = {
    url: "",
    port: 0,
    slot,
    close: async () => {},
    requests: [],
    abortedChats: 0,
    offCount: 0,
    healthy: true,
    chatCount: 0,
  };

  let failRemaining = opts.failFirstN ?? 0;

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    sim.requests.push(`${req.method} ${path}`);

    /*
     * FIX (audit C5): mirrors the real engine, which now authenticates EVERY
     * POST. Before this, only /off checked the key and /api/chat was wide open
     * to anyone holding the tunnel URL — and /api/chat exposes run_command.
     */
    if (req.method === "POST" && enforceOffKey && req.headers["x-engine-key"] !== SIM_OFF_KEY) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "forbidden" }));
      return;
    }

    /* Unknown routes are proxied to ollama by the real engine -> 502. */
    if (path !== "/api/ps" && path !== "/api/chat" && path !== "/off" && !path.startsWith("/files")) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`proxied to ollama: no such route ${path}`);
      return;
    }

    if (path === "/api/ps") {
      if (!sim.healthy) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: `sim-${slot}`, size: 1, digest: slot }] }));
      return;
    }

    if (path === "/off") {
      const key = String(req.headers["x-engine-key"] ?? "");
      if (enforceOffKey && key !== SIM_OFF_KEY) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "forbidden" }));
        return;
      }
      sim.offCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "shutting down" }));
      /* Real engine exits; simulator just goes unhealthy. */
      setTimeout(() => {
        sim.healthy = false;
      }, 50);
      return;
    }

    if (path.startsWith("/files")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from("89504e470d0a1a0a", "hex"));
      return;
    }

    /* ---- POST /api/chat : NDJSON agent loop ---- */
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      sim.chatCount += 1;
      if (failRemaining > 0) {
        failRemaining -= 1;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "simulated engine failure" }));
        return;
      }

      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "transfer-encoding": "chunked",
        /* No wildcard CORS: the real engine stopped sending it (audit C5), and a
           fixture that keeps it would hide a regression. */
      });

      let closed = false;
      /* True once the engine has finished normally, so a subsequent socket
         close is not miscounted as a client abort. */
      let finished = false;
      const t0 = Date.now();
      const emit = (obj: unknown): boolean => {
        if (closed) return false;
        try {
          res.write(JSON.stringify(obj) + "\n");
          return true;
        } catch {
          closed = true;
          return false;
        }
      };

      /* Tool loop, mirroring the engine: thinking events then content. */
      emit({ message: { thinking: `⚙️ agent step 1 (engine ${slot})...` }, done: false });

      const tick = setInterval(() => {
        const elapsed = (Date.now() - t0) / 1000;
        if (closed) {
          clearInterval(tick);
          return;
        }
        if (opts.hangForever) {
          /* Keep the connection open with keep-alives, never finish. */
          emit({ message: { thinking: "⏳" }, done: false });
          return;
        }
        if (elapsed < thinkSeconds) {
          emit({ message: { thinking: "⏳" }, done: false });
          return;
        }
        if (elapsed < thinkSeconds + contentSeconds) {
          emit({ message: { content: `token${Math.round(elapsed * 10)} ` }, done: false });
          return;
        }
        emit({ message: { content: "" }, done: true, done_reason: "stop", eval_count: 42 });
        clearInterval(tick);
        finished = true;
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }, keepAliveMs);

      /* NOTE: this must be the RESPONSE's close event. `req.on("close")` fires as
         soon as the request body has been consumed, which would mark every
         single chat as a client abort and cancel the tool loop after one event. */
      res.on("close", () => {
        if (!finished) {
          sim.abortedChats += 1;
        }
        closed = true;
        clearInterval(tick);
      });
    });
  });

  const port = opts.port ?? 0;
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  sim.port = typeof addr === "object" && addr ? addr.port : 0;
  sim.url = `http://127.0.0.1:${sim.port}`;
  sim.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return sim;
}

/** Sign a beacon announcement the way an authenticated engine must. */
export function signBeacon(message: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}
