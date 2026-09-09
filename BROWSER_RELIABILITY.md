# Browser automation: reliability and speed

Diagnosis, fix and measurement for the repeated selector timeouts.

Everything below was measured on a real Chromium in this workspace, driving a
helper extracted from the shipped notebook asset. No selector was added to make
a test pass, and no tool-call limit was raised.

---

## 1. The failure, reproduced

`scripts/proofs/browser-reliability-live.py` runs 11 real workflows against a
local site (`scripts/perf/browser-site.py`) that reproduces the conditions the
agent actually meets: forms rendered after load, a login form inside an iframe,
a consent veil over the submit button, ids regenerated on every load, a
redirect, file upload, session persistence and a CAPTCHA page.

**BEFORE — shipped helper, 11 workflows: 6 passed, 38 tool calls, 100.5 s.**

Four of the five failures were the same shape:

```
TimeoutError: Page.fill: Timeout 30000ms exceeded.
  - waiting for locator("input[name=email]")      <- the field IS on the page, in a frame
TimeoutError: Page.click: Timeout 30000ms exceeded.
  - waiting for locator("#subscribe")             <- resolved fine; a veil covers it
TimeoutError: Page.fill: Timeout 30000ms exceeded.
  - waiting for locator("#email-1")               <- id was regenerated, now #email-401ebc
TimeoutError: Page.click: Timeout 6000ms exceeded.
  - waiting for locator("#subscribe")
    - locator resolved to <butt…                  <- the only hint, truncated
```

90.3 s of the 100.5 s was three blind 30 s waits. The element was never the
problem in any of them.

## 2. Root cause

Three separate defects, all in the helper:

**a) It acted without ever looking.** `click`/`fill`/`submit`/`select`/`upload`
passed the selector straight to `page.click(selector, timeout=to)`. Playwright
waits, then throws. The agent got a stack trace and no facts, so the only move
available was to guess another selector — which is what a blind retry is.

**b) One timeout served two different promises.** `to` was a single budget used
for both page loads and interactions, so a missing selector sat for the full
30 s. Three of them is a 90 s task that produces nothing.

**c) It searched only the main frame.** A form inside an iframe was
indistinguishable from a form that did not exist.

## 3. The fix

`scripts/browser-reliability-fix.py` — 13 edits to the helper, 3 to the tool
schema. `--check` asserts all 16 are present and that the three blind paths are
gone; it refuses to write if any edit matches zero times.

**`inspect` — one call, structured page state.** Returns url, title,
`readyState`, every frame with its name and url, every visible field with its
label, name, role, type and a selector that actually works, buttons, and any
overlay or dialog covering the page with the percentage of the target it
obscures. This is the fact-finding step that was missing.

**Resolve before acting.** Every interaction goes through `_b_resolve`:
candidate selectors ordered stable-semantic → label → name → role/text →
attributes → the raw selector, swept across all frames, and a
visible/enabled/editable check before the action. It sweeps with `count()`
first — free — and only waits once if nothing matched anywhere, so one bad
selector costs the action budget, not (frames × budget).

**The blocker is named.** `BLOCKED by overlay: #veil is covering #subscribe.
Dismiss it first — inspect the page to find its close or accept control.` A
failed action now costs 0.1 s and tells the agent what to do, instead of 30 s
and a truncated stack trace.

**Separate budgets.** `_B_ACTION_MS` 8 s for an interaction, `_B_LOAD_MS` 30 s
for a page load, `action_timeout` exposed in the schema.

**Deterministic waits.** `wait` takes `dom | load | network | url:<part> |
visible:<sel>`; the fixed sleep survives only as an explicit capped fallback
that says so in its own reply.

**`batch`** runs independent read-only steps in one call.

**Schema.** `inspect` and `batch` added to the `action` enum, plus a
description that tells the model to inspect after navigating and after any
missed selector, and to prefer label/role selectors because ids are generated.
Without the enum entry the new actions were uncallable — dead code.

**One hardening found on the way:** `close` did not revoke the session's
credential grants. A grant is 15 minutes of consent for a host; leaving it
alive let a later session inherit consent nobody gave it. `close` now calls
`_b_forget(session)`.

## 4. Measured

### Same policy, old helper vs new helper (isolates the tool)

| | workflows | tool calls | wall |
|---|---|---|---|
| shipped helper | 6 / 11 | 38 | 100.5 s |
| new helper | 10 / 11 | 39 | **37.0 s** |

Even when the agent guesses selectors exactly as before, the new helper fixes
the iframe, names the blocker, and cuts the wall time by 63 %. The one remaining
failure is the overlay workflow: the guessing agent clicks `#subscribe` without
dismissing the banner first. The tool now says so in 0.2 s instead of burning
30 s — the failure is the policy's, and it is now legible.

### New helper, inspecting first (the intended use)

| | workflows | tool calls | wall |
|---|---|---|---|
| BEFORE | 6 / 11 | 38 | 100.5 s |
| AFTER | **11 / 11** | 49 | **4.0 s** |

**25× faster wall time, every workflow passing.** Tool calls rose by 11 — one
`inspect` per page — and bought 5 workflows and 96 s. Per workflow:

| workflow | before | after |
|---|---|---|
| dynamic form | PASS 6 calls 2.1 s | PASS 8 calls 2.2 s |
| iframe form | **FAIL 3 calls 30.1 s** | PASS 4 calls 0.2 s |
| overlay | **FAIL 3 calls 30.1 s** | PASS 6 calls 0.3 s |
| unstable ids | **FAIL 3 calls 30.1 s** | PASS 4 calls 0.1 s |
| file upload | PASS 4 calls 0.2 s | PASS 6 calls 0.2 s |
| session | PASS 3 calls 0.1 s | PASS 3 calls 0.1 s |
| redirect | PASS 3 calls 1.6 s | PASS 3 calls 0.5 s |
| full sign-in | PASS 7 calls 0.2 s | PASS 9 calls 0.2 s |
| blocked control | **FAIL 2 calls 6.1 s** | PASS 2 calls 0.1 s |
| captcha | PASS 2 calls 0.1 s | PASS 2 calls 0.1 s |
| batch | **FAIL** (unknown action) | PASS 2 calls 0.1 s |

What the AFTER transcript actually shows:

```
INSPECTED …/iframe | title=Framed | 3 fields, 1 buttons, 2 frames | frames: partner
FILL into frame=partner >> #email-1 (15 chars, value withheld)

INSPECTED …/overlay | 1 fields, 2 buttons | BLOCKED by overlay #veil (100%)
CLICKED #accept
SUBMITTED #subscribe | now …/dashboard

FILL into #email-401ebc (15 chars, value withheld)      <- id found by label
WAITED for url /login | now …/login?via=redirect        <- deterministic, not a sleep
BLOCKED by overlay: #veil is covering #subscribe. Dismiss it first -- …
BLOCKED: this page presents a CAPTCHA. I will not attempt to solve or bypass it.
BATCH 3 steps | 1. PAGE …/login | title=Sign in | … | 2. COOKIE…
```

### Honest reading of the call count

Calls went up, not down, and that is the real trade: one `inspect` per page
costs a call and removes every blind retry. The comparison the directive asks
for is cost per completed task — 38 calls for 6 tasks versus 49 for 11 — and a
real agent facing the BEFORE failures would retry, which this harness
deliberately does not model. `batch` collapses three reads into one call where
they are independent.

## 5. What was deliberately not done

**No CAPTCHA, MFA or anti-bot bypass.** `/captcha` returns
`BLOCKED: this page presents a CAPTCHA. I will not attempt to solve or bypass
it. Tell the user this step needs them.` That is a refusal, asserted by the
harness.

**The credential gate is unchanged and still enforced.** A `fill` on a
credential field without a live scoped grant returns `NEEDS APPROVAL`.
`browser-auth-live.py` is **30/30** against the patched asset, including the
check that no secret value appears in any of the 36 replies.

**No new selectors.** The site's ids are regenerated per load; the fix finds
fields by label, name and role.

**No limit raised.**

## 6. Two bugs this measurement caught in my own work

- I wrote `_b_state_of` with `Locator.is_attached()`. This Playwright has no
  such method, and a bare `except: return False, 'detached'` turned it into
  "the element is no longer attached to the DOM" for elements that were present
  — a confident wrong diagnosis on every interaction. Probed `dir()`; now uses
  `count()`/`is_visible()`/`is_enabled()` and puts the real exception text in
  the message.
- `wait url:` used a glob. In Playwright globs `*` does not cross `/`, so
  `*/login*` never matched `http://host/login` and cost a full 15 s timeout.
  Now a compiled regex.

The second one only surfaced because the harness asserted on it: an earlier
AFTER run reported 11/11 workflows while `WAIT FAILED after 15000ms` was
sitting in the transcript. A workflow can pass on its final state while a step
inside it is broken, so the tally alone was not evidence.

## 7. Gate

```
vitest               288 passed / 5 skipped / 0 failed   (36 files)
tsc --noEmit         0 errors
npm run lint         0 errors / 17 warnings              (unchanged)
jvm-suite.sh         16/16 proofs clean
browser-auth-live.py 30/30                               (credential gate)
reliability-live.py  11/11 workflows, 8/8 assertions
```

Template pins moved with the change: SHA
`1d663b18a949dcd380ae287a551b24674c781bec0544d2b0daa76a4a7518b15a`, rendered
121128 bytes, asserted in `tests/kaggle-wake-source.test.ts` and
`scripts/verify-engine-source.mjs`.

## 8. APK

`apk/aether-2.0.9-release.apk` — 771 996 bytes, versionCode 38. Verified by
unzipping `assets/aether-notebook-template.json` back out of the built APK,
decoding the helper literal the way the kernel does, and running the full
harness against that extracted helper: **11/11 workflows, 8/8 assertions, and
the credential gate 30/30.** So the artifact that ships is the artifact that
was measured, not a copy of it.

The first build died with `Gradle build daemon disappeared unexpectedly`, and
the log named the cause: `The Daemon will expire after the build after running
out of JVM Metaspace` at `-XX:MaxMetaspaceSize=256m`. The split was wrong, not
the total — R8 wants more metaspace than 256 m. `android/gradle.properties`
now uses `-Xmx768m -XX:MaxMetaspaceSize=384m`, the same ~1.15 GB ceiling, and
the build completes. Build alone; any other load on this 2 GB sandbox with no
swap kills it.

## 9. Not verified

The APK is never installed on a device — there is no emulator here and no
network path to one. Everything above is the same Python helper the APK
embeds, run against real Chromium, but the on-device path is unproven.

Live engines A and B are at their weekly GPU quota, so no end-to-end run
through a real model made these tool calls. The measurements are of the tool
and the harness, not of a model choosing to call `inspect`. That last step
depends on the schema description, which is the weakest link in this change.
