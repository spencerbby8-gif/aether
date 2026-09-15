# RUNTIME GAPS — the six-item audit, closed with live evidence

Date: 2026-09-15. Every number below was measured against real Kaggle engines
during this session; the harness logs referenced are committed under
`scripts/proofs/output/` and `scripts/perf/output/`. Nothing here is inferred
from unit tests alone.

---

## 1. WAKE SPEED

**FOUND.** A cold wake took ~347s, and the last 115s of that — loading 15 GB
of weights into VRAM — ran *before* the tunnel started, so the engine was
fully functional (Ollama serving, model on disk) and completely unreachable
while the client watched "waking" with nothing to poll.

**ROOT CAUSE.** In kernel cell 4 the warmup loop ran to completion before the
HTTP server and cloudflared tunnel were started. Separately, client-side ETAs
were fixed numbers that ignored which boot stage the engine was actually in.

**FIX.** (`bc66d24`, patcher `scripts/wake-speed-fix.py`, 6 content-addressed
edits, byte-exact round trip.) Warmup moved to a `_warm_worker` thread; the
tunnel comes up immediately after model-ready. New `GET /api/ready` reports
`{ready, stage, failed, seconds_since_boot}`. `/api/chat` arriving before
warm is *held*, not failed, with a heartbeat every 10s (300s cap, then an
honest 503-style terminal message). Stage-aware ETAs (`STAGE_ETA_MINUTES`).
An already-alive engine short-circuits: no push at all.

**BEFORE.** v21 profile: `WARM OK` +331s → `AGENT LIVE LINK` +337s → health
READY +347s. No readiness endpoint; nothing to poll during the VRAM load.

**AFTER.** v22 profile (`scripts/perf/output/wake-d.txt`): model-ready +433s
→ "warming in the background — bringing the tunnel up now" +434s → **`AGENT
LIVE LINK` +439s (Δ5s after model-ready instead of +120s)** → health READY
+520s. `GET /api/ready` answers in 0.446s; already-alive wake path 0.493s
with no push; a chat through the warm gate completed in 8.4s once warm.

**LIVE TEST.** Beacon forensics on v22 and, independently, engine C v48:
`model-ready` +883s → LIVE +889s — the reorder reproduced on a second
account. This session's wakes: D v29 live ~275s, v30 ~300s, v31 ~300s,
B v69 ~270s, C v50 ~400s, A v73 ~400s (announcement time; readiness 60–120s
later, verified via `/api/ready` before use). The warm gate was raced
directly: a chat sent at `seconds_since_boot: 33` received 10 heartbeats
("engine is starting — loading weights into VRAM") and proceeded when warm.

**REMAINING LIMITATION.** Total cold wake is still 4–9 minutes, dominated by
Kaggle kernel boot, the ~168s GitHub download of Ollama and the ~237s pull of
the 16.9 GB model — stages that cannot be shortened from the client side.
The already-alive fast path only triggers when a beacon-announced URL is
confirmed healthy first; a dead-but-announced URL costs one health probe
(~0.3s) before falling back to a push.

---

## 2. LIVE FAILOVER PROOF

**FOUND.** The prior failover proof (14/14) only proved files move between
engines — a run that transferred files and then restarted the job from step
one would have passed it. Worse: the new continuity harness's first three
live runs *reported passes while proving nothing* — the continuity
assertions compared an empty set with an empty set.

**ROOT CAUSE.** All in the harness; the engines behaved correctly
throughout. (a) It started turns against engines still loading VRAM; the
warm gate held the turn, the kill landed during the hold, the first turn
produced 0 tool calls and 0 files, and the export was a genuine 22-byte
empty zip. (b) The restore check only looked for the word "files" in the
reply — it passed while the reply said `files: 0`. (c) `io`/`zipfile` were
imported inside a conditional, so a failed export raised `NameError` at the
later zip read and a bare `except` reported it as an empty workspace. (d)
The re-execution check matched a *filename anywhere in the tool list*, so a
perfect survivor that ran `ls`/`cat` to inspect the restored state was
flagged as re-doing work.

**FIX.** (`d9331b6`, re-committed `bc66d24` after a sandbox history
rollback.) Wait for `/api/ready` on both engines and abort without it;
assert restore file count == exported count; abort with an explicit message
when nothing was in flight at the kill, so the subset check can never be
vacuous again; the re-execution check now looks for the step's actual write
command (`echo 'stepN done' > stepN.txt`); imports module-level; zip read
errors reported, never swallowed.

**BEFORE.** "13 passed, 3 failed" on a run where the workspace was empty at
both ends — continuity "proven" from nothing.

**AFTER.** The harness cannot pass on an empty set (guard verified by direct
test: empty `done_before` → guard fires; non-empty → silent).

**LIVE TEST.** (`failover-continuity-live.py`, engine D → engine B, log
inline in commit `d9331b6`): **19/19, exit 0.** D ran 5 numbered steps +
`list_files` (47.5s, 6 tool calls); workspace exported live (557 B, 5
files); D killed with `POST /off`; D confirmed dead and unreachable; the
5-file snapshot restored into B (`restore reply: files: 5`); B inspected the
trail (`ls`/`cat`), re-wrote **no** finished step, and reached `TRAIL
COMPLETE 5`. Additionally, engine B's tunnel degradation was measured live
(22–30 ok / 9 fail over 90–120s windows) and fed through
`noteOutcome`/`isDegraded`: at 3 failures in the rolling 8-sample window
(>25%) `isDegraded("c")→true` and `pickEngine()` returned `d`;
`clearOutcomes` un-degraded it.

**REMAINING LIMITATION.** The snapshot→restore→continue flow here is driven
by the harness, standing in for the client. The production Android
`EngineRouter` path performs the same steps but was not exercised end-to-end
(no physical device or emulator available — see §5).

---

## 3. LIVE STALL RECOVERY

**FOUND.** The 180s no-progress watchdog existed in the shipped engine but
had only ever fired against a *simulated* blocked thread — never against a
real hung upstream request.

**ROOT CAUSE (of the stall itself).** Ollama serves one request at a time.
A raw `/api/generate` with `num_predict=4000` decodes for minutes; Cloudflare
cuts the client with a 524 after ~100s, so the client is gone while the
generation still holds the engine's only worker — every later request queues
behind a job nobody is listening to. This is a real failure mode, reproduced
deliberately, not a stub.

**FIX.** No product change was needed — the watchdog (heartbeat loop +
`_STALL_LIMIT=180s` + `q.get(timeout=30)`) was already in place from the
audit pass; what was missing was proof against a real stall, and one product
behavior was confirmed: the engine reports the stall to the beacon
(`MODEL STALL: no response after 180s, abandoning the call`) and gives the
client a *terminal* message instead of hanging.

**BEFORE.** Watchdog recovery demonstrated only against a blocked thread
(3.0s, audit era). Real-engine behavior unknown.

**AFTER.** Against a genuinely wedged upstream: turn bounded at 180.5s,
18 hourglass heartbeats streamed while waiting, terminal message
`(engine stall: the model produced nothing for 180 seconds)`, beacon
notified — three separate live firings recorded.

**LIVE TEST.** Engine D, this session: baseline turn 2.2s → wedge fired
(`/api/generate`, 4000 tokens; client 524 at 125.4s; worker still busy) →
real chat turn behind it: watchdog fired at 180.5s (< 300s cap), reported
truthfully → after the wedged generation finished, the same engine
recovered without any restart: 65.9s (context reload) → 1.3s → 1.1s →
while D was still wedged, healthy engine B answered the identical prompt in
5.6s (engine switching as the mitigation). An organic fourth firing occurred
during gap 6: a continuation turn stalled for real and the watchdog ended it
cleanly.

**REMAINING LIMITATION.** The watchdog abandons the *call* but cannot kill
the wedged Ollama generation itself (the kernel's `curl` reader is killed;
the server-side decode runs to completion, minutes). During that window the
engine is degraded, not dead: switching engines is the only real mitigation,
which is why `isDegraded`/`pickEngine` exist. Detection floor is 180s — a
stall shorter than that consumes the wait.

---

## 4. ENGINE SPEED

**FOUND.** `scripts/perf/engine-bench.py` — the component-separated
benchmark — had never actually been run. Prior speed claims rested on
one-off probes, and "15–17 tok/s is fast enough" had never been shown as
sustained results on all four engines.

**ROOT CAUSE.** Measurement gap, plus one measurement artifact identified
while fixing it: the benchmark's own ctx sweep (16384/4096/2048) leaves
Ollama at a different `num_ctx` than chat's 8192, and Ollama reloads the
model on any `num_ctx` change — that is the 17–18s rep-1 TTFT seen on every
engine, not engine variance.

**FIX.** All four engines woken simultaneously (A v74, B v69, C v51, D v30)
and run through the identical benchmark, 3 reps, results committed as
`scripts/perf/output/bench-{A,B,C,D}.{txt,json}` (commit `67ffe7c`).

**BEFORE / AFTER** (there is no "fix" to the engines here — these are the
measured numbers the claim now rests on; model fully resident, 15.05 GB
VRAM each):

| metric | A | B | C | D |
|---|---|---|---|---|
| decode tok/s (ctx 16k/4k/2k) | 14.95/14.85/14.44 | 14.52/14.72/14.98 | 15.28/15.21/15.14 | 14.95/14.79/14.61 |
| prefill tok/s | 225.1 | 219.3 | 238.7 | 228.2 |
| chat TTFT median (warm) | 0.80s | 0.64s | 0.61s | 0.51s |
| chat TTFT rep 1 (ctx-change reload) | 18.07s | 17.85s | 17.08s | 17.82s |
| stream throughput | 72 ch/s | 69 ch/s | 74 ch/s | 72 ch/s |
| first tool event | 6.57s | 7.91s | 7.27s | 6.50s |
| tool task wall | 9.42s | 14.55s | 8.95s | 12.57s |
| web_search task | 18.2s | 11.5s | 13.0s | 14.0s |
| browser task (real Chromium) | 26.2s | 17.5s | 13.3s | 20.3s |
| health round trip med | 0.227s | 0.167s | 0.533s | 0.171s |
| beacon round trip | 0.301s | 0.302s | 0.299s | 0.794s |

**LIVE TEST.** The table above *is* the live test — every row from real
requests against four simultaneously live engines on the current build
(template blob `28d70024…`). Bottlenecks, stated plainly: decode is
VRAM-bandwidth-bound (27B IQ4_XS, 2 GPUs, ~15 tok/s ceiling regardless of
engine); TTFT is prompt-eval + first-token queueing and is warm-fast
(0.5–0.8s) except after a `num_ctx` change (~10–20s reload); tool latency
is orchestration + decode of the tool call (~6.5–8s), not the tool;
tunnel variance is Cloudflare quick-tunnel behavior (engine C's tunnels
died/flapped repeatedly this session — DNS 530s measured — which is an
infrastructure property, not engine code).

**REMAINING LIMITATION.** No engine exceeds ~15.3 tok/s decode; "fast
enough" is a judgment the user must make against these numbers — a 600-char
answer takes ~9.5s wall, a 25-step agent task takes minutes. Faster decode
requires a smaller quant or more GPUs; `num_ctx=8192` was deliberately kept
(4096 decodes ~5% faster but breaks long multi-tool turns). Tunnel flakiness
cannot be fixed from the kernel; `isDegraded` avoidance is the mitigation.

---

## 5. APK

**FOUND.** The shipped APK (2.4.0 / versionCode 43) predated every engine
fix in this run — wake reorder, `/api/ready`, warm gate, circuit breakers.
Installing it would have woken engines the slow way.

**ROOT CAUSE.** The APK had not been rebuilt since commit `70111ad`. The
first rebuild attempt in this session then OOM-killed the Gradle daemon at
28 minutes on the 1984 MB sandbox (a known failure mode of this box); it
also froze the sandbox until the OOM killer reclaimed memory.

**FIX.** Version bumped to **2.5.0 / versionCode 44**; rebuild run alone
after freeing memory (65s); shipped bytes verified against the workspace
rather than assumed.

**BEFORE.** `aether-2.4.0-release.apk` 796,724 B — template without
`_warm_worker`, without `/api/ready`, without the loop breakers.

**AFTER.** `apk/aether-2.5.0-release.apk` **800,344 B**, commit `a670be4`.

**LIVE TEST.** Extracted from the built APK:
`assets/aether-notebook-template.json` sha256 `38333066f54b…` —
**byte-identical** to the workspace asset (209,965 B); cell 4 contains
`_warm_worker`, `/api/ready`, `_MAX_CONSEC_FAIL`, `_MAX_SILENT_STEPS` and
the background-warm tunnel path. `aapt dump badging`:
`package: name='com.aether.app' versionCode='44' versionName='2.5.0'`.
Post-build regression, run *after* the build as directed: **vitest 342
passed / 0 failed / 5 skipped (40 files)** · **tsc 0 errors** ·
**jvm-suite 19/19 proofs clean** · `verify-engine-source.mjs` PASS (no
secrets, every POST gated, no wildcard CORS).

**REMAINING LIMITATION.** The APK has never been installed on a device: the
sandbox has no `/dev/kvm` (no emulator, ever) and wireless ADB requires the
phone and this machine to share a LAN/VPN, which is impossible from here.
Everything device-side remains proven at the JVM/proof level plus the
shipped-bytes verification above — not on hardware.

---## 6. REAL TASK COMPLETION

**FOUND.** The first live attempt scored 12/13: the task's *work* completed
(4 files, summary citing all three countries, served archive) but the model
burned the 24-call budget on 11 `fetch_page` calls and the turn ended
mid-thought without the completion line. The first kill attempt then exposed
two more real defects: sent the raw task, the survivor treated it as new
work, re-searched everything, wrote nothing, and was ended by the 180s stall
watchdog; and the artifact check passed on a **stale** `energy-pack.zip`
left in the shared `GEN_DIR` by an earlier session.

**ROOT CAUSE.** (a) An under-constrained prompt — the engine follows
instructions, and the instructions left fetching unbounded. (b) Continuity
requires the continuation prompt to state what is already finished; the
workspace alone does not tell the model the task is half-done. (c) `GEN_DIR`
is engine-global, not session-scoped, so a same-named artifact from a
previous run is indistinguishable by URL alone.

**FIX.** (`92bde76`, `scripts/proofs/real-task-live.py`.) Task bounds
fetching per country and names the archive; continuation prompt lists the
already-finished files; the watchdog only kills once the workspace snapshot
holds real files; and the artifact check now requires the archive's member
bytes to **equal this session's workspace bytes** — a stale archive fails
(unit-tested both directions in the commit).

**BEFORE.** 12/13 clean run (no completion line); 14/19 first kill run
(stale artifact accepted, continuation never finished).

**AFTER.** Phase 1: **13/13, exit 0.** Phase 2 with mid-run kill:
**20/20, exit 0.**

**LIVE TEST.** (Logs: `scripts/proofs/output/real-task-phase1-13of13.log`,
`…kill-20of20.log`.) *Phase 1, engine A:* 303s, 8 tool calls — 3×
`web_search`, `fetch_page`, 3× `run_command`, `package_files`; all 4 files
present and non-empty; `summary.md` cites Nigeria, Kenya and Morocco;
artifact fetched for real at `/files/energy-pack.zip` (2,741 B, 4 members);
ended with exactly `RESEARCH COMPLETE energy-pack.zip`. *Phase 2:* the same
task started on engine D; a watchdog fired `POST /off` the moment the
workspace held real files — after tool 7, `['kenya.txt', 'morocco.txt',
'nigeria.txt']` — **while the turn was still streaming**; D confirmed dead;
the snapshot was restored into A (`files: 3`); A ran `list_files`, read the
restored files, re-wrote none of them (all three **byte-identical**
afterwards), completed `summary.md` and `package_files` — artifact 3,520 B,
members byte-matched to this run's files — and ended with the exact
completion line. 402s continuation turn, 24 tool calls.

**REMAINING LIMITATION.** The kill/restore orchestration is driven by the
proof harness (the production Android client performs the same
snapshot→restore→continue steps through `EngineRouter`, unexercised on
hardware — see §5). The model still wastes calls (the continuation hit the
24-call ceiling with redundant re-searching before finishing); the circuit
breakers bound the damage but do not make the model efficient. Task scope is
research+packaging; it does not include the browser tool or multi-turn user
interaction.

---

## Gate status at close

`npx vitest run` → **342 passed, 0 failed, 5 skipped** · `npx tsc --noEmit`
→ **0** · `scripts/proofs/jvm-suite.sh` → **19/19** ·
`node scripts/verify-engine-source.mjs` → **PASS** · template blob
`28d7002410c1166d…`, rendered 209,801 B, asset 209,965 B — the same bytes
shipped inside `aether-2.5.0-release.apk`.

Commits: `67ffe7c` (gap 4 bench) · `bc66d24` + `98a9f4b` (wake fix
re-commit) · `d9331b6` content (gap 2 harness, inside `bc66d24`) ·
`a670be4` (APK 2.5.0) · `92bde76` (gap 6 harness + logs).
