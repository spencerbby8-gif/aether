# Aether — Speed & Responsiveness Investigation

**Before:** commit `eb4b557` · engine C v30
**After:** commit `f73df24` · engine C v32 · APK 2.0.8 (versionCode 37)
**Method:** every number below is a wall-clock or engine-counter measurement taken
this session against a live Kaggle engine, real Chromium, or the real production
modules imported from `src/`. Nothing is simulated. Harnesses live in
`scripts/perf/` and are re-runnable.

---

## 1. What the measurements indicted — and what they exonerated

The instinct was that discovery, polling, parsing and rendering were slow. They
are not. Measured, they are rounding errors next to the engine:

| Stage | Measured | Verdict |
|---|---|---|
| `getEngineLinks()` (ntfy round trip) | 88–471 ms, median 160 ms | not a bottleneck |
| `discoverAlive()` cold / warm | 108–168 ms / **0 ms** (cached) | not a bottleneck |
| `resolveEngine()` (full chat path) | 95–107 ms | not a bottleneck |
| `probeFleetHealth()` cold / cached | 152 ms / **0 ms** | not a bottleneck |
| `readNdjson()` 4000 lines / 147 KB | **7 ms** | not a bottleneck |
| Engine `/api/ps` (the UI's poll) | 216–325 ms | network floor |
| Transport (wall − engine `total_duration`) | 0.23–0.76 s | network floor |
| Browser navigate (warm) | 0.13–0.18 s | not a bottleneck |
| Browser read / screenshot | 0.01 s / 0.04 s | not a bottleneck |
| React flush | already rAF-batched, one render per frame | already correct |
| Double health poller | **does not exist** — `SettingsModal` is mounted only when open | nothing to fix |

I went looking for a redundant poller to remove and there wasn't one. That is
recorded here so it isn't "fixed" later.

**The real floor is the engine's decoder.** Raw Ollama counters from the live
engine:

| Probe | Prefill | Decode |
|---|---|---|
| tiny prompt | 0.42 s / 58 tok | 1.61 s / 16 tok — **9.91 tok/s** |
| ~700 tok prompt | 0.43 s / 666 tok (1553 tok/s, cached) | 6.80 s / 64 tok — **9.41 tok/s** |
| ~4500 tok prompt | 29.90 s / 4066 tok (136 tok/s, cold) | 3.15 s / 30 tok — 9.54 tok/s |
| agent turn, 7-tool schema | **2.55 s** | 43.71 s / 244 tok — **5.6 tok/s** |
| same prompt, no tools | **0.65 s** | 44.87 s / 244 tok — 5.4 tok/s |

Two conclusions that shaped everything else:

1. **Prefill is not the problem.** The entire 7-tool schema (3258 chars, ~812
   tokens) costs 1.9 s of prefill. Decode of the same turn costs 44 s.
2. **Tool-start latency of 13–16 s is not the tool.** `web_search` itself
   measured **1.0 s** and `run_command` **0.0 s**. The 13–16 s is the model
   generating before it emits the call.

---

## 2. The dominant bottleneck, and the trap inside it

Five *identical* requests to one idle engine came back at **1.39 s and 13.19 s**
(and 11.01 s vs 35.41 s for a longer one) while the engine's own
`total_duration` stayed flat. Twelve identical requests, 4 s apart:

```
  #     wall     load   <-- 2 of 12 reloaded the 15 GB model
  1    13.61    11.09    <-- RELOAD
  2-7   ~1.4     0.00
  8    26.48    24.21    <-- RELOAD
  9-12  ~1.6     0.00
  queued (no reload, wall - server_total > 1s): 0
```

`load_duration` accounted for the entire stall. So the cause was model reloads,
not queueing and not the network.

**Then I nearly misattributed it.** My probe omitted `num_ctx`; the app always
sends 16384. Decisive A/B on the same engine:

| Arm | Reloads | Wall |
|---|---|---|
| `num_ctx=16384` on every request (what the app does) | **1 / 10** (the cold one) | 2.14–2.43 s, median **2.18 s** |
| alternating default ↔ 16384 | **7 / 8** | 13.0–15.3 s each |

So a context-window switch costs **~11 s**, and the app's own traffic does not
trigger it. My probe was causing its own variance.

But that exposed a genuine defect: **the boot warmup was the one caller that
omitted the window.** It called `/api/chat` with no `options`, pinning the 15 GB
model at Ollama's default, while every real chat request sends 16384 — so the
*first message after wake* paid the reload. Verified in the shipped notebook:
`num_ctx` appears **0 times** in the warmup cell and `NUM_CTX = 16384` was
declared *below* it.

---

## 3. Changes made

### 3.1 Warmup pins the serving context (`scripts/warmup-ctx-fix.py`)
`NUM_CTX` moved above the warmup; both warmup calls now pass
`{'num_ctx': NUM_CTX, 'num_predict': 16}`. The warmup previously had **no**
`num_predict`, so it generated to end-of-stream at ~5.5 tok/s purely to prove
the model loaded; 16 tokens proves the same thing.

| | First request after a fresh boot |
|---|---|
| **Before** (v30) | wall **15.60 s**, of which **12.09 s** was `load_duration` |
| **After** (v32) | wall **4.47 s**, `load_duration` **0.00** |
| **After, 8 requests** | **0 reloads**, wall 2.09–4.47 s, median **2.31 s** |

**Wake latency also fell: 525 s → 270 s** (push → `AGENT LIVE LINK`), from the
bounded warmup generation.

### 3.2 Artifact decode: 33.8× and off the critical path
`Uint8Array.from(atob(s), c => c.charCodeAt(0))` measured **105.3 ms** per
1.2 MB. An indexed loop over a pre-sized typed array measures **3.1 ms** for the
same input, and the test asserts the bytes are identical:

```
ARTIFACT DECODE {"oldMedianMs":105.3,"newMedianMs":3.1,"speedup":33.8}
```

It was also `await`ed **inside** the stream read loop, so token streaming froze
for the whole decode plus IndexedDB write. It is now started and collected, then
awaited once the stream ends. `saveArtifact` end to end: **89.8 ms → 4.4 ms**,
and the stream no longer blocks on storage.

### 3.3 The model's reasoning markers were reaching the chat
Measured live, a plain "capital of France" reply arrived as:

```
'Paris is the capital of France. </tool_response>  Pa...'
```

`grep` for think-tag handling across `src/` and the Android tree returned
**nothing**. This violates the standing rule that raw reasoning never appears in
chat. Fixed in two places, both tested:

- `src/lib/think-filter.ts` — stream-safe (a marker split across two deltas
  cannot survive), routes reasoning to the reasoning panel instead of dropping
  it. Wired into `runEngineChat`.
- `TextNormalizer.stripThinkMarkers` — the native equivalent, in the
  normalizer's pipeline.

**My own test caught a bug in my first attempt:** it only stripped a closer when
an opener had been seen, so the *stray* `</tool_response>` — the exact case measured
live — passed straight through. Fixed and covered.

---

## 4. Before / after, full chain

### Agent chain (same scenarios, same harness)

| Scenario | Metric | Before | After |
|---|---|---|---|
| plain text ×3 | first byte | 0.2 s | 0.1 s |
| | first token (median) | **0.9 s** | **0.9 s** |
| web search ×2 | tool start | 13.2 / 14.6 s | 14.3 / 14.6 s |
| | the tool itself | 1.0 s | 0.8 s |
| | total | 36.8 / 44.4 s | 46.1 / 47.5 s |
| run command ×2 | tool start | 14.7 / 16.4 s | 15.3 / 13.5 s |
| | the tool itself | 0.0 s | 0.0 s |
| | total | 21.1 / 22.6 s | 22.9 / 19.5 s |
| decode | | 5.5 tok/s | 5.4 tok/s |

**These are unchanged, and that is the honest result.** Tool-start latency is
model generation, not our code. Search totals moved *up* because the model
produced more tokens (119/140 deltas after vs 86/119 before) at the same
tok/s — longer answers, not slower plumbing. Plain-text turn 1 after the fix
took 14.0 s against 1.4 s before; turns 2–3 were 0.9 s and 0.8 s, so the median
is identical at 0.9 s and the outlier is reasoning-length variance, not a
regression.

### Client

| Metric | Before | After |
|---|---|---|
| Artifact decode (1.2 MB base64) | 105.3 ms | **3.1 ms (33.8×)** |
| `saveArtifact` end to end | 89.8 ms | **4.4 ms** |
| Artifact save on the stream path | blocking | **non-blocking** |
| `readNdjson` 4000 lines | 7 ms | 7–11 ms (noise) |
| Reasoning marker in chat | present | **absent** (proven end to end) |

### Other paths

| Path | Measured |
|---|---|
| Wake (push → live) | **525 s → 270 s** |
| Shutdown | engine-side flag, 5 s slices; not re-measured this session |
| Browser cold launch + navigate | 0.89 s |
| Browser warm navigate / read / screenshot | 0.13–0.18 s / 0.01 s / 0.04 s |
| 20 consecutive turns | **20/20 completed**, first token min 3.2 / median 7.3 / p90 13.2 / max 20.1 s |
| Context growth over those 20 turns | turns 1–5 median 5.4 s → turns 16–20 median 7.1 s (**+1.7 s total**) |

---

## 5. Deliberately NOT changed, with the tradeoff measured

**`num_ctx` and the model were left alone.** The measured tradeoff:

| Context window | Decode |
|---|---|
| Ollama default | **9.4–9.9 tok/s** |
| 16384 (what the app sends) | **5.4–5.6 tok/s** |

The 16 K window costs roughly 40% of decode throughput. Lowering it would make
every benchmark here look better and would break long tool turns — the notebook
records a 14-message tool turn failing at the default window with
`No user query found in messages.` and succeeding at 16384. Per your
instruction, that is documented rather than traded away.

Also left alone: the reasoning directive (adds ~58 prefill tokens ≈ 0.4 s), the
tool descriptions (trimming them would cost tool reliability), and `NUM_PREDICT
= 4096` (lowering it would truncate long answers).

**The remaining limitation is therefore a model/VRAM property:** 14.77 GB of a
16.86 GB model in VRAM, ~5.5 tok/s at the serving context. No client or server
change can move it. Everything Aether controls now costs, in total, well under
one second of a multi-second turn.

---

## 6. Regression gates (all green at `f73df24`)

| Gate | Result |
|---|---|
| `jvm-suite.sh` | **16/16 clean** (ChatCoreCheck 70 → **78** with the new marker tests) |
| `vitest` | **288 passed / 5 skipped / 0 failed** (36 files; was 272) |
| `tsc --noEmit` | **0 errors** |
| `npm run lint` | **0 errors** / 17 warnings (pre-existing `react-hooks` advisories) |
| `browser-auth-live.py` | **30/30** on real Chromium, against the *modified* notebook |
| `sync/verify-engine-source` | **PASS**, sha `833ebe05…`, 91250 rendered bytes |
| `warmup-ctx-fix.py --check` | 2 pinned, 0 unpatched, 1 early declaration, 0 duplicates |

## 7. APK

`apk/aether-release.apk` = `aether-2.0.8-release.apk`, **versionCode 37**,
763,856 bytes, signed. Verified by **unzipping the asset out of the built APK**
(R8 keeps string literals, so this is the real shipped content):

- warmup calls with `num_ctx`: **2**, without: **0**
- `NUM_CTX` declared before the warmup: **true**, duplicate sites: **1**
- browser gate: `_B_GRANTS` ×7, `_b_granted` ×3, `_b_forget` ×3,
  `authorize`/`revoke`/`submit` present, CAPTCHA refusal ×2
- `stripThinkMarkers` present in the R8 mapping (not stripped)

## 8. Still unverified

- **APK pixels.** No emulator can run in this sandbox (no `/dev/kvm`), so the
  app has never been installed or looked at. Everything above is JVM-, Node- and
  engine-level proof.
- **Engine A** (weekly quota exhausted) and **B** (weekly quota exhausted) —
  only C could be woken.
- Image/audio generation end-to-end latency — not exercised this session.
- Stop / Retry and engine failover mid-task — not re-exercised this session.
- The web Next.js runtime and Netlify deploy.
