# Chat failed on the phone with "Engine error: timeout" / "socket is closed"

Build 1.7.0 (17). Fixed in 1.8.0 (18).

## What the user reported

Every chat turn on a real device (OPPO CPH2349, Android 11) failed with one of:

- `Engine error: timeout`
- `error: socket is closed`

Wake, discovery, health check and the LIVE card all worked. Only chat failed.

## Why every earlier proof missed it

`StreamProof` (32 assertions), `LiveStreamProof` (16) and `ContextProof` all
drove the real `EngineCore.chatStream` and all passed. They ran on the JDK.

`EngineCore.chatStream` set the socket read timeout to `readSliceMs = 1000ms`
and treated a read timeout as a normal event: catch it, re-check the cancel
flag, read again. **On the JDK that is recoverable.** On Android
`HttpURLConnection` is OkHttp (`com.android.okhttp`), where a read timeout is
fatal — it throws `SocketTimeoutException("timeout")` and the socket is closed,
so the next read throws `SocketException("Socket closed")`.

Those are the user's two error strings, verbatim. The retry loop that made the
JVM proofs pass is precisely what turns one timeout into a dead stream on a
phone.

## The measurement that settles it

The silence a streaming turn must survive is not hypothetical. Against a live
engine A, line by line:

```
t+   210ms  {"message": {"thinking": "⚙️ agent step 1..."}}
t+   210ms  {"message": {"thinking": "⏳"}}
t+  2453ms  {"message": {"content": "The"}}     <== 2243 ms of silence
t+  2562ms  {"message": {"content": " ocean"}}
...
lines 110 | longest silent gap 2243 ms | gaps over 1s: 1
```

The kernel emits its heartbeat, then goes quiet while the model produces the
first token. Measured gap: **2243 ms**, against a **1000 ms** read timeout. The
read timeout fires on the first token of every single reply.

Worse cases are structural, not incidental: during a tool call the kernel emits
nothing at all until the tool returns, and its own subprocess timeouts run to
**1200 s**.

Reproduce the measurement with `scripts/proofs/TtfbProbe.java`.

## A second, unrelated thing the same session found

While measuring, the engine returned `(model timeout/error)` with
`eval_count: 0, eval_duration: 0, total_duration: 0` — Ollama inside the kernel
had failed — and `/api/ps` returned **502** seconds after answering 200. The
kernel's Ollama is intermittent. That produces a fast, clean error rather than a
socket timeout, so it is a separate failure mode from the one reported, and it
is not fixed here. It is recorded because it will look like a chat bug.

## The fix

**1. The read slice now outlasts the engine's silence** — `readSliceMs`
`1_000` → `1_260_000`, the same figure as `stallMs` and above the kernel's
1200 s tool ceiling. A read timeout now means a genuine stall instead of normal
operation.

**2. Stop no longer depends on the read slice.** It used to work only because
the read timed out every second and the loop re-checked the cancel flag. Two
candidate replacements were measured and rejected:

| attempt | measured result |
| --- | --- |
| `HttpURLConnection.disconnect()` from another thread | did **not** interrupt the blocked read; the turn ran on for **58 804 ms** and then reported *success* |
| closing the response `InputStream` from another thread | also did **not** interrupt it, and `close()` itself blocked **58.8 s** draining the body |

So the turn no longer blocks on the socket at all. Lines are read on a daemon
thread and handed over through a `LinkedBlockingQueue`; the turn polls the queue
every 250 ms and re-checks the cancel flag, the stall ceiling and the total
deadline. `TurnHandle.cancel()` closes the stream on its own thread, purely to
release the socket behind the abandoned reader.

Measured stop latency after the fix: **55 ms** (was 58 804 ms).

**3. Failures are described, not leaked.** `describeStreamFailure` turns a
socket death into "the connection to the engine dropped after Ns — it will be
retried on another engine" instead of printing `Socket closed`, and a
turn killed by our own cancel is reported as `cancelled`, not as a failure.

**4. Chat outcomes are now reported from the device** over the existing
telemetry topic, on a dedicated executor so a slow publish cannot queue behind
persistence.

## Proof

`scripts/proofs/StreamTimeoutProof.java` — 16 assertions, **16 passed, 0
failed**, running the real `EngineCore.chatStream`:

```
shipped policy: connect=15000ms readSlice=1260000ms stall=1260000ms total=7200000ms
  PASS  read slice is above the measured 2243ms first-token silence   [1260000ms]
  PASS  read slice is above the kernel's 10s heartbeat interval       [1260000ms]
  PASS  read slice covers the kernel's 1200s tool ceiling             [1260000ms]
  PASS  the old 1000ms slice is gone
  PASS  stall ceiling unchanged at 1260s                              [1260000ms]
  PASS  a reply survives the 2243ms silence
  PASS  all of its content arrived                                    ["Hello world"]
  PASS  the heartbeat reached the UI
  PASS  stop lands in about a second, not after the read slice        [55ms]
  PASS  a stopped turn is reported as cancelled, not as a socket error [cancelled]
  PASS  a dropped connection is not reported as a raw Java message
  PASS  partial content that did arrive is kept                       ["partial"]
  PASS  a real stall is still detected and explained
  PASS  a real engine turn completes
  PASS  a real engine reply is not empty
  PASS  no timeout or socket error surfaced
  reply: I'm AETHER, your autonomous AI agent with live tools — ask me anything!
```

The last three ran against the real Kaggle engine, not a local server.

### What this proof cannot do

It runs on the JDK, so it **cannot** replay OkHttp's fatal read timeout. What it
establishes instead: the shipped read slice exceeds every silence the real
engine produces (so no read timeout should occur at all), stop is prompt without
relying on one, stalls and socket deaths are still detected and explained, and a
real engine turn completes end to end. Final confirmation has to come from the
device — which is why chat outcomes are now published from it.

### Existing suite, re-run against the change

| proof | result |
| --- | --- |
| StreamProof | 32 passed, 0 failed |
| StreamTimeoutProof | 16 passed, 0 failed |
| ShutdownProof | 12 passed, 0 failed |
| ExecutorProof | 13 passed, 0 failed |
| ChatCoreCheck | 70 passed, 0 failed |
| RouterCheck | 19 passed, 0 failed |
| LiveStreamProof (real engine) | 16 passed, 0 failed |
| ContextProof (real engine) | 8 passed, 0 failed |

Two assertions in the old suite encoded the *old* mechanism and were rewritten
to state the requirement instead of the implementation:

- `StreamProof`: "a long read slice delays stop by roughly that slice" →
  "stop is prompt even with a long read slice".
- `ShutdownProof`: "stop is still checked about once a second"
  (`readSliceMs <= 1500`) → "the read slice outlasts the kernel's 1200s tool
  silence".

`StatusProof` reports 32 passed, 1 failed. The failing assertion is
"it was observed WAKING before it was LIVE", and it failed because the proof
re-pushed engine A **while A was already live**: Kaggle leaves previous kernel
versions running (kaggle-api issue 388), so the old instance kept answering
`/api/ps` and WAKING was never observable. Not a code regression. The assertion
is now guarded to report a reasoned skip when the engine starts warm. That guard
compiles but was **not re-run** in this pass, because re-running it pushes a new
kernel version and shuts the engine down again.

## Shipped artifact

`apk/aether-release.apk` — 727 352 bytes, `com.aether.app` **1.8.0 (18)**,
v2-signed, 0 plaintext keys, notebook asset untouched
(sha256 `ef0c7fe7c42345b3…`). The new code is confirmed present in the shipped
dex: `aether-stream-reader`, `chat OK on engine`, `chat FAILED on engine`,
`the connection to the engine dropped after` all found.
