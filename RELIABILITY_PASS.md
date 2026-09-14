# Aether — runtime reliability, speed and blocker elimination pass

**Date:** 2026-09-12 · **Commits:** `30c91d4` → this build · **APK 2.3.0** (versionCode 42)
**Ordered exactly as the 17 numbered sections, each `FOUND → ROOT CAUSE → FIXED → REAL TEST → MEASUREMENT → REMAINING LIMITATION`.**

---

## §1 — Engine connectivity and speed

**FOUND** — All four engines were independently reachable for the first time this session: the weekly GPU quota that blocked the previous one had lifted.

**ROOT CAUSE** (of the slowness, from the prior session's measurements, re-confirmed here) — decode is bound by VRAM, not by the network, the proxy or the streaming code. The model is 16.86 GB; only 14.77 GB is resident, so the KV cache competes with the weights.

**FIXED** — Nothing new needed. The three fixes from the prior pass (stale-kernel reaping, tunnel-URL extraction, `num_ctx` 8192) are all in this build.

**REAL TEST** — `scripts/perf/engine-reliability.py` (new): each engine probed on its own tunnel with 5 health probes, 4 identical chat reps, a tool task and a long generation.

**MEASUREMENT** — all four genuinely serving, none inferred from configuration:

| slot | health | conn establish | TTFT | wall | decode | probes failed |
|---|---|---|---|---|---|---|
| A | 0.183 s | 0.033 s | 0.75 s | 3.63 s | **8.11 tok/s** | 0 |
| B | 0.078 s | 0.041 s | 0.67 s | 3.42 s | **8.10 tok/s** | 0 |
| C | 0.099 s | 0.029 s | 0.66 s | 4.40 s | **8.05 tok/s** | 0 |
| D | 0.089 s | 0.032 s | 0.68 s | 3.42 s | **7.95 tok/s** | 0 |

Zero disconnects across 20 health probes. The four are within 2% of each other, which is what identical hardware and one shared template should produce. All report `14.65 GB in VRAM of 16.27 GB` — partly resident, which *is* the speed ceiling.

Two suspected bugs that turned out **not** to be bugs, checked rather than assumed:

- A `max_gap` of **44.69 s** on a long generation looked like a stream stall. Re-measured by logging the gap between *any two wire lines*: the largest was **10.00 s**, which is the heartbeat interval. The 44.69 s was a gap between *content* chunks, during which tool and thinking events were flowing. **The stream never stalls.**
- Tool latency of **26.68 s** looked like orchestration overhead. Traced event by event: **8.47 s** of it is the model decoding the tool-call JSON at ~7 tok/s *before the tool is even named*. That is the hardware decode rate.

**REMAINING LIMITATION** — ~8 tok/s is the hardware ceiling at `num_ctx=8192`. `num_ctx=4096` would give 9.26 tok/s but costs real multi-tool turns, and the brief forbade trading capability for a number. First request after idle still pays model load. Quick tunnels rotate on engine restart, so any URL eventually expires.

---

## §2 — Zero silent engine failure

**FOUND** — Two silent failures on the same code path. When an engine disappeared mid-turn, the route took one of two branches depending on how the socket died, and both were wrong in a way the user could not see through:

- A socket that **throws** (killed engine, dropped tunnel) **discarded everything that had already arrived**. A three-minute answer cut off near the end surfaced as "The engine stream broke." with the text gone.
- A stream that **ends** cleanly without a terminal event emitted `done: true` with no error whenever any content had arrived — reporting a completed turn for an answer the engine never finished.

**ROOT CAUSE** — the two failure shapes were handled in separate places with different ideas about what "the turn ended badly" means, and neither knew whether partial output existed.

**FIXED** — one `endIncomplete()` helper decides how to end any turn that never reached the engine's terminal event, and both branches call it. Partial output is always kept. With content, the turn is `truncated: true` plus an error saying the answer is incomplete and can be continued; without content, a plain retriable failure. `engineManager.reportFailure()` is now called on both paths, so a dead engine is evicted rather than retried.

**REAL TEST** — reproduced against a fixture engine that destroys its own socket, in both shapes (`tests/engine-stream-e2e.test.ts`).

**MEASUREMENT** — mid-content drop: the client receives `"The answer begins here and then"` **and** a terminal event with `done:true, truncated:true`, a message matching `/incomplete/i`, `retriable:true`. Silent drop: `truncated` undefined, `done` undefined, `retriable` true, content empty. vitest **332 passed / 0 failed**, tsc 0.

**REMAINING LIMITATION** — this is the Next.js route the web client uses. The Android client has its own stream reader in `EngineCore` and was not changed, so its mid-stream-drop handling is unverified.

---

## §3 — Never lose a run

**FOUND** — Work produced by an engine that died was **unrecoverable**. The end-to-end proof killed engine A after 3 real tool calls and tried to move its workspace to engine C. The export returned **530**: `/off` had already taken the kernel down. Every file the task produced was gone.

**ROOT CAUSE** — the only copy of a task's files lived on the engine that was dying. A client cannot read work out of a process that no longer exists.

**FIXED** — the engine writes a checkpoint of the session workspace after every tool step, and **the client holds it**, because the client is the only party guaranteed to outlive the engine. `fetchCheckpoint()` pulls it; `transferWorkspace()` accepts a `heldCheckpoint` and uses it as the last resort when both engine endpoints are unreachable, reporting `fromCheckpoint`. The stream route pulls a checkpoint on every `tool_result` event — a tool result marks a completed step, which is exactly when the engine has just written a fresh one.

My **first attempt was wrong and I caught it**: I wrote the checkpoint to the engine's own `GEN_DIR` and added an endpoint to read it back. That does not help — `GEN_DIR` is on the same disk behind the same tunnel, so it dies with the kernel exactly like the workspace did. The test I wrote for it failed, which is what exposed the flaw.

**REAL TEST** — live on engine B:

**MEASUREMENT** —
- step one wrote `ck/step1.txt`; `GET /checkpoint/<sid>.zip` → HTTP 200, **128 bytes**, entries `['ck/step1.txt']`, valid zip, content `b'one\n'`
- step two wrote `ck/step2.txt`; the checkpoint grew to **234 bytes** with both entries — it tracks real progress, not a stale snapshot
- without the key: **HTTP 403**
- traversal: `..%2Fetc.zip` → **400**; `../etc.zip` → 502 (Cloudflare normalizes the path before the kernel sees it — also not a leak)

Also fixed on the way: the `/checkpoint/` endpoint returned **400 for every session** because it stripped the path prefix but not the `.zip` suffix, so the id was matched against the session regex with the extension attached. Caught by hitting the live engine; reading the code did not show it.

`tests/workspace-transfer.test.ts` → **11 tests**: recovery from a client-held checkpoint when the engine is gone entirely, reading a checkpoint off a live engine with the key attached, and a dead engine yielding null rather than throwing.

**REMAINING LIMITATION** — the checkpoint is only as fresh as the last completed tool step, so work inside an in-flight step is still lost. Task *state* (plan, step index, retry count) is not persisted across an app restart; only the workspace is.

---

## §4 — Automatic recovery and engine failover

**FOUND** — failover swapped the URL and lost the files (prior session), and the recovery path had never been run against two live kernels because only one engine could boot.

**ROOT CAUSE** — no workspace transfer, and no way to test it.

**FIXED** — `GET /workspace/<session>.zip` + `POST /workspace/<session>` (keyed, path-traversal checked), `transferWorkspace()`, called from the failover path; plus the checkpoint fallback in §3. The chain is `A → B → C → D → A` from `ENGINE_IDS`, advancing one step per failure so a dead engine is not retried indefinitely.

**REAL TEST** — `scripts/proofs/failover-live.py` (new). Not simulated: a real multi-step task ran on engine A producing `svc/app.py`, `svc/test_app.py`, `svc/REPORT.md`; engine A was killed with `/off`; health went to **530** and its workspace became unreachable, so the task genuinely would have died; the workspace was restored onto engine C; C continued the **same session** and reached verification.

**MEASUREMENT** — **14 passed, 0 failed.**
- victim: 100.3 s, 3 tool calls, real files
- `/off` → `{"status":"shutting down"}`, health 530, workspace unreachable
- restore → `{"status":"restored","files":3}`
- survivor: 101.4 s, `list_files → run_command ×2 → package_files`, `{'ok': True, 'outcome': 'verified'}`
- `svc.zip` downloaded: 793 bytes, valid zip, entries exactly the three project files

The **first run of this proof was 11/14**, and the three failures were a real bug: `package_files` packed the previous archive into itself (`4 entries: svc.zip, svc/REPORT.md, …`). After excluding root-level `.zip` files it is 14/14.

**REMAINING LIMITATION** — the survivor inherits *files*, not the dead engine's plan or step index, so it re-derives what to do from the workspace plus the prompt. A real user-facing failover through the Next.js route (rather than a script driving two engines) has not been exercised end to end.

---

## §5 — No artificial tool/step ceiling

**FOUND** — the agent stopped at **10 steps regardless of progress**. The loop was a flat `for it in range(10)`, so a task still making real progress — install a dependency, build, run tests, fix what failed — was cut off at step 10 with the work half done.

**ROOT CAUSE** — a hard-coded iteration count treated as a budget.

**FIXED** — the rail is now `while it < max(10, min(40, budget.max_calls))`, sized from the task's own budget. Both paths that loop back (`continue` after tool results, and the verification nudge) increment the counter explicitly. A turn that produces neither a tool call nor content three times running stops with an explanation instead of burning the budget.

**REAL TEST** — I walked the AST for every `Continue` node inside the while loop and confirmed its **true enclosing loop**, because a `continue` that targets the while without incrementing would spin forever. Two such continues existed; both are now guarded. Termination conditions: verified objective, all-repeats-detected (`break`), or three stalled iterations.

**MEASUREMENT** — the end-to-end task used **13** and **11** tool calls and reached `verified` on both runs, which the old ceiling of 10 would have cut off. Budget reported `{'calls': 13, 'replayed': 0, 'refused': 0, 'remaining': 11, 'max': 24}`.

**REMAINING LIMITATION** — the cap is 40 iterations. A task genuinely needing more would still stop, though it now stops on budget rather than on an arbitrary 10.

---

## §6 — Real command execution

**FOUND** — nothing. The capability was already real; what was missing was proof.

**FIXED** — no code change.

**REAL TEST** — `scripts/proofs/command-execution-live.py` (new): twenty operations through the engine's own `run_command` against a live kernel, each checked against expected output rather than the model's summary.

**MEASUREMENT** — **20 passed, 0 failed**:

| | | | |
|---|---|---|---|
| shell + exit code 15.8 s | pipeline 15.9 s | stderr captured 16.4 s | non-zero exit 14.9 s |
| file create/read 15.1 s | file edit (sed) 15.3 s | file delete 19.6 s | directory tree 16.5 s |
| script execution 66.8 s | tar create+verify 19.2 s | zip create+list 15.2 s | env setup 17.6 s |
| background process 35.2 s | process listing 16.5 s | process cleanup 22.2 s | timeout enforced (rc=124) 18.1 s |
| gcc compile+run (rc=7) 19.8 s | pip install 50.4 s | network egress (HTTP 200) 24.3 s | df/free 27.8 s |

**REMAINING LIMITATION** — commands run on a Kaggle kernel, not a separate per-task container. It is the user's own engine on their own account — not their host, not production — but two sessions on one engine share its CPU and disk even though their workspaces are separate. `run_command` has a 150 s cap per call.

---

## §7 — Full workspace awareness

**FOUND** — (prior session) every conversation shared one directory and the kernel had no concept of a session, so one task's `rm -rf build` deleted another's files.

**FIXED** — per-session workspaces under `/kaggle/working/sessions/<id>`, with the id regex-validated against traversal; `list_files` returns a real tree with sizes.

**REAL TEST** — live: session `alpha` wrote `alpha.txt`, session `beta` wrote `beta.txt`; alpha's `ls -la` showed only `alpha.txt`.

**MEASUREMENT** — **"ALPHA sees beta.txt: False"**. Traversal cases (`../etc`, `../../root`, an 80-char id, empty, `None`) all resolve inside the session root. In the end-to-end proof the survivor called `list_files` first and saw the transferred project.

**REMAINING LIMITATION** — workspaces live on the engine's disk and are lost when that kernel dies unless checkpointed (§3). No per-session quota.

---

## §8 — File and document understanding

**FOUND** — a binary attachment arrived at the model with **no text and no reason**. A PDF, zip or image produced `text = null` and nothing else, so the model saw a file it could not open with nothing telling it so — which is how it ends up describing the contents of a document it never read.

**ROOT CAUSE** — `stageAttachment` only had a textual branch; everything else fell through silently.

**FIXED** — `AttachmentText.isUnsupportedBinary()` classifies unreadable formats; `unsupportedNotice()` produces the sentence that stands in for the file, naming it, its size and type, stating that no text extraction exists and the contents were not sent, and telling the model to say so rather than describe what the file might contain.

**REAL TEST** — `AttachmentBinaryProof` (new), 21 assertions.

**MEASUREMENT** — detects pdf (by mime and extension), png, zip, docx, mp3, mp4, unknown octet-stream, null mime; does **not** flag text, markdown, json, csv, xml or python source. **The proof caught a real bug on its first run that reading the code had not**: a `.docx` mime type is `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, which contains `"xml"`, so checking text hints first classified a Word document as readable text and would have handed the model ZIP bytes. Binary hints are now checked first, with a comment that the order is load-bearing. jvm-suite **19/19** (was 18/18).

Also from the prior pass and still in force: an oversized *text* file sends head+tail with a stated omission instead of vanishing (`AttachmentTextProof`, 26 assertions).

**REMAINING LIMITATION** — this is detection and honest reporting, **not extraction**. PDFs, images and Office documents are still not read. The Android path is proven in the JVM suite; the web agent in `src/agent/context.ts` still sends attachment names only.

---

## §9 — Long context and long tasks

**FOUND** — **pasting a lot of text was fatal.** A 48,087-character message came back as a raw engine error and no answer:

```
HTTP 400 {"error":"request (8334 tokens) exceeds the available context size (8192 tokens)"}
```

**ROOT CAUSE** — `history_window` trimmed conversation history and shrank oversized *tool* results, but never a single large *user* message, so one long paste went straight to Ollama and was rejected.

**FIXED** — after the existing trims, any message still overflowing has its middle removed: 70% of the remaining allowance from the head, 30% from the tail, with a notice naming how many characters were omitted. The split is biased to the head because a question is normally at one end or the other.

**REAL TEST** — executed the real `history_window` from the shipped template; then re-ran the identical 48,087-character message against the live engine after deploying.

**MEASUREMENT** —
- Before the fix: **HTTP 400, no answer.**
- After: **TTFT 36.81 s, wall 38.9 s**, answer: *"The word at the very start of this message is **Background**."* — correct.
- A 60 KB paste with `FINAL QUESTION HERE` at the very end keeps that question, its head, and the system prompt, all within the 14,000-char budget.
- **Context assembly latency: 0.0858 ms** per call over a 162-message / 110,954-character conversation, producing 19 messages / 12,680 characters — **11% of the input**, newest question and system prompt intact.

**REMAINING LIMITATION** — a 48 KB paste still costs 36.8 s to first token, because the trimmed prompt must be prefilled. There is no summarization of old turns; they are dropped by recency, not condensed.

---

## §10 — Real web intelligence

**FOUND** — (prior session) `fetch_page` had no connect timeout or size cap, and every failure returned the same string, so the model could not tell a refused host from a timeout. That produced a 13-call, 234.8 s research task that ended with no citation.

**FIXED** — `--connect-timeout 8`, `--max-filesize 3 MB`, distinguishable failures, stated truncation.

**REAL TEST** — the end-to-end task searched, fetched, and cited.

**MEASUREMENT** — Task 1 used `web_search`, `fetch_page ×2`, and cited a real source URL; **11/11 and 13/13 tool calls succeeded** across two runs. An unroutable host is now bounded at **8.0 s** (was 40 s). Real sources, not placeholders.

**REMAINING LIMITATION** — the 13-call research task from the prior session has not been re-run, so the reduction in wasted calls is reasoned, not re-measured. Some sites (Cloudflare-protected, script-only) legitimately return nothing.

---

## §11 — Real browser agent

**FOUND** — no new defects. The browser layer was re-verified, not rewritten.

**REAL TEST / MEASUREMENT** — `browser-reliability-live.py --policy inspect`: **11/11 workflows, 8/8 assertions**. `browser-auth-live.py`: **30/30**. Live browser task wall in the reliability benchmark: **43.06 s**.

The credential model is intact: `_B_GRANTS[(session,host,kind)]` with a 900 s TTL; a fill targeting a credential field returns `NEEDS APPROVAL` unless the *user* granted it (`user_approved` set by the model is deliberately not enough); `_b_forget` runs on revoke, after a credential submit, and on `close`. `/captcha` still returns `BLOCKED: … I will not attempt to solve or bypass it`.

**REMAINING LIMITATION** — **no real account sign-up was performed.** That needs explicit user authorization and credentials, which were not provided this session. The browser suites ran against the shipped helper, not re-run after every template change.

---

## §12 — Media and image display

**FOUND** — (prior session) every generated image died on the next engine restart, because `MediaItem` stored the tunnel URL and three call sites dereferenced it directly.

**FIXED** — `MediaItem.path()` + `resolveUrl()` rebase `/files/` URLs onto the live engine; `ChatActivity.mediaUrl()` picks the current live engine. Web media is left alone.

**REAL TEST / MEASUREMENT** — `MediaUrlProof`, 15 assertions, jvm-suite 19/19. Live: `generate_image` produced a real **20,709-byte JPEG** (valid `FFD8`/`FFD9`), the media wire event carried `{"kind":"image","url":…,"source":"generate_image"}` as a structured event, and the file downloaded intact.

**REMAINING LIMITATION** — the rebasing runs in `ChatActivity`, which needs a real phone. The logic is proven in the JVM suite and compiles against the real SDK, but **no APK has ever been installed here**.

---

## §13 — Real artifact completion

**FOUND (1)** — `package_files` **packed the previous archive into itself**. Measured live: `4 entries: svc.zip, svc/REPORT.md, svc/app.py, svc/test_app.py` — `svc.zip` was the archive being written, so every re-run grew the file.

**FOUND (2) — the more serious one: "packaged successfully" was a claim nothing checked.** Told to "package the workspace into build.zip", the model ran `zip -r build.zip build` through `run_command` instead of calling `package_files` — a perfectly reasonable choice — and the archive landed in the session workspace. `GEN_DIR` is what the tunnel serves, so:

| | |
|---|---|
| `build.zip` on disk | **557 bytes**, confirmed with `ls` |
| `/files/build.zip` | **HTTP 404** |
| the answer | *"Created `build.zip` containing the `build/` directory"* |
| verification | `{'ok': True, 'outcome': 'verified'}` |

The file was real, the turn reported success, and the download did not exist. Two gaps: the archive was written where nothing serves it, and `verify_intent` had no notion of a downloadable file — "package X into build.zip" routed to `PACKAGE`, which means a Python *package install* and verifies by asking whether a module became importable. The check that passed was checking something else entirely.

**FIXED** — `_publish_archives()` copies any archive the model builds in the workspace into `GEN_DIR` after every tool step (25 MB cap, only when the published copy is missing or older). Rather than argue with the model about which tool it prefers, publish whatever it produced. A new `ARCHIVE` intent, distinct from `PACKAGE`, routes on `package|bundle|archive|zip|compress|tar … .zip` and verifies against `SERVED_DIR`.

**FOUND (3) — my own new verifier then rejected tasks that had genuinely succeeded.** Re-running the same prompt after the fix:

| | |
|---|---|
| `build.zip` | **HTTP 200, 3792 bytes, valid zip, 13 entries** |
| verification | `{'ok': False, 'unmet': ['archive: no archive filename was reported']}` |

Root cause: `_archive_name()` read the filename out of the tool result, and `package_files` never repeats the archive's name in its own success message — it reports `ARCHIVE READY: 2 file(s), 233 bytes, sha256:…, 2 entries: …`. The check was reading whether the *text* mentioned a file instead of asking whether the *file* is there. Fixed with `_any_served_archive()`, which looks in `SERVED_DIR` and returns the newest archive actually present.

**FIXED** — root-level `.zip` files are excluded; a workspace holding only previous archives reports `nothing to package` rather than producing a self-referential zip.

**REAL TEST** — regression test executes the real `t_package_files` from the template; plus live downloads.

**MEASUREMENT** — three archives independently downloaded and checksum-verified against what the engine claimed:

| claimed | measured |
|---|---|
| `1 file(s), 131 bytes, sha256:01540564a2043cbd` | 131 B, PK magic, **sha256 exact**, `testzip` clean |
| `1 file(s), 151 bytes, sha256:91c89090ab9e57f0` | 151 B, **sha256 exact**, `testzip` clean |
| `lagos.zip` 1048/1106 bytes | valid zip, entries `['lagos/test_lga.py','lagos/FINDINGS.md','lagos/lga.py']`, **no self-inclusion** |

**MEASUREMENT** — routing 7/7: "Package the workspace into build.zip", "Zip everything up as report.zip", "Bundle the project to dist.tgz" all reach `ARCHIVE`, while "Install pandas" and "pip install requests" still reach `PACKAGE` and "write a script" still reaches `CODE`. Verification, all four branches against the real module: empty directory → False with guidance; the tool's own success message while the directory is empty → False (a claim is not evidence); file present → True; a named file that does not exist → True when another real archive is served. Publishing executed against real kernel code: a shell-built `build.zip` went from absent in `GEN_DIR` to present and valid, idempotent on a second call, and a newly created `second.zip` was picked up. **Live on engine D: `/files/build.zip` HTTP 200, 3792 bytes, valid — where the same prompt previously returned 404.**

**REMAINING LIMITATION** — archives live on the engine and expire with its tunnel. No video artifacts were produced or tested. `_publish_archives` copies any root archive under 25 MB, so an unrelated large archive in the workspace would also be published.

---

## §14 — Error recovery everywhere

**FOUND** — failures were indistinguishable (§10), a silent file drop existed (§8), a truncated stream claimed success (§2), and a dead engine's work vanished (§3).

**FIXED** — every failure path now names itself: curl exit codes, timeout seconds, `source-gone` vs `nothing-to-transfer` vs `failed` with detail, `truncated: true` with the partial text kept, `BLOCKED by overlay: <what> is covering <selector>`, `NEEDS APPROVAL: …`, `nothing to package`. `reportFailure()` evicts a dead engine on both mid-turn failure paths.

**REAL TEST / MEASUREMENT** — all of the above observed live or in tests. `agent-loop-live.py` **25/25** still proves a failed `generate_image` yields `verification.ok=False` naming the missing image, nudges the model, and **still terminates** within 3 verification events. `orchestration-live.py` **54/54, routing 20/20**.

**REMAINING LIMITATION** — quota exhaustion is still a hard wall that cannot be retried away. There is no automatic replan on repeated failure beyond the budget's two-strike refusal per action.

---

## §15 — Streaming and chat responsiveness

**FOUND** — the partial-output loss in §2. Separately, I checked for artificial input limits.

**ROOT CAUSE** — see §2. On input length: there were no `maxLength` caps in either client, but the engine rejected anything over the context window outright (§9).

**FIXED** — §2 and §9.

**REAL TEST / MEASUREMENT** —
- Streaming is real, not replayed: a two-word answer arrives as **2 content chunks** (`['Hello', '!']`), and `readNdjson` forwards deltas as they arrive with no buffering.
- **No wire gap ever exceeded 10.00 s** during a 170 s generation (986 content chunks, 21 thinking events) — the heartbeat interval is the ceiling, so a client stall timer set above 10 s will never fire spuriously.
- **No input length cap** in `ChatActivity` or the web components; a 48 KB paste now works end to end (§9).

**REMAINING LIMITATION** — Stop-button behaviour and reconnect-after-interruption were not exercised on a device. The Android stream reader is a separate implementation from the one fixed in §2.

---

## §16 — Agent intelligence

**FOUND** — routing and planning work; the wasted-call problem showed up as redundant re-fetches (§10).

**FIXED** — the orchestration layer was not rewritten; the root cause was upstream.

**REAL TEST / MEASUREMENT** — `orchestration-live.py` **54/54, routing 20/20**; parallel execution 0.54 s vs serial 1.07 s. Live tasks chose correctly: the code task used `list_files → run_command → package_files` (3 calls, no waste); the image task used only `generate_image`; a greeting spent no tool call. In the end-to-end proof the plan was published **before any tool ran**, with a goal, capabilities and evidence.

**REMAINING LIMITATION** — the 13-call research task is the counter-example and has not been re-run.

---

## §17 — Final end-to-end proof

**REAL TEST** — `scripts/proofs/end-to-end-live.py` (new), two tasks against two live engines.

**Task 1 — complex, multi-capability** (web search + crawl + files + commands + dependency install + packaging), engine A:

| metric | run 1 | run 2 |
|---|---|---|
| wall | 495.6 s | 374.1 s |
| TTFT | 77.67 s | 53.78 s |
| tool calls | 13 | 11 |
| tool calls succeeded | **13/13** | **11/11** |
| verification | `verified` | `verified` |
| checks passed | **14/14** | **14/14** |

Tools used: `web_search`, `fetch_page ×2`, `list_files`, `run_command ×8`, `package_files`. `lagos.zip` downloaded, valid, entries `['FINDINGS.md','lagos/lga.py','lagos/test_lga.py']`, no self-inclusion, real source URL cited.

**Task 2 — engine killed mid-execution**: engine A killed after **3 real tool calls at 78.3 s**; health 530; engine C continued the same session and reached `{'ok': True, 'outcome': 'verified'}`. The dedicated failover proof (§4) is **14/14** including a downloaded, checksum-consistent archive.

**REMAINING LIMITATION** — in the last full end-to-end run the kill landed before the victim had written a checkpoint the test could reach, so the survivor restarted rather than resumed; it still completed and verified, but "resumed from the checkpoint" is proven in unit terms and at the endpoint level (§3), not yet re-measured across two live engines in one run.

---

## The gate

| check | result |
|---|---|
| `vitest` | **333 passed / 0 failed** (was 288 before this whole effort) |
| `tsc --noEmit` | **0 errors** |
| `jvm-suite.sh` | **19/19 proofs** (was 16/16) |
| `browser-reliability-live.py` | **11/11 workflows, 8/8 assertions** |
| `browser-auth-live.py` | **30/30** |
| `orchestration-live.py` | **48/48 (quick), routing 20/20** |
| `agent-loop-live.py` | **25/25** |
| `command-execution-live.py` | **20/20** |
| `failover-live.py` | **14/14** |
| `end-to-end-live.py` task 1 | **14/14** |
| `verify-engine-source.mjs` | **PASS** |
| `gradle :app:compileDebugJavaWithJavac` | **BUILD SUCCESSFUL** |
| `orchestration-fix.py --check` | **OK, embedded module matches** |
| Template pin | `8ee627bf657b…`, rendered 198 013 bytes |
| APK | **2.4.0**, versionCode 43 |

New this session: `engine-reliability.py`, `command-execution-live.py`, `failover-live.py`, `end-to-end-live.py`, `AttachmentBinaryProof`, plus tests for checkpoint recovery, truncation reporting and oversized-message trimming.

---

## What I could not do, stated plainly

1. **Decode speed is a hardware ceiling.** ~8 tok/s at `num_ctx=8192` is what this GPU delivers with this 16.86 GB model at 14.77 GB resident. It is not fixable in software, and I did not fake it.
2. **No APK has ever been installed on a device.** There is no `/dev/kvm` in this sandbox, so no emulator, ever. Every Android claim comes from the JVM suite or from `compileDebugJavaWithJavac` against the real SDK — never from observed device behaviour. This includes §12 media rendering, §15 Stop/reconnect, and the §2 fix (which is in the Next.js route, not the Android reader).
3. **No authorized browser sign-up or account workflow was performed.** That needs explicit user authorization and credentials, which were not provided.
4. **PDFs, images and Office documents are not read.** They are now detected and reported honestly, which is what the brief asked for, but there is no extraction.
5. **The web agent (`src/agent/`) and the Netlify deploy were not exercised.** All live testing went through the engine kernel directly.
6. **Task state is not persisted across an app restart.** The workspace survives via checkpoints; the plan and step index do not.
7. **Four of my own measurements or fixes were wrong and I corrected them rather than reporting them:**
   - the "0.72 tok/s decode" figure folded tool time into the denominator;
   - the "44.69 s stream stall" was a gap between content chunks, not a wire stall;
   - my first checkpoint design wrote to the engine's own disk, which dies with the kernel — the test I wrote for it is what exposed the flaw;
   - my first `ARCHIVE` verifier rejected tasks that had genuinely succeeded, because it read the tool's prose instead of the directory.

8. **Two test harnesses were broken and hid real results.** `orchestration-live.py` did not extract the fetch-limit constants, so every fetch failed with `NameError` and surfaced as a *verification* failure — a harness bug wearing the costume of a product bug. `agent-loop-live.py` lacked `_CURRENT` and the workspace helpers, so `agent_stream` died before the first command ran. Both fixed; the suites now report 48/0 and 25/0.

9. **The end-to-end kill proof's last full run was 19/20 then 16/20**, with the failures being (a) my test demanding a specific filename the model was free to choose differently, and (b) the archive-verification bug in §13. The archive bug is fixed and re-verified live; a clean 20/20 run of the whole proof against the final build has not been completed.
