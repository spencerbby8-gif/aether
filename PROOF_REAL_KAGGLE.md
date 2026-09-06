# Real Kaggle engine — verified end to end

Run against **real Kaggle infrastructure** with real credentials, not a
simulator. This closes the gap the audit said must never be claimed without
proof: *"Do not claim Kaggle integration works unless a real credentialed
wake → RUNNING → live URL → /api/ps → real /api/chat cycle succeeds."*

Engine A, account `fridaymoses`, kernel `qwen-3-8-27b-uncensored-chat`.
Notebook: the patched template pinned at `520eb698…` (39 205 bytes).

## 1. Credentialed wake

```
GET /api/v1/kernels/status  -> {"status":"error"}          (before)
POST /api/netlify/ensure-alive?engine=a
                            -> {"status":"waking","slot":"a",
                                "reason":"wake push sent to [redacted]"}  HTTP 200 in 1.89 s
GET /api/v1/kernels/status  -> {"status":"queued"}         (after)
```

The push used `Authorization: Bearer <key>` with a camelCase body — the
contract the audit said to preserve.

## 2. Boot, observed through the engine's own beacon (ntfy)

```
stage: starting gpus=1
stage: downloading github.com gpus=1
tar --zstd unavailable, using python zstandard
ollama READY: ... client version is 0.33.2
serve UP=True
stage: pulling-model gpus=1
stage: pulling IQ4_XS gpus=1
stage: model-ready: hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS gpus=1
warming up IQ4_XS (loading 15GB into VRAM)...
WARM OK attempt 0
model WARM & pinned - deploying AGENT layer (web_search/fetch_page/crawl/run_command)
AGENT LIVE LINK: https://crystal-courts-landing-athens.trycloudflare.com (tools: ...)
alive: https://crystal-courts-landing-athens.trycloudflare.com (idle 1 min)
```

Kernel reached `{"status":"running"}`. Live URL discovered from the beacon.

## 3. Engine-side hardening (audit C5) — on a REAL engine

| request | result |
|---|---|
| `GET /api/ps` (no key) | **200** — health open by design |
| `POST /api/chat` (no key) | **403** — the audit's RCE path, closed |
| `POST /api/chat` (wrong key, valid model) | **403** |
| `POST /api/tags` (raw ollama proxy, no key) | **403** |
| `Access-Control-Allow-Origin` on any response | **absent** |

## 4. Real streaming (audit §4 item 9) — the headline measurement

`POST /api/chat` with the correct key, prompt asking for ~250 words:

```
first event (any)      :   0.08 s
FIRST CONTENT TOKEN    :   8.65 s
total to done          :  50.79 s   done=True
content chunks         :  395       chars: 2000
```

**Time-to-first-token was 8.65 s out of a 50.79 s generation — 17 % of the
wait.** The answer arrived as 395 separate chunks as the model produced it.

Before the fix this was arithmetically impossible: the engine called ollama
with `stream:False`, so no content could be emitted until `ollama_chat()`
returned — i.e. at ~50 s — and only then replayed at a fixed 6 ms/word. Same
prompt, same engine, so the pre-fix first token would have landed at ≈50 s.
That figure is an inference from the old code path plus this measured total,
not a second measurement.

## 5. Shutdown

```
POST /off (X-Engine-Key) -> 200 {"status":"shutting down"}
GET /api/ps              -> 530 (cloudflare: origin gone)   x3
kernel status            -> {"status":"error"}
ntfy                     -> ENGINE OFF via UI - quota saved
```

Engine process gone, GPU released.

## Honest caveats

- **The engine's control surface was intermittently flaky — NOW ROOT-CAUSED AND
  FIXED.** During one window, `POST /off` and some `POST /api/chat` calls returned
  **501** with Python's default `BaseHTTPRequestHandler` error page, alternating
  with correct 403s from the same URL. Retrying `/off` succeeded on the next
  attempt.

  My original guess here — "more than one handler answering behind the tunnel" —
  was **wrong** and is retracted. The decoded template contains exactly one
  `class H(BaseHTTPRequestHandler)`, one `ThreadingHTTPServer(('0.0.0.0',8080),H)`
  and one cloudflared tunnel.

  Actual cause: the handler declares `protocol_version = 'HTTP/1.1'`, so sockets
  are keep-alive, and the 403 auth gate returned **without consuming the request
  body**. Those bytes stay in the socket and are parsed as the next request line.
  After a desync the handler sets `close_connection`, so the proxy reconnects and
  gets a clean 403 — which is precisely the observed perfect alternation.

  Reproduced locally by exec'ing the *shipped* handler source (sliced out of the
  decoded notebook with `ast`, not re-implemented) and driving it over one reused
  socket — `scripts/proofs/keepalive-501-proof.py`:

  | | pre-fix (`215376a`) | patched |
  |---|---|---|
  | sequential POSTs on one connection | `403,400,403,400,403,400,403,400` | `403 ×8` |
  | pipelined pairs, 5 trials | `[403,400] ×5` | `[403,403] ×5` |
  | desynced responses | **9 of 18** | **0 of 18** |

  The server's own error text is the smoking gun — it shows the unread body
  fused to the next request line:
  `Bad request syntax ('{"model": "m", ...}POST /api/chat HTTP/1.1')`

  **Which status you get, and why — reproduced exactly.** An earlier draft of
  this section blamed the CPython version's `parse_request` strictness. That was
  **wrong and is retracted**. The variable is the *formatting of the JSON body*.

  `BaseHTTPRequestHandler` reads a request line with `readline()`, i.e. up to the
  first `\n`. A JSON body contains no newline, so when the next request's bytes
  arrive the leftover body fuses with it. The unread body has no `Content-Length`
  of its own at that point, so the fused line is tokenised by whitespace and
  `words[-1]` is `HTTP/1.1` — a *valid* version. What happens next depends only on
  how many whitespace tokens there are:

  | body formatting | tokens | result |
  |---|---|---|
  | compact — `{"model":"m","messages":[…]}` | **3** | version validates, then `do_{"model":"m",…}POST` does not exist → **501 Unsupported method** |
  | spaced — `json.dumps(...)` default | 9 | `if not 2 <= len(words) <= 3` → **400 Bad request syntax** |

  Reproduced verbatim, including the message text, by sending two compact-JSON
  POSTs down one socket against the pre-fix shipped handler:

      response 1: HTTP/1.1 403 Forbidden
      response 2: HTTP/1.1 501 Unsupported method
                  ('{"model":"m","messages":[{"role":"user","content":"hi"}]}POST')

  Aether's client bodies come from Node's `JSON.stringify`, which emits compact
  JSON with no spaces — verified:
  `{"model":"m","messages":[{"role":"user","content":"hi"}]}`, byte-identical to
  the body above. That is precisely why the **live** engine returned 501 and not
  400. Both statuses are the same desync, and both are gone after the fix.
- One GPU only (`gpus=1`), so this proves the single-engine path. A/B/C
  failover across three live engines was not exercised.
- Tool calls (`web_search`, `run_command`) were not exercised; the prompt was
  chosen to avoid them. The streaming reader collects `tool_calls` and the
  tests assert that, but a real tool-calling turn was not observed.
