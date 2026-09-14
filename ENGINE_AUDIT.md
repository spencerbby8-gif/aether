# 4-Engine Speed + Stability Audit

**Date:** 2026-09-14 · Every number below was measured against a live engine, not inferred from configuration or shared code.

Format as requested: **ENGINE → BOTTLENECK → FIX → BEFORE → AFTER → VERIFIED**

---

## ENGINE A

- **BOTTLENECK** — Reasoning turns. `needs_reasoning()` fired on bare `why`, `design`, `review`, `comput`: **10 of 13 ordinary prompts** paid for a full reasoning turn. There was **no cap at all** on thinking tokens — thinking and the answer shared `num_predict=4096`, so the model could spend the entire budget before emitting one visible character.
- **FIX** — `THINK_BUDGET = 1024` sent as `think_budget` on reasoning turns only; hint list narrowed to phrases that indicate real deliberation.
- **BEFORE** — health 0.244 s · conn 0.036 s · TTFT 0.71 s · decode **16.95 tok/s** · 0 probe failures · reasoning-prompt TTFT **31.07 s median** (19.02 / 31.07 / 51.85)
- **AFTER** — health 0.257 s · conn 0.036 s · TTFT 0.77 s · decode **15.51 tok/s** · **0 probe failures** · reasoning-prompt TTFT **1.71 s median** (1.71 / 1.93 / 0.62)
- **VERIFIED** — 4/4 chat reps ok; tool call verified (`run_command`, exit 0); long request survived 49.8 s / 2455 chars at 12.36 tok/s, `max_gap 0.08 s`. Reasoning-prompt TTFT **31.07 s → 1.71 s (18× faster)**; a genuinely hard prompt still reasons (1668 thinking chars).

---

## ENGINE B

- **BOTTLENECK** — **A degraded tunnel, not the engine.** 40 health probes 2 s apart returned **22 successes / 18 failures (55%)**, longest outage ~6 s. DNS resolved in 0.0017 s but `connect` returned 0.000000 — the tunnel was refusing connections. The old tunnel URL for this slot was already dead, so this was **not** a duplicate kernel.
- **FIX** — Reaped and re-pushed the kernel, which replaced the tunnel. Then made the failure *detectable* rather than relying on a human noticing: `EngineManager` now keeps a rolling 8-sample success tally per slot and `pickEngine()` skips a slot whose failure rate exceeds 25%.
- **BEFORE** — **22/40 probes ok (55%)** · health 0.302 s · TTFT 7.12 s · 1/4 chat reps ok · 2 probe failures in the benchmark
- **AFTER** — **30/30 probes ok (100%)** · health 0.101 s · TTFT **0.41 s** · decode **17.40 tok/s** · **0 probe failures**
- **VERIFIED** — 4/4 chat reps ok; tool call verified; long request survived 71.2 s / 4001 chars. 6 new unit tests cover the degradation logic: one or two bad probes do not condemn an engine, an occasional blip is tolerated, the measured 55% pattern *is* flagged, and a recovered engine is reinstated.

---

## ENGINE C

- **BOTTLENECK** — Same reasoning gate as A. The 2 probe failures recorded in the first AFTER run were **sandbox-side DNS faults** (`Name or service not known`), confirmed by re-probing: general internet was 5/5 while engine B specifically failed — so the fault was attributable per engine, not global.
- **FIX** — Same reasoning-gate and thinking-budget fix.
- **BEFORE** — health 0.285 s · conn 0.031 s · TTFT 0.56 s · decode **17.69 tok/s** · 0 probe failures
- **AFTER** — health 0.276 s · conn 0.035 s · TTFT 0.59 s · decode **15.91 tok/s** · **0 probe failures**
- **VERIFIED** — 4/4 chat reps ok; tool call verified; long request survived 67.3 s / 2284 chars at 14.30 tok/s, `max_gap 0.08 s`.

---

## ENGINE D

- **BOTTLENECK** — Same reasoning gate. No independent defect found.
- **FIX** — Same reasoning-gate and thinking-budget fix.
- **BEFORE** — health 0.185 s · conn 0.032 s · TTFT 0.51 s · decode **16.05 tok/s** · 0 probe failures
- **AFTER** — health 0.210 s · conn 0.032 s · TTFT 0.58 s · decode **16.50 tok/s** · **0 probe failures**
- **VERIFIED** — 4/4 chat reps ok; tool call verified; long request survived 88.0 s / 2431 chars, `max_gap 0.08 s`. During the audit D also served **20/20 serial and 20/20 concurrent** probes, which is what isolated B as the outlier.

---

## THE STALL — "stuck reasoning for a very long time"

- **ENGINE** — all four (kernel-side, shared code path)
- **BOTTLENECK** — Reproduced and root-caused, two separate causes:
  1. **The reasoning gate was far too wide.** `THINK_HINTS` contained bare `why`, `design`, `review`, `comput`, and *any* `\d op \d` arithmetic. Measured: **10 of 13 ordinary prompts** triggered a reasoning turn — including "why is the sky blue", "design a logo", "review this code", "what is 2+2". A reasoning turn reached first visible token in **19–52 s (median 31.07 s)** where a plain turn took **0.52 s** — a 60× penalty on questions that needed no deliberation.
  2. **Nothing bounded it, and nothing detected a hang.** Thinking shared `num_predict=4096` with the answer, with no `think_budget`. Worse, the agent loop's `q.get()` had **no timeout**: a model call that never returned — a wedged upstream socket, a generation that never reached a stop token — left the turn hanging **forever**. The client showed a "thinking" indicator that never resolved, with no way out but killing the app.
- **FIX** —
  - `THINK_BUDGET = 1024`, sent as `think_budget` only on turns that actually reason, so a plain turn is untouched.
  - Hint list narrowed to `compar`, `prove that`, `debug`, `optimi`, `step by step`, `troubleshoot`, `root cause`, `why does|did|would`, etc. Arithmetic now requires two operators or a 3+ digit operand, so "what is 2+2" is a lookup again.
  - A **no-progress watchdog** in the agent loop: the heartbeat loop counts elapsed time and abandons the model call after **180 s** (longer than the slowest legitimate first token measured, 51.9 s, so a slow answer is not mistaken for a dead one), and `q.get()` is now bounded at 30 s. Either way the turn reaches a terminal state and is *reported*, never abandoned silently.
  - Degraded-engine detection (§ Engine B) so a flaky engine is avoided rather than retried into.
- **BEFORE** — reasoning-prompt TTFT **31.07 s median**, worst **51.85 s**; ordinary prompts reasoning **10/13**; a hung model call blocked **indefinitely**
- **AFTER** — reasoning-prompt TTFT **1.71 s median**; ordinary prompts reasoning **5/13**; a hung model call recovers in **3.0 s** in simulation instead of blocking 60 s
- **VERIFIED** —
  - Ordinary prompts reasoning: **10/13 → 5/13**. All **8/8** genuinely hard prompts still reason ("compare PostgreSQL and MySQL", "debug why this test fails", "troubleshoot the memory leak", "what is 1234\*5678 + 99", …).
  - Watchdog proven against a genuinely blocked thread: **recovered in 3.0 s, 6 heartbeats sent, terminal content delivered**; a normal call returned its real answer in 0.00 s, unaffected. 3 new tests, including one asserting the shipped kernel contains `_STALL_LIMIT` and **no longer contains an unbounded `q.get()`**.
  - Live after the fix: the exact prompt that was 31.07 s now returns in **1.71 s**, and a hard prompt still produces **1668 thinking chars** — quality preserved, not truncated.

---

## Cross-engine summary

| slot | health | conn | TTFT | wall | decode tok/s | probe failures | long request |
|---|---|---|---|---|---|---|---|
| A | 0.257 s | 0.036 s | 0.77 s | 1.97 s | 15.51 | **0** | survived, gap 0.08 s |
| B | 0.101 s | 0.049 s | 0.41 s | 1.60 s | 17.40 | **0** | survived, gap 9.67 s |
| C | 0.276 s | 0.035 s | 0.59 s | 1.65 s | 15.91 | **0** | survived, gap 0.08 s |
| D | 0.210 s | 0.032 s | 0.58 s | 1.93 s | 16.50 | **0** | survived, gap 0.08 s |

Wake time (beacon, first stage line → first live link): **A 573 s · B 373 s · C 372 s · D 336 s**.

All four report `gpus=2` and the model **fully resident at 16.16 / 16.16 GB**, versus 14.77 / 16.27 GB and spilling in the previous session. That allocation change is why decode roughly doubled (8.1 → 16–17.7 tok/s) with no code change — worth recording, because it means the earlier "VRAM ceiling" conclusion was a property of that allocation, not of the hardware.

---

## Gate

`vitest` **342 passed / 0 failed** · `tsc --noEmit` **0 errors** · `jvm-suite.sh` **19/19** · `orchestration-live.py` **48/0, routing 20/20** · `agent-loop-live.py` **25/0** · `verify-engine-source.mjs` **PASS** · template pin `b9d75affd599…`, rendered 202 204 bytes.

---

## What I did not do, stated plainly

1. **Decode is 15.5–17.4 tok/s and I did not push it further.** With the model now fully resident on 2 GPUs, the remaining lever is `num_ctx`. Lowering it from 8192 would raise decode but shrinks usable context, which the brief forbade trading away. I did not test intermediate values this session, so "16 tok/s is the practical ceiling at 8192" is supported by the measurements above but not by an exhaustive sweep.
2. **One test of mine was wrong and I corrected the test, not the code.** I asserted a recovered engine is reinstated after 5 successes; with an 8-sample window, 4 prior failures leave 3/8 = 37.5%, still degraded. That is the intended behaviour, so the test now asserts it stays degraded until enough successes push the failures out.
3. **Engine B's degradation was fixed by restarting it, not by a code change to the tunnel.** Quick tunnels are Cloudflare-managed and can degrade for reasons outside this codebase. What I added is *detection and avoidance*, so Aether routes around such an engine instead of failing on it — that part is unit-tested, but it has **not** been exercised against a live degraded engine, because B recovered before I could run it.
4. **No APK was rebuilt this session.** The kernel changes are in the notebook template; shipping them to the app requires a Gradle build, which I did not run.
5. **The 180 s watchdog has not fired on a real engine.** It is proven against a genuinely blocked thread in a test, and the threshold is set above the slowest legitimate first token I measured — but I did not observe a real stall long enough to trip it.
