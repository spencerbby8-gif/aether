# Aether — chat history, storage, attachments, normalisation, splash

Date: 2026-09-06 · Builds: `apk/aether-release.apk` (717 380 B) and
`apk/aether-debug.apk` (3 939 476 B) · Signed, `CN=Aether … C=NG`.

Everything below is either **run** (JVM checks, builds, artifact inspection) or
marked **NOT VERIFIED AT RUNTIME**. This sandbox still has no `/dev/kvm`, so the
APK has never been installed and no screen has ever been rendered here.

---

## 1. The shut-down control was broken. Here is what was wrong.

Your report was correct. Two defects, both in `SettingsActivity`:

**(a) The button was disabled whenever the engine was not already "LIVE".**
`render()` did `off.setEnabled(live || busy)`, and the button was created with
`off.setEnabled(false)`. Worse, `render()` only ran *after* `pollOnce()`
completed — a beacon fetch (20 s timeout) plus a health check per engine
(15 s each) plus a Kaggle status call per engine (20 s each). Opening Settings
therefore left every control in its initial state for up to ~95 seconds, with
"Shut down" greyed out the whole time. That is indistinguishable from a control
that does nothing.

**(b) "Shut down all" could do literally nothing, silently.** It iterated
`liveUrls.keySet()` — only engines with a discovered tunnel URL — and when that
map was empty it re-enabled the button and returned. No message, no state
change, no error. Pressing it produced zero feedback.

Fixes now in the build:

- The shut-down button is **enabled in every state**. When there is no tunnel to
  reach, the action reports `no live URL for this engine — it has no tunnel to
  answer on` instead of going quiet.
- Both single and "all" shut-down **ask for confirmation first**, then write the
  outcome into the note under the cards (`announce(...)`), per engine.
- `render()` is called once at startup so the cards paint immediately, and again
  **as each engine resolves** during the poll instead of after the whole sweep.
- `shutOne()` is unchanged in substance: it still calls the same
  `EngineCore.off()` + `confirmedDown()` that the 21/21 two-engine proof used, so
  OFF is only claimed once `/api/ps` stops answering.

**NOT VERIFIED AT RUNTIME:** I cannot tap the button here. What is verified is
that the code path compiles, that the handler is bound (see §8), and that the
underlying `EngineCore.off()`/`confirmedDown()` were proven live earlier against
two real engines.

## 2. Chat history drawer, new chat, rename, delete

- The header has a ☰ that opens a **history drawer** on the left: chat list,
  newest first, each row showing title · relative time · message count · engine.
- **New chat** (＋ in the drawer header) saves the current transcript and clears
  the screen.
- **Rename** and **Delete** from the ⋮ on a row, or by holding the row. Rename
  opens a text dialog; delete asks for confirmation and states that the
  transcript and its attachments are removed from the device.
- Deleting the open chat clears the screen; deleting any chat refreshes the
  drawer.

## 3. Sessions are saved on the phone

`com.aether.app.core.ChatStore`, in **app-private storage**:
`/data/data/com.aether.app/files/chats/`

```
chats/<id>.json          one transcript per chat (messages, thinking, tool lines,
                         attachments, status, engine, timestamps)
chats/index.json         light index so the drawer lists chats without reading
                         every transcript
files/attachments/       copies of picked files, named <chatId>-<n>-<name>
```

No permission, no cloud, nothing leaves the device. Uninstalling removes it.

Durability choices, all covered by the JVM check: writes go to `<id>.json.tmp`
and are renamed over the target, so an interrupted write cannot replace a good
transcript with a half-written one; a transcript that fails to parse is skipped
rather than taking the whole history with it; a missing or stale `index.json` is
rebuilt from disk; ids are validated (`[a-z0-9]{6,64}`) before becoming a path,
so a hostile id cannot escape the directory.

A turn is written when it finishes (including stopped and errored turns, which
are stored with `status` and a note) and again in `onPause`. Saves run on a
**dedicated storage thread**, not the chat thread — otherwise a ten-minute
wake-and-wait would queue every save behind it and history would look like it
was not saving.

## 4. Model output is normalised

`com.aether.app.core.TextNormalizer` runs on every streamed line before it is
displayed or stored. Out: ANSI colour and window-title escapes, zero-width and
bidi characters, BOM, emoji and pictographs (including flags and variation
selectors), stray control bytes, CRLF mixing, trailing spaces, runs of blank
lines, and markdown decoration a plain TextView would show literally
(`**bold**`, `# Heading`, `> quote`, `` `code` ``, `[text](url)`, `---` rules).

Kept, because removing them would destroy meaning: arrows, bullets, box drawing
(so tables stay readable), and the *contents* of fenced code blocks — inside
code, asterisks and hashes are content, not formatting.

Nothing rewrites meaning: no summarising, no preamble stripping, no word
substitution. What you typed is treated even more gently (`userInput()`): emoji
and markdown you wrote stay, invisible formatting goes.

## 5. File upload in the composer

Paperclip button → system file picker → the file is copied into app storage and
shown as a chip with name, size and what will happen to it; × removes it.

**The engine has no upload endpoint.** I read the kernel source in
`android/app/src/main/assets/aether-notebook-template.json`: its routes are the
Ollama proxy (`/api/*`), `/files/list` and `/files/<name>` for media it
generated, and the keyed `/off`. There is no POST that accepts a file. So the
honest behaviour, which the chip states explicitly:

- **text-shaped files** (text/*, json, xml, yaml, csv, and 25 source extensions,
  ≤ 200 KB) are read and **inlined into the prompt** under a labelled header —
  the only way this model can actually read a file;
- **binary files** are kept on the device and recorded in the transcript, marked
  *binary — kept on the device, not sent to the engine*.

If you want true upload, the engine needs a new endpoint; that is a kernel
change, and I did not make one silently.

## 6. Opening animation

`SplashActivity` is now the launcher (`aapt dump badging` →
`launchable-activity: com.aether.app.SplashActivity`). The Aether mark scales in
on an overshoot, a ring pulses out from behind it, the wordmark's letter-spacing
closes as it fades in, an accent rule draws itself underneath, the tagline fades
in, and it hands over to the chat at 900 ms. If animations are disabled
system-wide (`ANIMATOR_DURATION_SCALE == 0`) the whole thing is skipped.

It fakes no work: nothing on this screen stands in for engine activity.

## 7. Copy and retry on messages

Hold any message bubble — yours or Aether's — for a menu:

- **Copy** puts the message text on the clipboard and confirms with a toast.
- **Retry** re-sends the prompt that produced it. On an assistant reply it walks
  back to the user message above it; on your own message it re-sends that. It
  refuses while a turn is in flight rather than racing it.

The error state keeps its own "Try again" button as well.

## 8. "Every button works" — what I can and cannot show

I cannot tap anything here. What I *can* show mechanically is that no control is
left unbound. `scripts/proofs/wiring-report.py` cross-references every id a
layout declares against the listeners the activities attach, and fails if an
interactive control has no handler:

```
attach_btn     ImageView   activity_chat.xml      ChatActivity.java: OnClickListener -> pickFile.launch
back_btn       TextView    activity_settings.xml  SettingsActivity.java: OnClickListener -> finish
input          EditText    activity_chat.xml      ChatActivity.java: OnEditorActionListener -> inline
menu_btn       ImageView   activity_chat.xml      ChatActivity.java: OnClickListener -> inline
new_chat_btn   ImageView   activity_chat.xml      ChatActivity.java: OnClickListener -> newChat
off_all        Button      activity_settings.xml  SettingsActivity.java: OnClickListener -> shutDownAll
send_btn       ImageButton activity_chat.xml      ChatActivity.java: OnClickListener -> onSend
settings_btn   TextView    activity_chat.xml      ChatActivity.java: OnClickListener -> openSettings
stop_btn       ImageButton activity_chat.xml      ChatActivity.java: OnClickListener -> inline
  + built in code: session ⋮ -> sessionMenu, row tap -> openChat, row hold -> menu,
    message hold -> copy/retry, attachment × -> remove, wake -> wake,
    shut down -> confirmShutDown, routing row -> setMode

RESULT: every interactive control declared in a layout has a handler bound in code.
```

The resource link step passing proves every `@id`, `@string`, `@drawable`,
`@color` and `@dimen` resolves. Neither of those is a substitute for a finger on
a screen.

## 9. What was run

| Check | Command | Result |
|---|---|---|
| Chat core (shipped classes) | `java -cp /tmp/cc:json.jar ChatCoreCheck` | **70 passed, 0 failed** |
| Routing (shipped class) | `java -cp /tmp/rc RouterCheck` | **19 passed, 0 failed** |
| Control wiring | `python3 scripts/proofs/wiring-report.py` | every interactive control bound |
| Debug build | `gradle :app:assembleDebug` | BUILD SUCCESSFUL, exit 0 |
| Release build | `gradle :app:assembleRelease` (signed) | BUILD SUCCESSFUL, exit 0 |
| Signature | `apksigner verify --print-certs` | verified, `CN=Aether … C=NG` |
| Launcher | `aapt dump badging` | `com.aether.app.SplashActivity` |
| Core in the artifact | mapping grep | `ChatStore -> r6`, `TextNormalizer -> qk` |
| Credentials at rest | `grep -c KGAT` on the baked asset | `0` plaintext |
| TypeScript | `npx tsc --noEmit` | exit 0 |
| Lint | `npx eslint .` | 0 errors, 17 warnings (pre-existing) |
| Tests | `npx vitest run` | 31 files, 249 passed, 5 skipped |

The chat core check covers: normalisation of ANSI/OSC/emoji/zero-width/control
bytes/CRLF/blank runs/markdown/code fences/box drawing/arrows, title derivation
and its surrogate-pair boundary, session create/save/load round-trips including
thinking, tool lines, status, note, engine and attachments, newest-first
ordering, rename (trim, lock, drawer position), delete (transcript, its
attachments, not another chat's), corrupt-file tolerance, index rebuild, atomic
writes leaving no `.tmp` behind, `deleteAll`, retry-target resolution, and
rejection of traversal ids.

One real bug it caught in my own code: `deleteAll()` counted `index.json` as a
transcript and deleted it. Fixed to skip non-transcript files and rewrite an
empty index.

## 10. What is NOT proven

- **The APK has never been installed or run.** No `/dev/kvm`, no `vmx`/`svm`, so
  no emulator can start here. The drawer, dialogs, splash animation, attachment
  chips, popup menus and toast messages have **never been rendered**. Their
  layout XML and handlers are verified; their appearance and tap behaviour are
  not.
- **No engine was contacted in this turn.** All three are OFF. Streaming, web
  search, command execution, media generation, wake, failover and shut-down were
  proven earlier against real Kaggle engines (`PROOF_ANDROID_ENGINES.md`,
  `MultiEngineProof.java` 21/21) and are **not** re-verified today.
- **File upload cannot be proven end-to-end**, because the engine has no upload
  endpoint — see §5.
- Engine C has never been woken. Image/audio generation is still unproven.
- Storage behaviour is proven on the JVM against real files, not against
  Android's app-private directory on a device.

Next step is yours: `adb install apk/aether-release.apk`, then walk the flow —
send a message, hold a bubble for copy/retry, open the drawer, rename, delete,
attach a text file, and shut an engine down from Settings. I cannot produce that
evidence from here, and I am not claiming it.
