# Engine control that tells the truth, and a stream that cannot hang

Date: 2026-09-06 · Builds: `apk/aether-release.apk` (721 824 B) and
`apk/aether-debug.apk` (3 889 045 B), signed `CN=Aether … C=NG`.

Two complaints, both fair:

1. the engine switch does not turn engines on/off, and the status is not
   truthful;
2. running commands leaves the reply stuck on "generating", and stop does
   nothing.

Both are addressed. §4 lists what was actually run, §5 what still is not proven.

---

## 1. Engine control: what was wrong, what it does now

**Why it looked broken.** Three separate things:

- Selecting A/B/C in Routing only wrote a preference. It never touched an
  engine, so tapping it changed nothing you could see — a switch that appears to
  do nothing.
- Wake set the row to "queued for a GPU" and then waited for the ordinary 15 s
  poll to notice anything. Booting takes 4–6 minutes, so for that whole time the
  screen said the same thing.
- Shut down called `confirmedDown()` in one silent block: no feedback for up to
  half a minute, then a single line.

**What it does now.**

- **Pinning an engine that is not live says so immediately** and offers *Pin and
  wake it* / *Just pin it*. The routing row is no longer a control that lies
  about having done something.
- **Wake reports every real step.** "wake requested — pushing the kernel to
  Kaggle…" → "kernel pushed — queued for a GPU" → then it *watches* the engine,
  refreshing every 4 s with what Kaggle and the tunnel actually say: "kernel
  running, model not warm", "tunnel up, model still loading (not live yet)",
  and finally **"LIVE — IQ4_XS"** only when `/api/ps` returns 200 with a loaded
  model. If 15 minutes pass, it says that plainly instead of implying success.
- **Shut down shows each check.** "shutting down… /api/ps still 200 (check 3/8)"
  then **"off — confirmed terminated (/api/ps now 502 after 4 checks)"**. OFF is
  never claimed on the strength of the `/off` 200 alone.
- **Polling speeds up while you are watching**: 4 s during any wake or shutdown,
  15 s otherwise, plus a **Check status now** button to force an immediate poll.
- Every action writes its outcome into the note under the cards. Nothing is
  silent, and the shut-down button is enabled in every state.

The two rules that make the status truthful are unchanged and still enforced in
`EngineCore`: LIVE requires `/api/ps` 200 **and** a non-empty `models[]`; OFF
requires `/api/ps` to stop answering.

**Still not instant, and that is physics, not the app.** Kaggle has to allocate a
GPU and load 15 GB of weights into VRAM: 4–6 minutes. Termination is faster —
measured earlier at 20–30 s for `/api/ps` to go 200 → 502 → 530. What changed is
that the screen now tells you which of those stages it is in, every few seconds,
instead of showing a frozen line.

## 2. "Stuck on generating" — the actual causes

I read the kernel's streaming code in
`android/app/src/main/assets/aether-notebook-template.json`. Two facts matter:

- while the model generates, the engine emits a heartbeat line roughly every
  10 seconds, so a healthy turn is never truly silent;
- a tool call (`run_command`, `web_search`, `crawl_site`, `fetch_page`) runs
  **synchronously and emits nothing until it returns** — bounded by the engine's
  own subprocess timeouts, the longest being 300 s.

Against that, the client had three defects:

1. **The read timeout was the whole turn timeout (600 s).** If the tunnel died
   mid-tool-call, `readLine()` blocked for up to ten minutes with no output and
   no way out. That is the "stuck on generating" you saw.
2. **Stop was only checked *between* lines.** During that block, pressing stop
   did literally nothing until the read timed out.
3. **`done:true` was checked before the payload.** The engine's fallback path
   re-emits raw Ollama lines where the final object can carry the last of the
   content *and* `done:true` together — so the tail of an answer could be
   silently dropped.

Fixes, all in `EngineCore.chatStream`:

- connect timeout and read timeout are now separate. The read slice is **1 s**,
  so the loop surfaces constantly.
- the cancel flag is checked **before** the read as well as after, so stop works
  even when nothing is arriving.
- a **stall limit** (330 s of zero bytes — above the engine's longest silent tool
  run, so a legitimate tool call is never cut off) ends the turn with
  *"engine went quiet for Ns — the tunnel or the kernel is gone"*.
- a **total ceiling** (30 min) means no turn can hang for ever.
- payload is parsed **before** `done`, so nothing is dropped.
- the terminal callback is **exactly-once**, so the UI can never be left
  mid-turn; a closed socket counts as a normal end, not a hang.
- HTTP failures now explain themselves: 403 "rejected the key", 502 "kernel died
  or tunnel closed", 530 "tunnel is gone — the engine is off".

On the screen: the "Aether is thinking…" line now disappears on the **first real
event of any kind** (a thinking line or a heartbeat, not just the first answer
token), and a live line shows *"engine B · 47s · streaming…"*, updated once a
second from measured state — so a long tool run is visibly working rather than
looking frozen.

## 3. Answering forever

- **Consecutive messages no longer pay for a fresh engine lookup.** The engine
  that just answered is reused for 45 s; it is re-resolved on any failure or when
  you pin a different engine. Previously every single message started with a
  beacon fetch and health checks.
- **If an engine drops before answering, the next one is tried automatically**
  (A → B → C), with the reason shown as a tool line: *"Engine A dropped (…) —
  failing over to B"*. A failed engine is dropped from the cache so the next
  message does not hit it again.
- There is **no turn counter and no cap** anywhere in the client. The only limits
  are the engine's own: ten agent iterations per turn, then it asks you to retry.
- Every turn ends in exactly one place (`finalizeTurn`), on the UI thread, which
  clears the streaming state, persists the transcript and refreshes the chip.

## 4. What was run

The streaming client is plain Java over a socket, so it can be driven for real
without an emulator. `scripts/proofs/StreamProof.java` stands up a local HTTP
server that speaks the engine's exact NDJSON contract — thinking lines, the
heartbeat, `🛠️` tool calls, `↳ returned N chars`, content tokens,
`{"done":true}` — and asserts what the shipped `EngineCore.chatStream` does:

```
== a normal turn                                  5/5 PASS
== content that arrives inside the done line      2/2 PASS   (nothing dropped)
== an engine that stops sending                   4/4 PASS   (ends the turn, names the silence)
== stop pressed while the engine is silent        4/4 PASS
== a long tool-heavy turn (10 rounds)             3/3 PASS
== malformed lines in the stream                  2/2 PASS
== socket closed with no done line                2/2 PASS   (not a hang)
== HTTP failures                                  2/2 PASS   (502 explained)
== the engine rejecting the key                   2/2 PASS   (403 explained)
== twenty-five turns back to back                 2/2 PASS   (25/25, no hang)

STREAM PROOF  28 passed, 0 failed        (11.7s)
```

The stop test measured the real cost of the old design: with an 8 s read slice,
stop took **8012 ms**; with the shipped 1 s slice it lands inside that window
(the assertion is `ms < readSliceMs + 2000`, and it also asserts the long-slice
case *is* slow, so the trade is documented rather than assumed).

| Check | Command | Result |
|---|---|---|
| Streaming client vs live local server | `java -cp /tmp/sp StreamProof` | **28 passed, 0 failed** |
| Chat core | `java -cp /tmp/cc ChatCoreCheck` | **70 passed, 0 failed** |
| Routing | `java -cp /tmp/rc RouterCheck` | **19 passed, 0 failed** |
| Control wiring | `python3 scripts/proofs/wiring-report.py` | every interactive control bound |
| Debug build | `gradle :app:assembleDebug` | BUILD SUCCESSFUL, exit 0 |
| Release build | `gradle :app:assembleRelease` (signed) | BUILD SUCCESSFUL, exit 0 |
| Signature / launcher | `apksigner` · `aapt dump badging` | verified · `SplashActivity` |
| Credentials at rest | `grep -c KGAT` on the baked asset | `0` |
| TypeScript · Lint · Tests | `tsc` · `eslint .` · `vitest run` | 0 · 0 errors/17 warnings · 249 passed |

## 5. What is NOT proven

- **The APK has never been installed.** No `/dev/kvm` in this sandbox, so the new
  Settings states, the wake watcher, the ticking streaming line and the failover
  message have never been rendered on a screen.
- **`StreamProof` is not the real Kaggle engine.** It is a local server that
  reproduces the engine's wire format, read out of the kernel source. It proves
  the *client*: that a turn always terminates, that stop is honoured promptly,
  that content is not dropped, and that turn 25 behaves like turn 1. It does not
  prove the Kaggle kernel, the Cloudflare tunnel, or the model.
- **No engine was woken in this turn.** All three are OFF, and waking one to
  verify the new watcher end-to-end costs real GPU quota — say the word and I
  will wake A and walk the whole thing with live output.
- Engine C has never been woken; image/audio generation is still unproven.
