# Agent task timeline + Drive recheck — evidence summary

Branch `android/live-agent-execution-20261106`, tip `330ea80`.
Device run: https://github.com/spencerbby8-gif/aether/actions/runs/42709687746 — **success**.
APK from that run: `aether-debug-timeline-8952668.apk`, 4,794,988 bytes,
SHA-256 `0dfc01b5f107795be9579384981013aac6cfcf3ae32833470117781c865d0bca`.

## 1. Drive recheck — the rotated secret is live and accepted

A temporary confirmed account was created, signed in for a real user JWT, and
the deployed function was called with it. The account was deleted afterwards;
`google_drive_credentials` was empty before and after.

| Call | Result | Meaning |
|---|---|---|
| `access` | `404 not_connected` | JWT resolved; both secrets configured (no more `503`) |
| `connect` + junk code | `400 invalid_grant` | **Google authenticated the client** — id + rotated secret accepted; only the code was rejected |
| `disconnect` | `200 {"disconnected":true}` | revoke-then-delete ran on a real session |
| `access` again | `404 not_connected` | the link really was removed |

A wrong secret would have produced `503 drive_not_configured` on the first call
and `invalid_client` on the second. Neither happened.

Still unproven: consent, real code exchange, refresh grant, actual upload,
restore. That needs a phone with Play services and your Google account.

## 2. Agent task timeline — built, captured, and visually checked

`AgentTimelineView` replaced the flat step list. Depth is the status signal: the
run sits on a raised card, each phase is its own block, and the executing phase
is lifted with an accent border and a breathing node. Steps are grouped into
consecutive phases by `core/AgentRun`.

Captures read pixel by pixel, not just counted:

- `17b-agent-timeline.png` — live state. "Understanding the task" (synthetic,
  with the no-private-thoughts note), "Gathering information · 2 steps · 8ms"
  with two ticked rows and their real detail (the search query, the host), then
  "Running commands · 0 of 1" lifted with the accent border, the pulse in the
  header, the active row in accent and `$ pwd` visible in its well.
- `18-activity-command-summary.png` — finished state. All nodes ticked, per-step
  durations (4ms / 4ms / 826ms), phase totals, collapsed line
  "Searched the web · Read a source · Ran a command · 834ms", TASK SUMMARY below.
- `17-activity-command-open.png` — same panel mid-run, now unobstructed.

## 3. A real defect found by looking, not by trusting CI

Shots 17–20 had the Workspace drawer open over the transcript in **every**
previous run. The assertions passed because uiautomator reads the accessibility
tree, which still contains covered views — so a green run proved nothing about
the pixels. The drawer is now closed after returning from Settings, and the test
asserts it is closed before capturing. This is why the first attempt at this
task's screenshot was rejected and re-run.

## 4. Proof tallies

| Suite | Result |
|---|---|
| `TaskTimelineGroupingProof` | **26/26** — chronology preserved (search → command → search is three phases), nothing invented, unknown tool shown as "Working", unfinished step stays live with no duration and reads "0 of 1", reasoning block stops being active when a tool starts |
| `DriveBrokerErrorsProof` | 20/20 |
| `drive-broker-check.sh` (live) | 5/5 |
| JVM suite | **27/28** — only the pre-existing `StatusProof`, which needs real Kaggle credentials |
| Instrumentation | ScreenshotTest OK(2), LiveExecutionHandshakeTest OK(4), ExhaustiveThemeTest OK(1) |

## Known gaps

- The timeline has only been captured in the dark theme. All its colours resolve
  from theme tokens, so light should follow, but that is a code argument, not a
  capture.
- Motion (breathing node, 200ms block arrival) is exercised by the code path but
  cannot be judged from stills.
- No live engine turn has rendered this timeline end to end.
