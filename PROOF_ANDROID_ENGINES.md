# PROOF — Android APK driving the three real Kaggle engines

Date: 2026-09-06. Kernel `qwen-3-8-27b-uncensored-chat`, model
`hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS`.

Every result below came from a real network call to Kaggle, ntfy, or a live
engine. Nothing is inferred from source, a mock, or a unit test.

---

## The caveat, stated first

**The installed APK was never run.** This sandbox has no `/dev/kvm` and
`grep -cE "vmx|svm" /proc/cpuinfo` returns `0`, so no Android emulator can boot
here.

What was tested instead: `EngineCore.java` and `EngineRouter.java` contain **no
`android.*` imports**, so `scripts/proofs/` compiles those exact files with a
stock `javac` and runs them against the real endpoints. All networking, parsing,
routing, health-checking and shutdown logic the APK executes is genuinely tested.
**The Activities, the WebView and asset loading are not.** Treat everything
UI-level as unverified.

---

## Credentials — all three verified live before baking

| Engine | Account | Kaggle status | Ownership |
|---|---|---|---|
| A | `fridaymoses` | HTTP 200 | lists `fridaymoses/qwen-3-8-27b-uncensored-chat` |
| B | `spencercoldtr` | HTTP 200 | lists `spencercoldtr/qwen-3-8-27b-uncensored-chat` |
| C | `dyceelvk` | HTTP 200 | lists `dyceelvk/qwen-3-8-27b-uncensored-chat` |

Listing each account's own kernels proves **ownership**, not just that the key is
unexpired — a valid key aimed at someone else's kernel gets 403 on push.

Baked-asset round trip, checked without printing a key: three engines present,
all keys 37 characters, and `strings` on `aether-credentials.dat` finds **0**
plaintext `KGAT_` occurrences. Same check on both built APKs: 0 hits.

---

## The headline test: two engines live at the same time

This is the test single-engine testing cannot do. With one engine you cannot tell
correct slot attribution from luck, and you cannot exercise failover at all.

`scripts/proofs/MultiEngineProof.java`, **21 passed, 0 failed**:

```
== 1. Discovery
  A -> https://enhanced-concerts-favourites-poison.trycloudflare.com
  B -> https://berkeley-photo-apply-looksmart.trycloudflare.com
  PASS  A and B got DIFFERENT urls

== 2. Health
  A /api/ps 200 [Qwen3.8-27B-Uncensored-GGUF:IQ4_XS]
  B /api/ps 200 [Qwen3.8-27B-Uncensored-GGUF:IQ4_XS]

== 3. Routing with both live
  PASS  AUTO picks A                       -- A (auto: first healthy in A→B→C)
  PASS  AUTO returns A's real url
  PASS  manual pin on B selects B, not A
  PASS  failoverFrom(a) lands on B

== 4. Chat on EACH engine
      A said: FROM ENGINE A
      B said: FROM ENGINE B
  PASS  A and B are different engines (different replies)

== 5. Failover when A dies
  PASS  A /off accepted                -- HTTP 200
  PASS  A confirmed terminated         -- /api/ps now 502
  PASS  AUTO now routes to B
  PASS  ...and returns B's url
  PASS  B still serves after A died    -- STILL WORKING ON B

== 6. Shut down ALL
  PASS  B /off accepted                -- HTTP 200
  PASS  B confirmed terminated         -- /api/ps now 502
  PASS  BOTH engines down
```

Asking each engine to identify itself is the point of step 4: `FROM ENGINE A`
coming back from A's URL and `FROM ENGINE B` from B's proves the attribution is
correct, not merely plausible.

---

## Four bugs found by running the engine, not by reading it

All four produced output that looked like success.

### 1. Chat sent the wrong model name

The engine builds its ollama payload as `user_payload.get('model', MODEL)`, so a
client-supplied `model` **overrides the model loaded in VRAM**. `EngineCore` sent
`"model":"aether"`; the engine replied `{"content":"(model timeout/error)"}` with
`done:true` — a well-formed, successfully parsed, empty-looking success.
Measured: 181 ms to first token, 1 chunk, 21 chars, all of it that string.
Fix: omit the field.

### 2. Beacon attribution lost for exactly the engines that were up

The idle heartbeat called `_ntfy()` directly, bypassing `notify()`, so it was
untagged — and it is the **newest** announcement for a running engine.
`liveLinks()` compared recency before attribution, so the tag was dropped.
Observed live: 2 links on the topic, **0 tagged**, although both
`AGENT LIVE LINK` lines said `engine=a`. Fixed on both sides: the heartbeat now
emits `engine=<slot>` (pin `ef0c7fe7c42345b3…`), and the client prefers an
attributed sighting regardless of age.

### 3. The NDJSON shape was guessed, and wrong

The engine emits Ollama's format — `{"message":{"thinking":…}}`,
`{"message":{"content":…}}`, `{"message":{"content":""},"done":true,…}`. There is
no `type` and no `text` field. The first parser matched nothing, consumed the
stream, and reported a clean success with zero content.

### 4. A push with a per-engine title orphaned the kernel

Kaggle derives the slug from the title. Pushing `"Aether engine A"` moved the
kernel to `/aether-engine-a` and the real slug began returning **404 to a valid
key**. `kernelPush` now refuses any title but `KERNEL_TITLE`.

---

## Four defects found by auditing my own Android code

1. **Thread safety.** `states`/`liveUrls`/`healthCodes` were plain `HashMap`s
   mutated on the poll thread and read on the UI thread. Concurrent put during a
   resize can lose entries or spin; the visible symptom is an engine row that
   never updates, which looks exactly like an engine that is down. Now
   `ConcurrentHashMap`.
2. **No shut-down-all.** Power control must release every GPU. Leaving one up
   keeps burning quota while the UI says everything is off. Added a bulk path
   that confirms each engine individually and names any that did not go down.
3. **Double poll loops.** `onResume` started a loop and `onPause` only set a
   flag, so a fast pause/resume could leave two running and double the Kaggle
   calls. Now an `AtomicInteger` generation counter retires the previous loop.
4. **Stale URL on open.** A Cloudflare quick tunnel changes on every boot.
   `currentLinkFor()` existed but was never wired in — dead code. Open now
   re-discovers and takes the first candidate that is genuinely live.

---

## Other runtime evidence

**Kaggle API:** authenticated status 200 · bogus key 401 · **HTTP Basic with a
valid key also 401** (indistinguishable from a revoked key — why Bearer is
mandatory) · stub push refused locally · slug-changing title refused locally ·
real pushes: A v8, B v3.

**Wake:** every beacon line tagged — `engine=a stage: pulling IQ4_XS`,
`engine=a AGENT LIVE LINK: …`, and after the fix `engine=a alive: … (idle 1 min)`.

**Tools, on a real engine:**
```
web_search  -> agent step 1, tool call, 1158 chars back -> "Port Harcourt"
run_command -> nvidia-smi returned "Tesla P100-PCIE-16GB, 16384 MiB"
```

**Streaming:** two consecutive rounds returned `PROBE ROUND 1` / `PROBE ROUND 2`
verbatim (8.5 s then 1.9 s to first token). Cancellation returned with the engine
still healthy afterwards.

**Shutdown:** `/off` 200 → `confirmedDown` true in 4 s → `/api/ps` 502 then 530 →
beacon `engine=a ENGINE OFF via UI - quota saved`.

Note: **Kaggle's kernel status still reads `running` for a while after `/off`.**
That is why `confirmedDown()` probes the engine instead of trusting the API —
trusting the 200 would report OFF while a GPU is still held.

---

## Build

| | release | debug |
|---|---|---|
| size | 663 736 B | 3 822 432 B |
| signature | v2, `CN=Aether, OU=Aether, O=Aether, L=Port Harcourt, ST=Rivers, C=NG` | v2, Android Debug |
| package | `com.aether.app` | `com.aether.app.debug` |
| launcher | `com.aether.app.EnginesActivity` | same |
| `assets/aether-credentials.dat` | 484 B | 484 B |
| `assets/aether-notebook-template.json` | 40 903 B | 40 903 B |
| plaintext `KGAT_` in assets | **0** | **0** |

R8 kept the JS bridge — `dexdump -a` on the built release:

```
Annotations on method #4209 'controlToken'
  VISIBILITY_RUNTIME Landroid/webkit/JavascriptInterface;
Annotations on method #4210 'engineKey'
  VISIBILITY_RUNTIME Landroid/webkit/JavascriptInterface;
```

Gradle: `-Xmx896m -XX:MaxMetaspaceSize=256m`, daemon off. `-Xmx3072m` and
`-Xmx1280m` were both OOM-killed in this 1984 MB no-swap sandbox (anon-rss
1.45 GB at the kill, confirmed in `dmesg`); release R8 is the step that breaks.

Web gate: `verify-engine-source` PASS · `tsc --noEmit` 0 errors · lint 0 errors /
17 warnings · 31 files / 249 tests passed, 5 env-skipped.

---

## Explicitly unverified

- **The APK has never been installed or launched.** No emulator is possible here.
- `EnginesActivity` polling, the WebView, credential loading from the asset, and
  the UI state machine — all unexercised.
- **Engine C was never woken.** Its key is baked and verified against Kaggle, but
  no kernel was pushed to it, so three-way simultaneous routing is unproven. A
  and B were both live at once and routed correctly.
- Image and audio generation.
- Real Netlify deployment and the Netlify Blobs backend.

---

## If this APK leaves your phone

The three Kaggle keys and the OFF_KEY are inside it, obfuscated but recoverable
in about a minute by anyone who unpacks it. That was an explicit decision for a
private build. Revoke the keys and rotate `ENGINE_OFF_KEY` — a leaked copy then
becomes worthless.
