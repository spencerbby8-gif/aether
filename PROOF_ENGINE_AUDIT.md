# Engine audit — all three, real hardware, 2026-09-06

Reported symptom: *"the engine is worse than before, it can't generate text
anymore."* Verdict after auditing all three on real Kaggle GPUs: **the notebook
is not damaged and all three engines generate text normally.** The audit did find
one real defect, in the client, and it is fixed and proven — see §3.

All three engines were shut down again afterwards and confirmed not serving (§5).

---

## 1. Is the notebook damaged? No.

The kernel the APK pushes is baked at
`android/app/src/main/assets/aether-notebook-template.json`. Checked:

```
TS template bytes   : 40903 ef0c7fe7c42345b3
APK asset bytes     : 40903 ef0c7fe7c42345b3
byte-identical      : True
rendered identical  : True
kernel source equal : True 39224
```

The asset is byte-identical to `aetherNotebookTemplate()` in
`src/server/engine/aether-engine-source.ts`, and its SHA-256 matches the pinned
`AETHER_NOTEBOOK_SHA256 = ef0c7fe7c42345b3…` that the wake path verifies before
pushing. `git log` shows neither file has been touched since commit `3e1b582`,
before this round of work. Rendering the asset the way `Credentials.renderNotebook()`
does produces the same bytes as `renderAetherNotebook()`.

## 2. All three engines, ordinary prompts

`scripts/proofs/EngineAudit.java` pushed the APK's own notebook to A, B and C,
waited for `/api/ps` 200 with a loaded model, then asked each one ordinary
questions — not "reply with exactly X". **24 passed, 0 failed.**

| prompt | A | B | C |
|---|---|---|---|
| "Explain in two sentences what a GPU does." | 866 chars, 19.8 s | 802 chars, 31.9 s | 717 chars, 16.0 s |
| "Write a haiku about the ocean." | *"Silent deep water holds a world it never names…"* | *"Endless blue expanse / Whispers secrets to the shore…"* | *"Silver waves unfold, whispering against the shore…"* |
| "What is 17 multiplied by 23?" | `391` | `391` | `391` |
| "~200 words on why the sky is blue" | 3171 chars, 80 s, used web_search | 2754 chars, 71 s | 3033 chars, 74 s |
| follow-up sentence | 228 chars | 576 chars | 335 chars |

No engine returned an empty reply and none fell back to the kernel's
*"I hit my tool-step limit"* message. All three are running the same model,
`hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS`.

Note the markdown in the raw stream (`**Rayleigh scattering**`) and the emoji —
that is the model's own output, and it is what `TextNormalizer` strips before it
reaches the screen.

## 3. The real defect the audit found: every turn had amnesia

The follow-up prompt exposed it. Asked to "summarise that", engine A answered:

> *"You said 'that,' but this is the start of our conversation — there's no prior
> message or topic for me to summarise yet!"*

That is the model being correct. `EngineCore.chatStream` built its request with
**only the newest prompt**, while the kernel takes a full Ollama `messages` array
and keeps the last 24. So the APK threw the conversation away on every send:
follow-ups, "what did I mean", "continue", any reference to earlier messages —
all broken. The web app sends history; the APK did not.

**Fix.** `EngineCore.chatStream` now takes the conversation (`List<Msg>`,
oldest-first, empty and errored turns excluded, capped at 20 — inside the
engine's own 24-message window), and `ChatActivity` builds it from the saved
transcript. The single-prompt form still exists and still sends one message.

Proven two ways.

**On the wire** (`StreamProof`, 32/32) — a server that echoes the request body:

```
== the conversation before the turn is on the wire
  PASS  earlier user turn was sent
  PASS  earlier assistant turn was sent
  PASS  the new prompt is last, after two history messages (3 roles total)
  PASS  single-prompt form still sends only the prompt
```

**On a real engine** (`ContextProof`, 7/7, engine A):

```
turn 1  "My name is Ada and my favourite number is 42…"
        -> Hi Ada! Noted — your favourite number is 42.
turn 2  "What is my name?"                     -> Your name is **Ada**.
turn 3  "And my favourite number?"             -> 42
turn 4  "restate my name and my number"        -> Your name is Ada and your favourite number is 42.
control same question with NO history          -> "I don't have your name — there's no profile
                                                   or prior context provided to me"
shutdown                                       -> /off 200, confirmed terminated

CONTEXT PROOF  7 passed, 0 failed
```

The control matters: without history the model does **not** guess "Ada", so the
memory in turns 2–4 is genuinely coming from the conversation the client now
sends.

## 4. Something else the audit turned up: Kaggle can revive a kernel

Engine C was shut down during the audit — `/off` returned 200 and `confirmedDown`
verified `/api/ps` had stopped answering. Ten minutes later it was serving again
on a fresh tunnel URL, and had to be shut down a second time.

So `/off` reliably terminates the process, but it is not a guarantee that Kaggle
will not start the kernel again. The app handles this the honest way: it never
remembers a shutdown, it re-checks `/api/ps` on every poll, so a revived engine
shows as LIVE again rather than staying falsely "off". Kaggle's own kernel status
also lags — engine A read `running` for some time after it had stopped serving.

## 5. Everything is off

```
engine A: no live tunnel  |  Kaggle says: running   (status lags; not serving)
engine B: no live tunnel  |  Kaggle says: error
engine C: no live tunnel  |  Kaggle says: error
ALL OFF - no engine is serving
```

`no live tunnel` means every URL that engine has announced was probed and none
answered `/api/ps`. `scripts/proofs/AllOff.java` re-checks this and shuts down
anything it finds serving.

## 6. Build and checks

| Check | Result |
|---|---|
| Three-engine audit (real GPUs) | **24 passed, 0 failed** |
| Context proof (real engine A) | **7 passed, 0 failed** |
| Stream proof (local server, engine wire format) | **32 passed, 0 failed** |
| Chat core / routing / wiring | 70/70 · 19/19 · all controls bound |
| Debug + release build | BUILD SUCCESSFUL, exit 0 |
| Release signature / launcher | verified `CN=Aether … C=NG` · `SplashActivity` |
| Plaintext keys in the APK | `0` |

`apk/aether-release.apk` 722 268 B · `apk/aether-debug.apk` 3 952 994 B

## 7. Not proven

- The APK still has never been installed — no `/dev/kvm` here — so the history is
  proven at the `EngineCore` and wire level, not from a tapped screen.
- Only one engine was used for the context proof; B and C were audited for text
  generation and shut down before that fix existed, so their history behaviour is
  inferred from the shared client code, not measured.
- The Kaggle revival was observed once, on engine C. I have not established what
  triggers it.
