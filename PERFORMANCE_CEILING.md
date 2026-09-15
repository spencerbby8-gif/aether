# PERFORMANCE CEILING + WAKE OPTIMIZATION PASS — 2026-09-15

Every number measured this session against live Kaggle engines (A: v74→v75,
B: v69→v71, C: v50→v53, D: v29→v38). Benchmark = identical
`scripts/perf/engine-bench.py --reps 3` before and after. Evidence files:
`scripts/perf/output/bench-{A..D}.txt` (before, commit 22befc9),
`bench-after-{A..D}.{txt,json}`, `wake-cached-all.txt`, beacon timelines
inline below.

---

## ENGINE → WAKE → TTFT → TOK/S → TOOL LATENCY → STABILITY → BOTTLENECK → FIX → BEFORE → AFTER

### Engine A
- WAKE: kernel→LIVE **416s → 37s** (ollama cache +19s, model cache +30s)
- TTFT warm median: 0.80s → **0.72s** (first_byte 0.12–0.38s)
- TOK/S decode: 14.95 → **15.38** (ctx 16k, fully resident 15.05GB)
- TOOL latency: first tool 6.57s → **6.30s**; tool task 9.42s → **8.92s**
- STABILITY: health RTT 0.168–0.283s, 0 failed probes; stream 75 ch/s
- BOTTLENECK: was model pull (353s of boot); now Kaggle's GPU queue
- FIX: dataset-cache boot; nothing engine-side left to fix
- BEFORE → AFTER: boot 416s → 37s; everything else within noise

### Engine B
- WAKE: **212s → 34s** to LIVE (WARM OK +220s, backgrounded)
- TTFT warm median: 0.64s → **0.52s**
- TOK/S: 14.52 → **15.20**
- TOOL: first tool 7.91s → **6.52s**; tool task 14.55s → 15.67s (model-driven variance, both single-turn)
- STABILITY: health 0.272–0.532s (slowest medians of the four), 0 failed probes
- BOTTLENECK: tunnel RTT (its quick tunnel hops are the slowest); decode at ceiling
- FIX: dataset-cache boot; router now measures B's latency and avoids it when another engine is decisively faster
- BEFORE → AFTER: boot 212s → 34s

### Engine C
- WAKE: **151s → 38s** to LIVE
- TTFT warm median: 0.61s → **0.59s**
- TOK/S: 15.28 → **15.34** (fastest of the four)
- TOOL: first tool 7.27s → **5.97s** (fastest); tool task 8.95s → **8.35s** (fastest)
- STABILITY: health 0.125–0.623s, 0 failed probes this pass (its tunnels died repeatedly in the morning session — Cloudflare-side, mitigated by isDegraded routing, not fixable from the kernel)
- BOTTLENECK: tunnel RTT variance; decode at ceiling
- FIX: dataset-cache boot
- BEFORE → AFTER: boot 151s → 38s

### Engine D
- WAKE: **262s → 36s** to LIVE (WARM OK +241s, backgrounded)
- TTFT warm median: 0.51s → **0.52s**
- TOK/S: 14.95 → **13.81–14.68** (ran the ceiling matrix this session — repeated reloads between configurations cost it some steady-state)
- TOOL: first tool 6.50s → 6.75s; tool task 12.57s → **9.93s**
- STABILITY: health 0.137–0.552s, 0 failed probes; also the stall-test victim (recovered in 1.8s after the wedge cleared)
- BOTTLENECK: none engine-side; Kaggle queue at wake
- FIX: dataset-cache boot + silence watchdog proven on it
- BEFORE → AFTER: boot 262s → 36s

**Rep-1 TTFT of 17–18s on every engine (before and after) is the
benchmark's own artifact**: section 3 sweeps num_ctx, and Ollama reloads the
model on any num_ctx change (measured load_duration 9.7–10.6s). Production
chat never changes num_ctx (always 8192), so warm turns see 0.5–0.8s; the
diagnostic /api/generate proxy can still trigger a reload if called with a
different num_ctx — documented, not a user path.

---

## COLD WAKE ROOT CAUSE

Measured from beacon stage timelines on all four accounts: every kernel
start re-downloaded the 1.42 GB Ollama tarball from GitHub (21–41s) and
re-pulled the 16.9 GB model from Hugging Face (111–353s) — network transfers
of bytes that never change, repeated on every boot, on top of Kaggle's own
GPU-queue scheduling (60–540s push→start, not controllable from here).

FIX: one private `aether-engine-cache` dataset per account (built once by
`scripts/push-cache-builder.py`: Ollama tarball + the exact model store a
real pull produced). Kernels attach it via `datasetDataSources` — camelCase;
the snake_case field name is silently ignored by the push API (measured) —
and boot from the read-only mount: local extract, symlinks for the 15.3 GB
blobs, manifests copied and de-nested (Kaggle extracts tars one directory
deeper — caught live by the diagnostic). Every cache step falls through to
the old download path on any failure, and the final word is `ollama list`,
not the disk check.

RESULT (all four, beacon): **LIVE at +34 to +38s** (was +151 to +416s);
model-ready +29s (was +141 to +408s). VRAM warm still takes ~180–240s but
runs in the background behind the warm gate (earlier fix) — LIVE means
reachable, `/api/ready` means answerable, and they are never conflated.

ALREADY-WARM PATH: `resolveEngine` against a live fleet returned
`status=alive` with URL in **1511ms** (beacon read + /api/ps probe), no
push. An engine that is warm is used immediately; the cold path only starts
when nothing is alive.

## MAXIMUM STABLE DECODE

**14.1–15.4 tok/s is the ceiling of this model on this silicon, and it is
the silicon.**

- GPU: 2× Tesla T4 (15360 MiB, 320 GB/s GDDR6 each) — `nvidia-smi` on the
  live engine.
- Model: Qwen3.8-27B IQ4_XS, 15.05 GB fully VRAM-resident (`/api/ps`).
- Matrix on D (`decode-ceiling.py`, Ollama's own eval_duration): decode
  14.09–14.68 tok/s across num_ctx 2048/4096/8192/16384 × num_batch
  256/512-default/2048 × num_predict 128/512 — **4.1% spread, flat**.
- Why flat = memory-bound: each token reads every weight once; 7.53 GB per
  GPU per token ÷ 320 GB/s = 23.5ms → 42.5 tok/s theoretical at 100%
  bandwidth. Measured 14.3 = 33%: i-quant dequant kernels on Turing (sm_75)
  and per-layer PCIe transfers between the two GPUs (the model does not fit
  on one T4: 15.05 GB weights + KV > 15.36 GB usable).
- Settings that do NOT move it (measured flat): num_ctx, num_batch,
  generation length. Settings that would move it: smaller quantization
  (rejected — model quality), different GPUs (not offered by Kaggle).
  Flash attention is prefill-only and llama.cpp's FA needs sm_80+ (T4 is
  sm_75) — not applicable.
- Context kept at 8192: 4096 decodes ~1% faster (noise) but breaks long
  multi-tool turns — not a trade worth making, and the matrix shows there
  is no real speed to buy.

## FASTEST HEALTHY ENGINE

No single winner — honest per-metric (after-bench):
- decode: **A 15.38** ≈ C 15.34 > B 15.20 > D 13.81–14.68
- tool task wall: **C 8.35s** < A 8.92s < D 9.93s < B 15.67s
- first tool event: **C 5.97s** < A 6.30s < B 6.52s < D 6.75s
- health-probe RTT (live, from routing test): **D 90ms** < A 92ms < B 94ms < C 105ms
- TTFT median: B/D 0.52s < C 0.59s < A 0.72s

All four are within ~10% on decode and ~0.2s on TTFT — the fleet is
homogeneous (identical kernels, identical GPU class). AUTO routing therefore
does not chase these differences: it keeps the active engine unless another
healthy one is faster by >150ms of median probe latency, and on failover it
picks the fastest healthy engine (unit-proven: picks a 160ms engine over a
500ms one; skips a degraded engine even when it is fastest; reinstates only
after 4 consecutive successes — 3 do not count).

## STALL DETECTION TIME

**90s to first progress, 45s between chunks, 90s on the final answer, 900s
absolute backstop. Was: one flat 180s wall-clock limit.**

- LIVE proof (real wedge, not a stub): a raw 4000-token `/api/generate`
  orphaned by Cloudflare's 524 held Ollama's single worker; the chat turn
  behind it was detected at **90.3s** (beacon: `MODEL STALL: 90s silent
  (limit 90s, 90s into the call)`), terminal message delivered, engine
  recovered on its own 1.8s after the wedge cleared. Was 180.5s — 2× faster.
- Counter-proof (why not faster): the limits sit above the measured worst
  legitimate cases — first token 51.9s (cold reasoning turn), cold prefill
  23.1s, worst inter-chunk gap 9.7s. A **303.9s healthy generation survived
  untouched** (the old wall-clock limit would have killed it at 180s mid-
  sentence — the old watchdog was wrong in both directions: too slow on
  dead engines, and it would have executed healthy long answers).
- The final answer call previously had NO watchdog — a dead engine froze the
  user's stream for curl's full 1200s timeout. It now dies at 90s of
  silence with an explicit stall message.
- UI honesty during a stall: 5s heartbeats (⏳) keep the client informed;
  18 heartbeats were streamed during the 90s detection.

---

## WAKE UX (checklist, verified in code and live)

- Instant feedback: web button flips to "Waking…" on click (`setWakingSlot`);
  Android flips its row and switches to 4s fast-poll.
- Real stage: toasts carry the server's stage-derived `reason` ("Booting:
  <stage> ~N min left"); Android announces real phases.
- ETA only when measurable: the fabricated "about 10 minutes" toast is gone;
  ETA comes from the stage-aware map, omitted when unmeasurable.
- No fake progress: no progress bars anywhere; pulse = state, not progress.
- No unnecessary polling: web polls only while the engine panel is open (4s,
  server-side caches 4–5s); Android 15s idle / 4s transitional.
- Ready engine used immediately: measured 1511ms resolve→alive, no push.
- Clear failure: error status → explicit toast; watch-window expiry says
  "It is not LIVE" rather than leaving "waking" forever.
- Fixed en passant: "three Kaggle GPUs" → four; 4-slot grid.

## APK

`apk/aether-2.6.0-release.apk` — **versionCode 45, 802,664 B**. Verified in
the shipped bytes: template inside the APK is byte-identical to the
workspace asset (sha256 `3148a10d…`), contains the cache-boot cells,
`_FIRST_PROGRESS_LIMIT`, `_fwatch`, `_warm_worker`; `aapt` confirms
2.6.0/45. First build attempt OOM-killed the Gradle daemon (1984 MB box);
retry after freeing memory succeeded in 72s. Post-build regression:
**vitest 352 passed / 0 failed / 5 skipped · tsc 0 · jvm-suite 19/19 ·
verify-engine-source PASS**. (Not installed on hardware: no emulator is
possible in this sandbox — unchanged limitation.)

## REMAINING LIMITATIONS (measured, not hand-waved)

1. **Kaggle's GPU queue is now the dominant cold-wake cost**: 60–540s from
   push to "stage: starting", outside our control. Kernel-side boot is
   34–38s.
2. VRAM warm after boot still takes ~180–240s; until then `/api/chat` is
   held with honest heartbeats (`/api/ready` says ready:false). A warm
   engine answers immediately.
3. Decode ceiling 14–15 tok/s: silicon (2×T4). No setting changes it; only
   a smaller quant would, at the cost of quality (rejected).
4. Stall floor is 90s to first token — going lower would risk killing the
   measured-legitimate 51.9s cold-reasoning first token.
5. Cache datasets (~15.2 GB/account) must be rebuilt when the model or the
   Ollama version changes (`push-cache-builder.py`, ~10 min/account).
6. Cloudflare quick tunnels still occasionally rotate or die (measured this
   morning); `isDegraded`/latency routing works around it, the kernel
   cannot fix it.
7. The APK has never been installed on a device (no /dev/kvm, no LAN to a
   handset). All device-side claims remain proof-level + shipped-bytes
   verification.

## Gate at close

vitest **352/0/5-skip** · tsc **0** · jvm-suite **19/19** ·
verify-engine-source **PASS** · template blob `7ead9c01…` (218,270 B
rendered), shipped byte-identical in APK 2.6.0/45.
Commits: `5aa4c3b` (cache wake + watchdog + routing + UX), `00be391`
(evidence), `22befc9` (rollback restore). Two sandbox git-history rollbacks
were detected and re-committed this session; the working tree was verified
against the gate after each.
