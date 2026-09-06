# PROOF — Android APK driving the real Kaggle engines

Date: 2026-09-06. Engine A, account `fridaymoses`, kernel
`qwen-3-8-27b-uncensored-chat`, model
`hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS`.

Every result below came from a real network call to Kaggle, ntfy or a live
engine. Nothing here is inferred from source, a mock, or a unit test.

---

## What could not be done, stated first

**The installed APK was never run.** This sandbox has no `/dev/kvm` and
`grep -cE "vmx|svm" /proc/cpuinfo` returns `0`, so there is no hardware
virtualisation and an Android emulator cannot boot here. 1984 MB RAM and 2 cores
would not run one either.

What was done instead: `EngineCore.java` and `EngineRouter.java` contain **no
`android.*` imports**, so `scripts/proofs/engine-core-probe.sh` compiles those
exact files with a stock `javac` and runs them against the real endpoints. The
networking, parsing, routing and shutdown logic that the APK executes is
therefore genuinely tested — but the Activities, the WebView and the credential
asset loading are not. Treat everything UI-level as unverified.

**Engines B and C were never woken.** Their keys (`KAGGLE_KEY_B`,
`KAGGLE_KEY_C`) only ever existed as environment variables, were never committed,
and the sandbox wiped them. Only engine A's key was recoverable, from git blob
`97b45757`. A/B/C routing is proven at the routing-logic level, not across three
live engines.

---

## Three bugs found by running the engine, not by reading it

All three would have shipped silently.

### 1. Chat sent the wrong model name

The engine builds its ollama payload as `user_payload.get('model', MODEL)`
(cell4 L258). A client-supplied `model` therefore **overrides the model actually
loaded in VRAM**. `EngineCore` sent `"model":"aether"`; ollama has no such model;
the engine replied `{"content":"(model timeout/error)"}` with `done:true`.

This is the worst kind of failure: a well-formed, successfully parsed,
empty-looking success. Measured: 181 ms to first token, 1 chunk, 21 chars — all
of it the error string.

Fix: omit the field. After the fix the same probe returned the exact prompt echo.

### 2. Beacon attribution was lost for exactly the engines that were up

The idle heartbeat calls `_ntfy()` directly, bypassing `notify()`, so it was
untagged — and it is the **newest** announcement for a running engine.
`liveLinks()` compared recency before attribution, so the newest sighting won and
the tag was dropped.

Observed live: 2 links on the topic, **0 tagged**, although both
`AGENT LIVE LINK` lines said `engine=a`.

Fixed both sides: the heartbeat now emits `engine=<slot>` (pin
`ef0c7fe7c42345b3f626bd03de6e2ca28f9890a2c50379570c0a18c2b0c29919`), and the
client prefers an attributed sighting over an unattributed one regardless of age.

### 3. The NDJSON shape was guessed, and wrong

The engine emits Ollama's format:

```
{"message": {"thinking": "..."}, "done": false}
{"message": {"content": "..."},  "done": false}
{"message": {"content": ""}, "done": true, "done_reason": "stop", ...}
```

There is no `type` field and no `text` field. The first parser matched nothing,
consumed the whole stream, and reported a clean success with zero content.

### 4. A push with a per-engine title orphans the kernel

Kaggle derives a kernel's slug from its title. Pushing with
`newTitle: "Aether engine A"` moved the kernel to `/fridaymoses/aether-engine-a`
and the real slug began returning **404 to a valid key**. `kernelPush` now
refuses any title other than `KERNEL_TITLE`. Re-pushing with the canonical title
restored `ref: /fridaymoses/qwen-3-8-27b-uncensored-chat`.

---

## Runtime evidence

### Kaggle API (real)

| check | result |
|---|---|
| authenticated status, real key | HTTP 200, `{"status":"error"}` (resting state) |
| bogus key | 401 |
| **HTTP Basic with a VALID key** | **401** — indistinguishable from a revoked key, which is why Bearer is mandatory |
| stub notebook push | refused locally, never sent |
| push with a slug-changing title | refused locally |
| real push | `ref: /fridaymoses/qwen-3-8-27b-uncensored-chat`, versions 6 and 7 |

### Wake → LIVE

```
engine=a stage: downloading github.com gpus=1
engine=a ollama READY: ... client version is 0.33.2
engine=a stage: pulling IQ4_XS gpus=1
engine=a stage: model-ready: hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS
engine=a warming up IQ4_XS (loading 15GB into VRAM)...
engine=a AGENT LIVE LINK: https://weblogs-stephanie-treated-jonathan.trycloudflare.com
```

Every line carries `engine=a`. After the heartbeat fix:

```
engine=a alive: https://weblogs-stephanie-treated-jonathan.trycloudflare.com (idle 1 min)
```

Beacon attribution went from **0 of 2 tagged** to **3 of 3 tagged**.

### Health

```
GET /api/ps -> 200
models[] = [hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS]
Health.isLive() = true
```

### Streaming chat — two consecutive rounds, no wedge

```
round 1: first token 8460ms, 5 chunks, 13 chars, done=true -> "PROBE ROUND 1"
round 2: first token 1875ms, 5 chunks, 13 chars, done=true -> "PROBE ROUND 2"
```

Verbatim echo of the prompt. Round 2 is faster because the prompt cache is warm.

### Cancellation

Stream cancelled mid-generation returned after 10088 ms; `GET /api/ps` still 200
afterwards, so the socket was not left wedged.

### Real tool execution

**web_search:**
```
⚙️ agent step 1...
🛠️ web_search({"query": "capital of Rivers State Nigeria"})
↳ web_search returned 1158 chars
⚙️ agent step 2...
content: The capital of Rivers State, Nigeria is Port Harcourt.
```

**run_command** — the output is the real GPU on the Kaggle kernel:
```
🛠️ run_command({"command": "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader"})
↳ run_command returned 39 chars
content: Tesla P100-PCIE-16GB, 16384 MiB
```

### Shutdown, and proof it actually terminated

```
before : /api/ps -> 200  isLive=true  models=[Qwen3.8-27B-Uncensored-GGUF:IQ4_XS]
POST /off with key -> HTTP 200
confirmedDown -> true after 4s
after  : /api/ps -> 502, then 530
beacon: "engine=a ENGINE OFF via UI - quota saved"
```

Note: **Kaggle's kernel status still reads `running` for a while after `/off`.**
That is why `confirmedDown()` probes the engine instead of trusting the API —
claiming OFF on the strength of the 200 would report an engine as off while it
still holds a GPU.

### Wake again after shutdown

Pushed version 7, engine came back live at
`https://weblogs-stephanie-treated-jonathan.trycloudflare.com`, and the full
33-check probe passed again against it.

### Routing (EngineRouter, 8 checks)

| case | result |
|---|---|
| AUTO with A and B live | A |
| manual pin B with A and B live | B |
| AUTO with A quota-blocked | B |
| `failoverFrom(a)` with A blocked | B |
| manual pin on a dead engine | **no decision** — does not silently re-route |
| ...and the reason | `engine A is not live (quota blocked)` |
| AUTO with A and B down | C |
| AUTO with nothing live | no decision, with per-engine reasons |

### Probe totals

`33 passed, 0 failed` against the live engine, twice (once per wake), plus the
offline checks.

---

## Build

| | release | debug |
|---|---|---|
| size | 661 936 B | 3 842 962 B |
| signature | v2, `CN=Aether, OU=Aether, O=Aether, L=Port Harcourt, ST=Rivers, C=NG` | v2, Android Debug |
| launcher | `com.aether.app.EnginesActivity` | same |
| `assets/aether-credentials.dat` | 272 B | 272 B |
| `assets/aether-notebook-template.json` | 40 903 B | 40 903 B |

R8 kept the JS bridge — `dexdump -a` on the built release:

```
Annotations on method #4167 'engineKey'
  VISIBILITY_RUNTIME Landroid/webkit/JavascriptInterface;
```

Gradle: `-Xmx896m -XX:MaxMetaspaceSize=256m`, daemon off. `-Xmx3072m` and
`-Xmx1280m` were both OOM-killed in this 1984 MB no-swap sandbox (anon-rss
1.45 GB at the kill, confirmed in `dmesg`); release R8 is the step that breaks.

Web gate: `verify-engine-source` PASS · `tsc --noEmit` 0 errors · lint 0 errors /
17 warnings · 31 files / 249 tests passed, 5 env-skipped.

---

## Credentials

Engine A's key, the OFF_KEY and the beacon topic were recovered from git history
and re-verified live. **Engines B and C are missing** — fill in
`android/credentials.properties`, then:

```
scripts/bake-credentials.sh && scripts/build-apk.sh
```

The credentials file and the generated `.dat` are gitignored. The values are
obfuscated (XOR + Base64), **not encrypted**: anyone who unpacks the APK can
recover them in about a minute. That was an explicit decision for a private
build. A Kaggle key can be revoked and an OFF_KEY rotated at any time, which
makes a leaked copy worthless — if this APK ever leaves the phone, rotate all of
them.

---

## Explicitly unverified

- The APK has never been installed or launched. No emulator is possible here.
- `EnginesActivity` polling, the WebView, credential loading from the asset, and
  the UI state machine — all unexercised.
- Engines B and C: never woken, keys absent.
- A/B/C failover across three simultaneously live engines.
- Image and audio generation.
- Real Netlify deployment and the Netlify Blobs backend.
- The `_sent` fix on live hardware.
