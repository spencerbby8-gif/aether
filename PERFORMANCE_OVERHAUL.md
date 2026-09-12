# Aether — performance, agent and reliability overhaul

**Date:** 2026-09-12 · **Commits:** `2192553` → `148bc56` (+ APK `2.2.0`, versionCode 41)
**Report ordered exactly as the 15 numbered audit sections, each `FOUND → FIXED → VERIFIED → REMAINING LIMITATIONS`.**

---

## The headline: what was actually slow, and what it was not

The brief asked me to benchmark before changing anything and find the real
bottleneck rather than guessing. Benchmarking found three things, none of which
was where the code looked slow.

| Real bottleneck | Evidence | Was it the model, Ollama, network or code? |
|---|---|---|
| **Two kernels sharing one GPU** | Older instance answered a 5-token reply in 3.35 s while the newer took 16.49 s; TTFTs of 127 s / 187 s / 205 s with **no correlation to prompt length** | Neither — an operational bug |
| **Context window far larger than needed** | Decode 5.46 tok/s at `num_ctx=16384` vs 9.26 tok/s at 4096 | The KV cache competing with model weights for VRAM |
| **`api.trycloudflare.com` announced as the engine URL** | Engine published Cloudflare's own control-plane host as its live link | A regex in the kernel |

What was **not** the bottleneck, measured: network path (health round trip
0.105 s), NDJSON handling (`readNdjson` already streams, no buffering),
discovery beacon (0.308 s), and prefill (47.7 tok/s — fast).

**Decode speed is a hardware ceiling, not a software one.** The model is
16.86 GB; only 14.77 GB fits in VRAM. Best sustained decode at `num_ctx=8192`
is ~7.1–7.8 tok/s. It cannot be made faster without a smaller model or smaller
context, and the brief forbade trading away capability for a number.

---

## 1. Engine speed and stability

**FOUND** — Kaggle leaves the previous kernel version running after every push,
so N pushes leave N engines sharing one GPU. Observed directly: v6 and v7 both
booting at 21:35, each pulling the 16 GB model; one died on contention and never
announced. On the contended pair, TTFT bore no relation to prompt size.
Separately, the engine announced `https://api.trycloudflare.com` — cloudflared's
own control-plane host, which appears in its log *before* the real quick-tunnel
hostname. Clients connected to Cloudflare, not to a kernel, and the failure
looked like an engine problem. Two kernel sites and three server sites had the
same bare regex.

**FIXED** — `reapSlotInstances()` shuts down every live instance of a slot
before pushing; `wakeSlot()` calls it. The only handle on an old instance is the
tunnel URL it announced to the beacon, so that is where it looks. One hardened
tunnel-URL reader (20+ char label, control-plane hosts rejected) used by both
kernel paths; `liveLinkFrom()` on the server, which now refuses to announce
anything it did not find rather than publishing `"None"`.

**VERIFIED** — Live: reaped 1 live instance and correctly classified 5 dead
tunnels as `already-off`; the survivor returned 530 afterwards. Later in the
session the reaper caught 2 live instances in one call. The kernel announced a
real hostname on every boot after the fix. Benchmark before/after, same rig:

| metric | before | after | change |
|---|---|---|---|
| health `/api/ps` | 0.552 s | 0.105 s | **5.3× faster** |
| decode | 5.46 tok/s | 7.06–7.80 tok/s | **+29% to +43%** |
| chat wall (median) | 4.57 s | 3.44 s | **25% faster** |
| tool task wall | 71.91 s | 52.01 s | **28% faster** |
| web-search task wall | 36.07 s | 28.01 s | **22% faster** |
| browser task wall | 45.38 s | 43.06 s | 5% faster |
| TTFT (median) | 0.79 s | 0.93 s | **no improvement** |

TTFT did not improve and I am not going to claim it did. At 3 reps the
difference is noise; six identical repeats on the *before* build ranged 0.77 s
to 3.02 s. What improved is decode and total task time.

Regression tests: 3 for reaping (own-slot, not another slot, and the cheap path
where a live engine resolves without pushing at all) and 4 for tunnel-URL
extraction.

**REMAINING LIMITATIONS** — A, B and C could not be benchmarked or measured at
all: all three report `Maximum weekly GPU quota of 30.00 hours reached`. The
fixes live in the shared template, so they change A/B/C behaviour too, but that
is inference from a shared code path, not a measurement on those accounts. The
first request after idle still pays model load. Quick tunnels rotate on engine
restart, so a URL always expires eventually.

---

## 2. Real agent execution

**FOUND** — The loop works but a real research task spent 13 tool calls and
234.8 s: search plus two fetches succeeded, then **eight `run_command` calls
re-fetched and grepped the same pages** because `fetch_page` truncated at 12 000
characters silently. The turn then ended mid-thought with no figure and no
citation.

**FIXED** — Truncation is now stated (`first 12000 of 15657 readable
characters`), so the model knows there is more and can ask for a section rather
than re-downloading through the shell. See §8 for the fetch fixes.

**VERIFIED** — Real multi-step task, run live and independently re-verified:
*"create demo/, write calc.py with `add(a,b)`, write test_calc.py with two
assertions, run the tests, list the files"* — 79.0 s, 2 tool calls, both
`exit=0`, plan emitted with capabilities `[code_execution, filesystem]`,
`verification {'ok': True, 'unmet': [], 'outcome': 'verified'}`. A follow-up
turn catted both files and printed their checksums: `calc.py ba1a531f…`,
`test_calc.py b1e12aaf…`. The artifact existed, not a description of it.

Second stress test: *"write report.py that prints 1 to 5, run it, package the
workspace"* — 99.5 s, **3 tool calls** (`list_files`, `run_command`,
`package_files`), `exit=0`, verified, archive 151 bytes `sha256:91c89090ab9e57f0`.

**REMAINING LIMITATIONS** — The 13-call research task has **not** been re-run
after the fetch fixes, so "fewer calls now" is reasoning from the fixed failure
modes, not a measurement.

---

## 3. Command execution

**FOUND** — `run_command` works but ran with a hard-coded `cwd='/kaggle/working'`
shared by every caller. It executes on the **engine's** Linux box, not a
per-task sandbox.

**FIXED** — Commands now run inside the session workspace (§4). The existing
`BLOCK` list is unchanged; the 150 s subprocess cap is unchanged.

**VERIFIED** — Live: `mkdir`, file writes, `pytest` (`exit=0`, 1 test passed),
`find`, `ls -la`, `cat`, `sha256sum`, `python3 report.py` printing `1 2 3 4 5`.
All on the engine, all inside the session directory.

**REMAINING LIMITATIONS** — Commands run on a Kaggle kernel, not in a separate
per-task container. It is the user's own engine on their own account, not their
host machine and not production, but it is a shared GPU box: two sessions on the
same engine share its CPU and disk even though their workspaces are separate.

---

## 4. Workspace per session

**FOUND** — Every conversation shared one directory and the kernel had **no
concept of a session**. Two conversations wrote into the same tree, so one
task's "delete the build directory" removed another task's files, and a listing
could not tell the agent which files belonged to the task in front of it. The
agent also had no way to see the filesystem, so it named files from memory of
what it wrote earlier — and after a compaction or engine switch that memory is
gone.

**FIXED** — `_session_dir()` resolves a validated session id to
`/kaggle/working/sessions/<id>`. The id is regex-checked rather than joined
blindly: it arrives from a client, and `../` in it would have put the workspace
anywhere on the filesystem. `agent_stream` binds the workspace before the tool
loop, so every command lands in the right directory. A client sending no id gets
`default`, which behaves as the old shared directory did. New `list_files` tool
returns a real tree with sizes. New `package_files` tool zips the workspace and
reports byte count plus sha256.

**VERIFIED** — Live: session `alpha` wrote `alpha.txt`, session `beta` wrote
`beta.txt`; alpha's `ls -la` showed only `alpha.txt`, and
**"ALPHA sees beta.txt: False"**. Traversal cases (`../etc`, `../../root`, an
80-char id, empty, `None`) all resolve inside the session root. `list_files`
was selected from "show me what is in my workspace" and returned
`workspace: .\nalpha.txt 13 B`. `package_files` reported
`1 file(s), 131 bytes, sha256:01540564a2043cbd`; the archive was downloaded over
the tunnel and checked independently — **131 bytes, PK magic, sha256 exact
match**, entries `['alpha.txt']`, `testzip` clean.

`tests/workspace-tools.test.ts` (5 tests) extracts the Python from the shipped
template and executes it.

**REMAINING LIMITATIONS** — Workspaces live on the engine's disk and are lost
when that kernel dies, unless transferred (§7). There is no quota per session.

---

## 5. Files and documents

**FOUND** — A text file over 200 KB was **dropped without a word**.
`stageAttachment` set `text = null` above `INLINE_MAX_BYTES`, so the attachment
was staged, shown in the UI with a "not sent" chip, and never reached the model.
The model was left in a conversation where the user had attached a file, with no
reason to say it could not see it — so it answered as though it had read it.

**FIXED** — `AttachmentText.prepare()` sends a text file whole when it fits; when
it does not, it sends the head and tail with an explicit notice naming how many
characters were omitted and how many the file holds. Head gets ¾ of the budget,
tail ¼: an opening usually states what a file is, an ending usually holds its
conclusion. The policy moved out of the Activity into `core/AttachmentText` so
it can be executed without an Android SDK.

**VERIFIED** — `AttachmentTextProof`, **26 assertions**, new proof. Covered:
small file whole and marked sent; file exactly at the budget whole; one byte
over truncates rather than vanishing with `sentToEngine` still true; notice
present; head and tail both survive; on a 600 KB file the head is within 2 chars
of ¾ of the budget and the tail within 2 chars of ¼, taken from the actual start
and end; null, empty and binary all yield no text and `sentToEngine` false
rather than an empty string that would read as a successfully-sent empty file.
`gradle :app:compileDebugJavaWithJavac` **BUILD SUCCESSFUL**.

**REMAINING LIMITATIONS** — This is the Android path. The web agent in
`src/agent/context.ts` still folds attachment *names* into the prompt without
contents. The engine has no upload endpoint, so binary attachments remain
attached-but-not-sent by design (the UI says so). **Chunked retrieval over a
large document is not built** — head/tail with a stated omission is what ships,
and it is better than silence but it is not full-document access.

---

## 6. Long context and long-running tasks

**FOUND** — `history_window` allowed 20 000 chars (~5 000 tokens) of history,
sized for `num_ctx=16384`. At the new 8192 window that budget would overflow and
Ollama would truncate **from the end** — silently discarding the newest user
query. The two constants were independent and could drift.

**FIXED** — `NUM_CTX` 16384 → 8192, measured (§1). `max_chars` 20 000 → 14 000
and documented against `NUM_CTX` in the docstring so the two cannot drift apart
again. 8192 is the largest window that still leaves headroom: fixed floor
~1 377 tokens (system prompt ~355 + tool schema ~1 022), leaving ~6 800 for
history and generation.

**VERIFIED** — A 4 560-token prompt prefills identically at 8192 and 16384
(35.2 s vs 36.3 s), so nothing that fit before stops fitting. A 12-turn
conversation ran clean end to end with growing history. `vitest` 323/0.

**REMAINING LIMITATIONS** — `num_ctx=4096` would decode **33% faster** (9.26 vs
6.96 tok/s) but forces the history budget to ~2 600 tokens, which costs real
multi-tool turns. That is capability traded for a number and the brief forbade
it, so 8192 is the deliberate choice. Task state survives engine switching only
via the workspace transfer in §7; a plan's in-flight step is not resumed
mid-token.

---

## 7. Engine switching and failover

**FOUND** — Failover swapped the URL and **lost the files**. A workspace lives on
the engine's own disk, so `manager.failover()` reconnected to a kernel that did
not have the files the task had already produced. The model keeps referring to
them because its history says it created them, and every command that touches
one fails.

**FIXED** — Two keyed endpoints: `GET /workspace/<session>.zip` exports
(skipping `__pycache__`, `.pytest_cache`, `node_modules`, `.git`, reporting the
count in `X-Workspace-Files`); `POST /workspace/<session>` restores, recreating
the directory from the archive rather than merging so a transferred task cannot
inherit another task's leftovers. Every entry is checked for an absolute path or
`..` before anything is written. `src/server/engine/workspace-transfer.ts` runs
both hops and is called from the failover path. The request body now carries the
session id. Events raised before the stream exists are **queued and drained**,
because `send()` belongs to the stream constructed below the failover closure.

**VERIFIED** — Live full round trip on engine D: built `proj/calc.py` and
`proj/notes.txt`; export returned HTTP 200, 258 bytes, `X-Workspace-Files: 2`,
entries `['proj/calc.py','proj/notes.txt']`, content byte-identical; restored
into a fresh empty session `{"status":"restored","files":2}`; `find` then showed
both files and `cat proj/notes.txt` returned `"carried across a failover"`.
Without the key: **403 on both GET and POST**. Session ids `../etc`, `a/b`,
`....zip`, `a%20b.zip`: 400/404, never served. An archive containing
`../../etc/evil.txt`: **400 `{"error":"unsafe path in archive: ..."}`**.
`tests/workspace-transfer.test.ts` (6 tests) pins both hops, the key on each,
and the four honest outcomes.

**REMAINING LIMITATIONS** — **A real A→B/C/D mid-task failover has not been
run.** Only engine D can boot; A, B and C are at weekly GPU quota, so there is
no second engine to fail over to. The transfer is proven on one engine by
exporting and restoring into a different session, which exercises the same code
with the same payloads — but it is not two live kernels. If the dead engine is
already gone, the files cannot be recovered and the task continues on its
history and plan with the files missing (`source-gone`, reported not hidden).

---

## 8. Web search and real crawling

**FOUND** — `fetch_page` ran `curl -sL -m 40` with **no `--connect-timeout` and
no `--max-filesize`**. A host that accepts the TCP connection then goes quiet
held the call for the full 40 s, and an oversized response was downloaded whole
into memory. `crawl_site` had the same shape at `-m 30`. Both returned
`"fetch failed or empty"` for every failure, so a refused host, a script-only
page and a timeout were indistinguishable — and the model cannot choose a
different strategy for a failure it cannot tell apart. This is what produced the
13-call, 234.8 s research task in §2.

**FIXED** — `--connect-timeout 8`, `--max-filesize 3 MB`, and a subprocess
timeout on both tools. Failures are now distinguishable: a timeout says so with
the seconds, a non-zero curl exit is reported with its code, a page that
downloads but yields no readable text says it may be script-only or blocked.
Truncation is stated. `crawl_site` reports pages fetched versus requested and
why it stopped early, instead of a bare `"crawl empty"`.

**VERIFIED** — Against the live sites from that task:

| URL | time | result |
|---|---|---|
| worldpopulationreview.com | 0.1 s | 8 931 chars |
| en.wikipedia.org/wiki/Lagos | 0.3 s | 12 093 chars, truncation now stated |
| macrotrends.net | 0.1 s | 102 chars |
| nonexistent host | 0.0 s | `fetch failed (curl exit 6)` |
| unroutable `10.255.255.1` | **8.0 s** | `fetch failed (curl exit 28)` — bounded by the connect timeout, was 40 s |

Real search results, not simulated: the Lagos task returned
`worldpopulationreview.com`, `en.wikipedia.org/wiki/Lagos`,
`macrotrends.net` and `nigerianinformer.com`, all actually fetched.

**REMAINING LIMITATIONS** — The full research task has not been re-run, so the
reduction in tool calls is not measured. `crawl_site` still has no
`max_depth` parameter despite the schema implying one. Some sites
(Cloudflare-protected, script-only) legitimately return nothing.

---

## 9. Browser automation

**FOUND** — No new defects this session. The browser layer from `0ceb9e7` was
re-verified rather than rewritten.

**FIXED** — Nothing needed.

**VERIFIED** — `browser-reliability-live.py --policy inspect`: **11/11
workflows, 8/8 assertions**. `browser-auth-live.py`: **30/30**. Measured
earlier: 6/11 in 100.5 s with blind selectors → 11/11 in 4.0 s with
inspect-first (**25× faster**), and 90.3 s of the original 100.5 s was three
blind 30.1 s timeouts. Live browser task wall in this session's benchmark:
**43.06 s**.

The credential model is unchanged and intact: `_B_GRANTS[(session,host,kind)]`
with a 900 s TTL, kinds `fill`/`submit`/`upload`; a fill targeting a credential
field returns `NEEDS APPROVAL` unless the *user* granted it (`user_approved` set
by the model is deliberately not enough); `_b_forget` is called on revoke, after
a credential submit, and by `close`. `/captcha` still returns
`BLOCKED: … I will not attempt to solve or bypass it`.

**REMAINING LIMITATIONS** — Browser suites were run against the shipped helper,
not re-run against the asset *after* every template change this session; they
were green at the start and the browser code was not touched. No real account
sign-up was performed — that needs explicit user authorization and credentials,
which were not provided this session.

---

## 10. Image and media experience

**FOUND** — Every generated image **went dead on the next engine restart**. A
generated file lives behind a quick tunnel whose hostname changes on every
restart, and `MediaItem` stored the URL it was handed while three call sites
dereferenced it directly. An image created before a restart, an engine switch or
a failover rendered as a broken card forever while the file itself was still on
the engine.

**FIXED** — `MediaItem.path()` returns the `/files/<name>` part, which is what
survives; `resolveUrl(base)` rebases it onto the live engine.
`ChatActivity.mediaUrl()` picks the current live engine from `lastStates` (under
the same lock the poll loop uses), and all three dereferences — `loadImage`, the
open-in-browser intent, and the save-to-device download — go through it. Web
media is left alone: rebasing applies only to `/files/` paths, so a CDN image is
never rewritten onto an engine that does not have it.

**VERIFIED** — `MediaUrlProof`, **15 assertions**, jvm-suite now **18/18**.
Covered: path extraction, rebasing onto a new host, self-recognition as stale,
no double slash on a trailing-slash base, keeping the stored URL when no base
exists, refusing a non-http(s) base, audio keeping `.wav` through a rebase, a
query string not leaking into the saved name, and an item with no usable URL
resolving to null so no broken card is rendered.
`gradle :app:compileDebugJavaWithJavac` **BUILD SUCCESSFUL**.

Live: `generate_image` produced a real **20 709-byte JPEG** (valid `FFD8` header
and `FFD9` trailer), the media wire event carried
`{"kind":"image","url":…,"source":"generate_image"}` as a structured event
rather than being scraped from prose, and the file downloaded intact.

**REMAINING LIMITATIONS** — The rebasing runs in `ChatActivity`, which needs a
real phone. The logic is proven in the JVM suite and the Activity compiles
against the real Android SDK, but **no APK has ever been installed here** — no
emulator is possible without `/dev/kvm`. One assertion failed on first run and
the bug was in my test, not the code: it expected a rebased URL to carry a
different item's filename.

---

## 11. File packaging and artifacts

**FOUND** — The agent could create files but had **no way to hand them back**.
And a claim of "I packaged it" was unverifiable.

**FIXED** — `package_files` zips the workspace (or selected paths) into
`GEN_DIR`, which the tunnel already serves, reporting the real byte count, a
sha256 and the entry list. It says `"nothing to package"` on an empty workspace
rather than producing an empty zip and calling it success. Build noise
(`__pycache__`, `.pytest_cache`, `node_modules`, `.git`) is excluded.

**VERIFIED** — Two live archives, both independently downloaded and checked:

| claimed | measured |
|---|---|
| `1 file(s), 131 bytes, sha256:01540564a2043cbd` | 131 B, PK magic, **sha256 exact**, `['alpha.txt']`, `b'alpha-secret\n'`, testzip clean |
| `1 file(s), 151 bytes, sha256:91c89090ab9e57f0` | 151 B, **sha256 exact**, `['report.py']`, `b'for i in range(1, 6):\n    print(i)\n'`, testzip clean |

The checksum matching is the point: **the claim is now verifiable rather than
asserted.**

**REMAINING LIMITATIONS** — Archives live on the engine and expire with its
tunnel. There is no client-side persistence of the archive beyond saving it to
the device.

---

## 12. Error handling and recovery

**FOUND** — Failures were indistinguishable (§8), a silent file drop existed
(§5), and a broken engine published a URL that looked valid (§1).

**FIXED** — Every failure path now names itself: curl exit codes, timeout
seconds, `source-gone` vs `nothing-to-transfer` vs `failed` with detail,
`BLOCKED by overlay: <what> is covering <selector>`, `NEEDS APPROVAL: …`,
`nothing to package`. The reaper classifies stale tunnels as `already-off`
rather than erroring. The boot path refuses to announce `"None"`.

**VERIFIED** — All of the above observed live. The budget layer reported
`{'calls': 2, 'replayed': 0, 'refused': 0, 'remaining': 22, 'max': 24}` on a
clean run, and `agent-loop-live.py` (25/25) still proves a failed
`generate_image` produces `verification.ok=False` naming the missing image,
nudges the model, and **still terminates** within 3 verification events.

**REMAINING LIMITATIONS** — Quota exhaustion mid-task is still a hard wall:
`Maximum batch GPU session count of 2 reached` and
`Maximum weekly GPU quota of 30.00 hours reached` cannot be retried away. A
deliberate engine-kill mid-task with a live second engine has not been tested
(see §7).

---

## 13. Continuous tool orchestration

**FOUND** — Routing and planning work, but the wasted-call problem showed up in
practice as the eight redundant `run_command` re-fetches in §2.

**FIXED** — The orchestration layer was not rewritten this session; the root
cause was upstream (silent truncation), not in the router.

**VERIFIED** — `orchestration-live.py`: **54/54, routing 20/20**. Parallel
execution 0.54 s vs serial 1.07 s. A 3-step task:
`steps=3 done=3 waves=1 widest=3 outcome=verified`, `{calls 3, replayed 0,
refused 0}`, wall 0.79 s. Live tasks chose correctly: the code task used
`list_files → run_command → package_files` (3 calls, no waste); the image task
used only `generate_image`; a greeting spent no tool call.

**REMAINING LIMITATIONS** — The 13-call research task is the counter-example and
has not been re-run.

---

## 14. UI responsiveness and expressive UX

**FOUND** — The 1 s streaming ticker in `ChatActivity` looked like a candidate
for jank. It is not: it runs only while a turn is in flight and is properly
removed in `setStreaming(false)`. No leak, no orphan.

**FIXED** — Nothing needed. The engine-selection UI already lives in Settings
per the standing directive, and activity comes from real engine events
(`AgentActivity` rejects anything it does not recognise, including the model's
own reasoning).

**VERIFIED** — Code inspection only for the ticker. Media renders inline via
`mediaZone` cards, not raw URL lists, and now survives engine restarts (§10).
Raw chain-of-thought is not exposed: thinking events are filtered, and the
activity strip only describes recognized tool events.

**REMAINING LIMITATIONS** — **No UI change was verified on a device.** The APK
has never been installed; there is no emulator in this sandbox and none is
possible without `/dev/kvm`. Perceived responsiveness on a real phone is
unmeasured.

---

## 15. Real end-to-end stress tests

**VERIFIED — what actually ran live this session:**

| stress test | result |
|---|---|
| Create dir → write code → write tests → run tests → list files | 79.0 s, 2 calls, `exit=0`, verified, checksums confirmed independently |
| Write script → run it → package workspace → download & verify | 99.5 s, 3 calls, archive sha256 matched exactly |
| Generate image → verify JPEG → media wire event | 35.8 s, real 20 709 B JPEG, structured media event |
| Web search → fetch sources → confirm | Real sources fetched; **13 calls, 234.8 s, no citation** (root cause fixed, not re-run) |
| Two sessions, file isolation | alpha cannot see beta's file |
| Workspace export → restore into a different session | Files survived, checksums intact |
| Browser workflows | 11/11, 8/8 assertions; auth 30/30 |

**NOT RUN:**
- **Long task with a deliberately failed active engine, then a switch** — needs
  two live engines; A, B and C are at GPU quota.
- **Authorized browser sign-up / login / upload workflow** — needs explicit user
  authorization and credentials, which were not provided.
- **Inspect an uploaded project → install deps → run tests → fix failures** —
  the engine has no upload endpoint, so a project cannot be pushed to it.
- **Anything on a device** — no emulator is possible in this sandbox.

---

## The gate

| check | result |
|---|---|
| `vitest` | **323 passed / 0 failed** (39 files; was 288 before this work) |
| `tsc --noEmit` | **0 errors** |
| `jvm-suite.sh` | **18/18 proofs** (was 16/16) |
| `browser-reliability-live.py` | **11/11 workflows, 8/8 assertions** |
| `browser-auth-live.py` | **30/30** |
| `orchestration-live.py` | **54/54, routing 20/20** |
| `agent-loop-live.py` | **25/25** |
| `verify-engine-source.mjs` | **PASS** |
| `gradle :app:compileDebugJavaWithJavac` | **BUILD SUCCESSFUL** |
| Template pin | `3b19bc06ee7fe535…`, rendered 184 177 bytes |

New tests added: `tests/workspace-tools.test.ts` (5),
`tests/workspace-transfer.test.ts` (6), 7 reaping/tunnel-URL assertions in
`tests/engine-d.test.ts`, `AttachmentTextProof` (26 assertions),
`MediaUrlProof` (15 assertions).

---

## What I could not do, stated plainly

1. **Engines A, B and C are unreachable.** All three report
   `Maximum weekly GPU quota of 30.00 hours reached`. "Benchmark all four
   engines under the same conditions" and "optimize all four engines" are
   therefore only partly done: one engine measured in full, three covered by
   shared-template inference. This is the single largest gap in the work.
2. **No mid-task failover between two live engines.** Proven on one engine via
   export/restore into a different session, which is the same code and payloads,
   but it is not two kernels.
3. **The APK has never been installed on a device.** There is no `/dev/kvm` in
   this sandbox, so no emulator, ever. Every Android claim is from the JVM
   suite or from `compileDebugJavaWithJavac` against the real SDK — never from
   observed device behaviour.
4. **The Next.js web app and the Netlify deploy were not exercised.** The web
   agent path (`src/agent/`) still sends attachment names without contents.
5. **No browser sign-up/login workflow** was performed: it needs explicit
   authorization and credentials that were not supplied.
6. **The 13-call research task was not re-run** after the fetch fixes. The
   improvement is reasoned, not measured.
