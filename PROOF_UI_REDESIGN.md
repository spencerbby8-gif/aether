# Aether chat-first redesign — what changed, what was copied, what was proven

Date: 2026-09-06 · Commits: `3895bb9` (redesign), plus the follow-up in this working tree
(router fix, dead-code removal, JVM router check).

This document separates three things that are easy to blur together:

1. what the new UI actually is,
2. what was taken from your `ReplyMate` app and what was deliberately not,
3. what has been **verified by running something**, and what has not.

---

## 1. What the opening screen is now

Before: a control panel. Engine A/B/C switcher, wake buttons, shut-down buttons, status
lights, and the chat underneath it.

Now, `aapt dump badging apk/aether-release.apk`:

```
package: name='com.aether.app' versionName='1.0.0'
sdkVersion:'26'   targetSdkVersion:'37'
uses-permission: android.permission.INTERNET
uses-permission: android.permission.ACCESS_NETWORK_STATE
launchable-activity: name='com.aether.app.ChatActivity'
```

The launcher is the chat. Its complete id list (`activity_chat.xml`) is:

```
header_sub  engine_chip  settings_btn  chat_scroll  msg_list  input  send_btn  stop_btn
```

That is the whole opening screen: a title/subtitle header, one **read-only** status chip,
a gear, the message list, and the composer. The only match for `wake|shutdown|engine_a|…`
in that layout is `engine_chip`, which is a `TextView` — there is no engine control on this
screen. `MainActivity` and `EnginesActivity` are deleted from the tree, along with their
three layouts.

Engine selection, AUTO, per-engine status, wake and shut-down live only in `SettingsActivity`
(`activity_settings.xml` ids: `back_btn routing_rows engine_rows off_all settings_note`),
reached from the gear. Each engine card is built in `buildEngineRows()` and carries
`R.id.status` / `R.id.wake` / `R.id.off` (declared in `values/ids.xml`), refreshed by id in
the 15-second poll loop.

The assistant bubble is filled only by real NDJSON events from the engine: dim thinking
rows, accent mono tool tiles for tool lines, and content appended per token. The
"thinking…" placeholder is removed on the first token. There is no static animation and no
canned response anywhere in this path.

---

## 2. ReplyMate vs Aether — adopted, and deliberately not

Reference: `spencerbby8-gif/ReplyMate` @ `69125c8`, read from
`res/values/colors.xml`, `res/layout/activity_conversation.xml`,
`res/drawable/bg_bubble_{in,out}.xml`, `bg_field.xml`, `btn_{primary,ghost}.xml`,
`src/com/replymate/app/ui/ConversationActivity.java`, `docs/previews/*.png`.

| Aspect | ReplyMate (yours) | Aether now | |
|---|---|---|---|
| Page background | `#0D1117` | `aether_bg #0B0D12` | own palette, darker |
| Accent | `#0A84FF` | `aether_accent #6EA8FF` (+ `#2F6FDB` deep) | own accent |
| Card / field | `#161B22` / `#11161D` + `1dp #2A3139` | `#151A24` / `#10141B` + `#2A3140` | same idea, own values |
| Bubble radius | 14dp | `bubble_radius 14dp` | **adopted** |
| Bubble fill | in `#1C2330`, out `#1E3250` | in `#1B2130`, out `#1E3250` | out tone matched |
| Message text | 15sp, 12/8dp pad | `text_msg 15sp`, `14dp/10dp` | adopted size, own padding |
| Outgoing alignment | gravity END, 48dp opposite margin | `msg_side_margin 40dp` | adopted pattern, own metric |
| Dim meta line under bubble | yes | yes (`text_meta 11sp`) | adopted |
| Composer | card, multiline `EditText` + send beside | same, `send_btn` 46dp + `stop_btn` toggle | adopted, plus stop |
| Header | back arrow, bold title, dim subtitle, action links | mark + title + `header_sub` + gear | adopted structure |
| Empty state | centred, dim | centred, dim | adopted |

**Adopted:** the structural language — chat-first page, bubble geometry, hairline field,
composer card, header with a dim subtitle, centred empty state, one accent colour used
sparingly.

**Deliberately not copied:** branding, the `ReplyMate` name/mark, its colour literals,
its package or class names, and its code. Nothing was pasted; the drawables and layouts are
Aether's own files with their own tokens. `com.aether.app` is untouched as a namespace.

**Aether-specific additions ReplyMate has no equivalent for:** three-zone assistant bubble
(thinking / tool tiles / content), the stop button wired to a real cancel flag, the
read-only engine chip, the settings routing rows and per-engine wake/shut-down, and the
"shut down all" with per-engine confirmation.

---

## 3. A real bug the redesign work exposed, and the fix

While writing a JVM check against the **shipped** `EngineRouter` class, AUTO failed:

```
FAIL  AUTO with all live picks A  ->  none -- engine AUTO is not configured
FAIL  AUTO skips dead A, picks B  ->  none -- engine AUTO is not configured
FAIL  AUTO skips dead A and B, picks C  ->  none -- engine AUTO is not configured
FAIL  AUTO with nothing live refuses and names every engine  ->  none -- engine AUTO is not configured
ROUTER CHECK  7 passed, 4 failed
```

Cause: `EngineRouter.AUTO` is the lower-case string `"auto"`, and `route()` compared the
selection with `AUTO.equals(selection)`. Anything else — `"AUTO"`, `"Auto "`, `"A"`, an old
or hand-edited preference — fell into the manual-pin branch and was reported as
*engine AUTO is not configured*. The screens display "AUTO", store lower case, and the
default is correct, so this did not break the happy path; it made every non-lower-case value
behave like a dead pin instead of routing.

Fix, in one place at the routing boundary: normalise the selection (trim, lower-case, blank
means AUTO) inside `route()` and `failoverFrom()`, and expose `canonical()` / `isAuto()` for
the callers. `ChatActivity` (chip label, wake candidate) and `SettingsActivity` (which row is
highlighted) now go through those instead of raw `equals`.

After the fix, on the same shipped class (`scripts/proofs/RouterCheck.java`, which imports
`com.aether.app.EngineRouter` and asserts on the `Decision` it returns — not a copy of the
logic):

```
PASS  AUTO with all live picks A            -> A (auto: first healthy in A→B→C)
PASS  AUTO skips dead A, picks B            -> B (auto: first healthy in A→B→C)
PASS  AUTO skips dead A and B, picks C      -> C (auto: first healthy in A→B→C)
PASS  AUTO with nothing live refuses and names every engine
PASS  pin B uses B even when A is live      -> B (manual pin)
PASS  pin A refuses when A is down (no silent hop to B)
PASS  pin on unknown slot is explained, not guessed
PASS  failover from A lands on B and is flagged
PASS  failover from C wraps to A
PASS  failover with nothing else live refuses
PASS  no engines configured refuses cleanly
PASS  upper-case AUTO still routes (was a dead pin)
PASS  padded mixed-case AUTO still routes
PASS  upper-case pin B still pins B
PASS  null selection means AUTO
PASS  blank selection means AUTO
PASS  upper-case failover source resolves
PASS  isAuto is case-insensitive
PASS  canonical lower-cases and defaults to AUTO

ROUTER CHECK  19 passed, 0 failed
```

Reproduce: `javac -d /tmp/rc android/app/src/main/java/com/aether/app/EngineRouter.java
scripts/proofs/RouterCheck.java && java -cp /tmp/rc RouterCheck`.

## 4. Dead code removed

`AetherBridge` was a `@JavascriptInterface` WebView bridge. The redesigned app has **no
WebView at all** — no layout references one, and no activity called `addJavascriptInterface`.
The only references to the class in the whole repo were inside its own file. It is deleted
(`git rm`), and the release dex confirms the shipped classes are now exactly the two
activities plus the minified engine/router/credentials code:

```
$ dexdump -a classes.dex | awk '/Class descriptor/{print $NF}' | grep aether
'Lcom/aether/app/ChatActivity;'
'Lcom/aether/app/SettingsActivity;'

$ grep EngineRouter apk/aether-release-mapping.txt
    com.aether.app.EngineRouter.canonical(java.lang.String) -> n
    com.aether.app.EngineRouter.route(java.lang.String, java.util.List) -> K
```

So the routing fix is in the artifact, under an obfuscated name.

---

## 5. What was run this turn, and what came back

| Check | Command | Result |
|---|---|---|
| Android debug build | `gradle :app:assembleDebug` | BUILD SUCCESSFUL in 18s, exit 0 |
| Android release build | `gradle :app:assembleRelease` (signed) | BUILD SUCCESSFUL in 51s, exit 0 |
| Routing (real shipped class) | `java -cp /tmp/rc RouterCheck` | 19 passed, 0 failed |
| Release signature | `apksigner verify --print-certs` | `CN=Aether, OU=Aether, O=Aether, L=Port Harcourt, ST=Rivers, C=NG`, SHA-256 `a4b7b616…97f04`, verified |
| Launch target | `aapt dump badging` | `launchable-activity: com.aether.app.ChatActivity` |
| Credentials at rest | `unzip -p … assets/aether-credentials.dat \| grep -c KGAT` | `0` plaintext keys |
| TypeScript | `npx tsc --noEmit` | exit 0, no diagnostics |
| Lint | `npx eslint .` | 0 errors, 17 warnings (pre-existing) |
| Tests | `npx vitest run` | 31 files passed, 249 tests passed, 5 skipped |

Artifacts: `apk/aether-release.apk` (674 808 bytes) and `apk/aether-debug.apk`
(3 837 238 bytes), plus `apk/aether-release-mapping.txt`.

XML comments cannot contain `--`, and aapt2 rejects them hard. Two of the build failures in
this cycle were that, in `res/values/colors.xml` and then in `AndroidManifest.xml`; both
files are now comment-free and both build clean.

---

## 6. What is NOT proven — read this before trusting the APK

- **The APK has never been installed or run.** This sandbox has no `/dev/kvm` and no
  `vmx`/`svm`, so no Android emulator can start here. `ChatActivity` and `SettingsActivity`
  have never been rendered on a screen. Every statement about how the UI looks is from the
  layout XML and the code, not from pixels.
- **No engine was contacted in this turn.** All three engines are OFF. The streaming,
  web-search, command-execution, media, wake, failover and shut-down behaviour described in
  this document is carried over from earlier proof runs (`PROOF_ANDROID_ENGINES.md`,
  `PROOF_REAL_KAGGLE.md`, `scripts/proofs/MultiEngineProof.java` 21/21) against real Kaggle
  engines — it was not re-verified against a live engine today, and it was never verified
  from inside the installed APK.
- **Engine C has never been woken.** Image/audio generation has not been proven end-to-end.
- The layout/resource link step passing (it does) proves every `@id`, `@color`, `@dimen`,
  `@drawable` and `@string` reference resolves. It does not prove the layout looks right on
  a real device.

The honest next step is yours to take: `adb install apk/aether-release.apk`, then the
wake → live → stream → tools → shutdown cycle from a real device. I cannot produce that
evidence from here, and I am not claiming it.
