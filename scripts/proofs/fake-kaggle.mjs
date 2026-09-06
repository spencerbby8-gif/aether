/*
 * Recording fake of the Kaggle REST API.
 *
 * Purpose: prove the wake contract at the wire level (audit B4/B5) without
 * spending real GPU quota or requiring real credentials. It records every
 * request it receives — method, path, query, headers and raw body — and exposes
 * them at GET /__requests.
 *
 * Responses mimic the documented shapes:
 *   POST /api/v1/kernels/push   -> {ref, hasError:false}
 *   GET  /api/v1/kernels/status -> {status:"running"}
 */
import http from "node:http";

const PORT = Number(process.env.FAKE_KAGGLE_PORT ?? 3300);
const requests = [];
let kernelStatus = "running"; // settable via /__status?s=...
/* Raw text of the most recent pushed notebook, so a probe can assert what the
   engine would actually boot with (audit C3/C5). */
let lastNotebook = "";

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const record = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization ?? null,
      contentType: req.headers["content-type"] ?? null,
      bodyLength: raw.length,
      /* The full text is a ~36 KB notebook; keep the shape, not the payload. */
      bodyKeys: (() => {
        try {
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" ? Object.keys(parsed) : null;
        } catch {
          return null;
        }
      })(),
      body: (() => {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object") return null;
          const copy = { ...parsed };
          if (typeof copy.text === "string") copy.text = `<${copy.text.length} bytes omitted>`;
          return copy;
        } catch {
          return null;
        }
      })(),
    };
    requests.push(record);

    if (url.pathname === "/__requests") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(requests, null, 2));
      return;
    }
    if (url.pathname === "/__reset") {
      requests.length = 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"reset":true}');
      return;
    }
    if (url.pathname === "/api/v1/kernels/push") {
      try {
        const parsedPush = JSON.parse(raw);
        if (typeof parsedPush.text === "string") lastNotebook = parsedPush.text;
      } catch {
        /* leave lastNotebook as-is */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ref: "fake/ref", hasError: false }));
      return;
    }
    if (url.pathname === "/__contains") {
      /* Does the last pushed notebook contain this substring? Used to prove the
         injected secret is present and the leaked one is absent. */
      const needle = url.searchParams.get("s") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ needle, present: needle !== "" && lastNotebook.includes(needle) }));
      return;
    }
    if (url.pathname === "/__status") {
      /* Force the reported kernel state so the push path can be exercised:
         a kernel already "running" is (correctly) never re-pushed. */
      const next = url.searchParams.get("s");
      if (next) kernelStatus = next;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ kernelStatus }));
      return;
    }
    if (url.pathname === "/api/v1/kernels/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: kernelStatus }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `unhandled ${url.pathname}` }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake kaggle recording on http://127.0.0.1:${PORT} (dump: /__requests)`);
});
