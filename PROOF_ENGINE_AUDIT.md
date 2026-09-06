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

The control matters: without history the model does **not** answer "Ada", so the
memory in turns 2–4 is genuinely coming from the conversation the client now
sends.

### Correction to that control, found on cross-check

Run again on **engine B** (7/7, same results: `Your name is Ada.`, `42`, `Your
name is Ada and your favourite number is 42.`), the control answered:

> *"Your name is **Sally** — that's what your system username shows."*

So the original check name — *"without history it does not invent a name"* — was
a false claim that happened to pass, because it only tested for the absence of
"Ada". The model did invent a name; it pulled one out of the container's
environment. The assertion is now stated as what it actually proves (*"does not
know the fact from earlier turns"*, plus the same for the number), and the answer
is printed so it can be read rather than trusted.

Worth knowing on its own: given no context, this model will guess from whatever
the execution environment leaks. That is engine behaviour, not a client bug, but
it is the kind of thing that reads as "the AI is making things up".

## 4. Something else the audit turned up: Kaggle can revive a kernel

Observed **twice**, on two different engines:

- Engine C was shut down during the audit — `/off` 200, `confirmedDown` verified
  `/api/ps` had stopped answering. Ten minutes later it was serving again on a
  fresh tunnel URL, and had to be shut down a second time.
- Engine A did the same later: confirmed terminated, then found serving again on
  the next check, and shut down a second time.

So `/off` reliably terminates the process, but a single shutdown is **not** a
durable guarantee that nothing is running afterwards. What triggers the revival
is not established — the candidates are a second queued kernel run from an
earlier push, or Kaggle restarting the run; I have not distinguished them and am
not guessing.

What is verified is the recovery: after the second shutdown of each, three
separate checks over five minutes (`scripts/proofs/AllOff.java`) all reported no
live tunnel for any engine, and Kaggle's own status settled to `error` for all
three. The app handles this the honest way — it never remembers a shutdown, it
re-checks `/api/ps` on every poll, so a revived engine shows as LIVE again
instead of staying falsely "off". Kaggle's status also lags in the other
direction: engine A read `running` for some time after it had stopped serving.

**Practical consequence for you:** after shutting engines down from the app,
glance at Settings a few minutes later. If one shows LIVE again, it came back on
its own and needs shutting down again — that is the truth being reported, not a
stale label.

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

Re-run end to end after the fix, not carried over from an earlier run:

| Check | Result |
|---|---|
| Three-engine audit (real GPUs) | **24 passed, 0 failed** |
| Context proof, engine A (real) | **7 passed, 0 failed** |
| Context proof, engine B (real) | **7 passed, 0 failed** |
| Stream proof (local server, engine wire format) | **32 passed, 0 failed** |
| Chat core / routing / wiring | 70/70 · 19/19 · all controls bound |
| Debug + release build | BUILD SUCCESSFUL, exit 0 |
| TypeScript · Lint · Tests | 0 · 0 errors/17 warnings · 249 passed |

Artifact cross-checks — the claims above are about the APK that exists, not about
source that was edited:

```
EngineCore$Msg -> ma                                    (history type is in the release dex)
chatStream(String,String,java.util.List,String,String,
           boolean[],ChatListener,StreamPolicy)          (the history overload shipped)
assets/aether-notebook-template.json in the APK:
  bytes 40903  sha256 ef0c7fe7c42345b3f626bd03de6e2ca28f9890a2c50379570c0a18c2b0c29919
  MATCH against the pinned AETHER_NOTEBOOK_SHA256: True
signer  CN=Aether, OU=Aether, O=Aether, L=Port Harcourt, ST=Rivers, C=NG
launch  com.aether.app.SplashActivity   minSdk 26
plaintext KGAT keys in the baked asset: 0
```

`apk/aether-release.apk` 722 268 B · `apk/aether-debug.apk` 3 952 994 B

## 7. Not proven

- The APK still has never been installed — no `/dev/kvm` here — so the history is
  proven at the `EngineCore` and wire level on two real engines, not from a
  tapped screen.
- Engine C was audited for text generation but not re-run through the context
  proof, so its history behaviour rests on the shared client code (identical for
  all three) plus the measurements on A and B.
- The Kaggle revival was observed twice but its cause is not established.
- Nothing here exercised image or audio generation, or failover between engines
  under the new history path.
