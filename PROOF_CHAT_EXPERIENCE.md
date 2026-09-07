# Aether chat experience: what changed and what was measured

Build **1.9.0 (19)**, `apk/aether-release.apk` 732 900 bytes. Engine kernel
v29, sha256 `481a5e95d6efa38d…`.

All measurements below were taken against a real Kaggle engine over its real
tunnel, driving the shipped `EngineCore.chatStream`. No mocks, no local
stand-in server.

---

## 1. What was wrong

**Raw agent plumbing in the conversation.** Every thinking event the kernel
emitted was appended to the transcript verbatim: `⚙️ agent step 1...`, a `⏳`
heartbeat every ten seconds, `🛠️ web_search({"query": "..."})` with truncated
JSON arguments, and `↳ web_search returned 1204 chars`. A single search turn
produced 21 such lines. The kernel also streams the model's **own reasoning**
as a thinking event, and that was being rendered *and written to disk*.

**The first token waited for a throttle tick.** `showNormalized` was throttled
at 70 ms unconditionally, including for the very first token.

**The list fought the reader.** `scrollBottom()` ran on every render, so
scrolling up to re-read was impossible mid-answer.

**The composer was disabled during generation** (`input.setEnabled(false)`),
and pressing send while busy did nothing at all.

**A stream failure printed Java at the user** — `Engine error: timeout`,
`Socket closed`.

---

## 2. What it does now

`core/AgentActivity` maps the kernel's real events to short human activity:

| engine event | shown as |
| --- | --- |
| `🛠️ web_search({"query":"Nigeria top news headline today"})` | **Searching the web** · Nigeria top news headline today |
| `🛠️ fetch_page({"url":"https://www.premiumtimesng.com/…"})` | **Reading a source** · www.premiumtimesng.com |
| `🛠️ crawl_site({...})` | **Reading sources** |
| `🛠️ run_command({...})` | **Running a command** |
| `🛠️ generate_image({...})` | **Generating an image** |
| `↳ web_search returned 1204 chars` | closes that row with its duration |
| `⚙️ agent step N...` | *nothing* — it only licenses the word "Thinking" |
| `⏳` | *nothing* — proof of life, not an activity |
| the model's reasoning | **dropped**, and no longer stored |

Nothing is invented: `feed()` returns false for anything it does not
recognise, so a step exists only because the engine announced one. There is no
timer that manufactures "Searching the web".

The strip is one compact line that pulses **only while an event says something
is happening**, and the animation is cancelled the instant the turn ends. Tap
it to expand the real steps with their durations; when the turn finishes it
collapses to a summary like `Searched the web × 4 · Read a source · 11s`, and
disappears entirely on a turn that used no tools.

Real sources become small cards showing the host; the full URL is kept and
opens on tap. The evidence survives, the plumbing does not.

The first real token renders immediately; later tokens stay throttled at 70 ms.
The list follows the answer only while the reader is already within 140 dp of
the bottom. Fenced code renders as monospace in a horizontal scroll, laid out
once when the turn ends rather than on every token. The composer stays
typeable during a turn, and sending while busy says why instead of doing
nothing.

---

## 3. Measured, against the live engine

### A real captured turn (`scripts/proofs/output/real-agent-events.ndjson`)

```
t+  208ms  ⚙️ agent step 1...
t+  208ms  ⏳
t+10209ms  ⏳                    <-- a 10-second silent gap
t+11618ms  🛠️ web_search({"query": "Nigeria top news headline today"})
t+14358ms  ↳ web_search returned 1204 chars
t+14358ms  ⚙️ agent step 2...
t+17428ms  "The"                 <-- first token
t+49661ms  done:true
```

That 10-second gap is hard evidence for the previous fix: the shipped socket
read timeout used to be **1 s**, so it fired on every turn. It is now
1 260 000 ms.

`AgentActivityCheck` replays this file: **41 passed, 0 failed** — 21 engine
events collapsed into 5 rows, every label short and human, no JSON and no tool
identifier in any rendered string, the real source URL preserved for citation,
and the model's reasoning dropped.

### Lifecycle (`scripts/proofs/ChatLifecycleProof.java`) — 20 passed, 0 failed

```
engine A found in 1335ms
time to first byte (response headers): 277ms

plain turn       first event 166ms, first token 6130ms, 44 content deltas
search turn      completed, 7 activity steps, sources [guardian.ng, arise.tv]
command turn     completed
stop mid-turn    aborted, 4175ms (4s deliberate delay + ~175ms), partial kept
long-context     "You asked me about the capital of France."
```

44 separate content deltas on one answer is the proof that tokens really
stream; nothing is being buffered and replayed.

### Stress: 20 consecutive turns in one conversation

```
 20 completed, 0 error, 0 left without a terminal state
```

| turn | state | total | time to first token |
| --- | --- | --- | --- |
| 1 | completed | 2 462 ms | 1 933 ms |
| 2 (web_search) | completed | 19 122 ms | 12 235 ms |
| 3 (run_command) | completed | 14 970 ms | 12 218 ms |
| 4 | completed | 8 824 ms | 8 193 ms |
| 5 (web_search) | completed | 10 743 ms | 2 288 ms |
| 6–10 | completed | 2 707–10 833 ms | 2 172–3 360 ms |
| 11–20 | completed | 11 960–20 270 ms | 11 325–11 805 ms |

Turns 11 onward are slower because the conversation has grown — the kernel
sends the last 24 messages, so time-to-first-token settles around 11.5 s. That
is the engine thinking, not the client waiting, and every turn still reached a
terminal state.

### Existing suite, re-run

ChatCoreCheck 70/0 · RouterCheck 19/0 · ExecutorProof 13/0 · StreamProof 32/0 ·
StreamTimeoutProof 13/0 (its three real-engine assertions skip without a live
engine) · `scripts/verify-engine-source.mjs` PASS.

---

## 4. A correction I owe

Earlier in this session I reported "the engine cannot stream" on the strength
of six failed streaming calls, and changed the kernel's model path from `curl`
to `http.client` because of it. **That conclusion was wrong and the evidence
was mine, not the engine's.** Both `capture-agent-events.py` and `TtfbProbe`
sent `"model":"x"`. The kernel forwards a client-supplied model straight to
Ollama, so every call returned `HTTP 404 {"error":"model 'x' not found"}` —
which the old kernel reported as the generic `(model timeout/error)`. The
Android client never sends a model field, so **none of this ever affected a
device.**

The `curl` → `http.client` change is therefore *not* a proven fix for
anything. It stays for two honest reasons: it removes a subprocess and a proxy
dependence from the model path, and surfacing the real error is what exposed
this mistake. The kernel also now retries once without streaming before giving
up, and marks such a reply `fallback-non-streaming` so it can never be
mistaken for a streamed one.

Likewise, the claim that Android's `HttpURLConnection` is OkHttp and that a
read timeout there is fatal is **reasoned from the two exact error strings the
device reported plus one corroborating report**, not verified against OkHttp
source. It does not need to be true for the fix to be right: the engine is
silent for 10 s and the shipped read timeout was 1 s, which is indefensible on
any runtime.

---

## 5. What is still unverified

- **The pixels.** No emulator can run here, so the activity strip, the code
  blocks and the source cards have never been rendered. The mapping and the
  lifecycle are proven; the visual result is not. That needs your phone.
- **`generate_image` and `generate_voice`** were not exercised in this run.
- **The Next.js web app was not touched.** This pass was the Android app,
  because that is what you install and test. The web streaming route is
  unchanged and unmeasured.
- **Image/audio generation, Netlify deploy**, and a real Kaggle quota refusal
  remain unproven, as before.

---

## 9. Re-audit — two real defects found and fixed

I re-checked my own work instead of trusting it. Both findings below are things
I had reported as done.

### 9.1 The web gate was never re-run after the kernel change — and it was failing

Rewriting the engine template invalidated two pinned assertions. I had not run
the suite after that change.

```
× exposes the pinned SHA-256 of the stored template
× renders to a stable size and stays valid JSON
   AssertionError: expected 43521 to be 40875
```

Both pins were stale, not broken: the template genuinely grew because the model
path stopped shelling out to curl. Updated to the real values —
SHA `481a5e95d6efa38d…`, rendered size **43521**, which
`scripts/verify-engine-source.mjs` computes independently.

```
Test Files  31 passed | 1 skipped (32)
     Tests  249 passed | 5 skipped (254)
tsc --noEmit exit 0        eslint exit 0 (warnings only, all pre-existing)
```

### 9.2 The code-block renderer was dead code

Directive step 8 asked for excellent code blocks. I built them — and they could
never run.

`renderAnswer` split `TextNormalizer.normalize(raw)` on ``` fences. The
normaliser deletes fence markers on purpose. Proof, printed by
`AnswerBlocksCheck`:

```
TextNormalizer really does delete the fence -> contains ``` = false
...so splitting NORMALISED text yields no code block
   -> TEXT[Here you go:\n\nprint('hi')\n\nDone.]
splitting the RAW text does yield one
   -> TEXT[Here you go:] | CODE[print('hi')] | TEXT[Done.]
```

So every code answer was rendering as flattened prose — worse than useless,
because it silently contradicted what I claimed was working.

Fix: splitting moved into `core/AnswerBlocks.java` and now runs on the raw text
before normalising. Prose blocks are normalised; code blocks keep their content
and only lose ANSI escapes and invisible characters. While I was there I fixed
two more things the old splitter got wrong:

- **Unbalanced fences.** A single stray ``` made the rest of the answer a code
  block (`"a```b".split("```")` → 2 parts, index 1 treated as code). Now a fence
  count below 2 stays prose, and with an odd count the unclosed tail is prose.
- **Adjacent prose merging.** Text either side of an empty fence used to become
  two TextViews. It is one paragraph now.

`AnswerBlocksCheck`: **21 passed, 0 failed**, covering the dead-path proof,
language-tag stripping, verbatim preservation of `*`, `#` and backticks inside
code, indentation, unbalanced and odd fences, empty/null input, and that prose
is still normalised and emoji-stripped.

### 9.3 Suite after the fixes

```
AnswerBlocksCheck   21 passed, 0 failed     (new)
AgentActivityCheck  41 passed, 0 failed
ChatCoreCheck       70 passed, 0 failed
RouterCheck         19 passed, 0 failed
StreamProof         32 passed, 0 failed
ExecutorProof       13 passed, 0 failed
StreamTimeoutProof  13 passed, 0 failed
                    ---------------------
                    209 passed, 0 failed
```

`:app:compileDebugJavaWithJavac` BUILD SUCCESSFUL.
`verify-engine-source.mjs` PASS.

**APK rebuilt: `apk/aether-release.apk`, 1.9.1 (20), 733,108 bytes.** Verified
in the shipped artifact: `bg_code` present in resources.arsc, **0** plaintext
`KGAT_` strings, **0** beacon/telemetry tokens.

Still unverified, unchanged: this APK has never been installed. There is no
emulator possible in this sandbox, so the code blocks, activity strip and source
cards have still never been seen rendering on a device.

---

## 10. The HTTP 500 on multi-tool turns — found, reproduced and fixed

Reported from a real device: the turn ran a web search, showed the activity
strip, then failed with

```
(engine error: HTTP 500 {"error":"{\"error\":{\"code\":500,\"message\":\"\\n------------\\n
While executing CallExpression at line 100, column 24 in source:
...lti_step_tool %}↵    {{- raise_exception('No user quer)
```

### 10.1 Root cause, read off the running engine

I pulled the model's real chat template from the live kernel (`POST /api/show`,
8 952 bytes, 170 lines) instead of guessing at it. Lines 88–100:

```jinja
{%- set ns = namespace(multi_step_tool=true, last_query_index=messages|length - 1) %}
{%- for message in messages[::-1] %}
    {%- if ns.multi_step_tool and message.role == "user" %}
        {%- set content = render_content(message.content, false)|trim %}
        {%- if not(content.startswith('<tool_response>') and content.endswith('</tool_response>')) %}
            {%- set ns.multi_step_tool = false %}
{%- if ns.multi_step_tool %}
    {{- raise_exception('No user query found in messages.') }}
```

The template scans **backwards** for the last `user` message that is *not*
wrapped in `<tool_response>`. Tool results are rendered as user turns
wrapped in that tag (line 148–153), so they never satisfy the check. If the
window contains no plain user message, the whole request dies.

The kernel sent `msgs[-24:]`. Once a conversation plus its tool traffic passes
24 messages, the user's actual question is sliced off — and every subsequent
request 500s. A search-then-fetch-then-run turn appends two messages per tool
call, so 12 tool calls is enough on their own.

### 10.2 Reproduced against the live engine

`scripts/proofs/template-error-repro.py`, against the deployed kernel:

```
window length: 24 | unwrapped user messages: 0
BROKEN window (no user)  -> (engine error: HTTP 500 {"error":"{\"error\":{\"code\":500,...
                            raise_exception('No user quer)      <- byte-identical to the report
FIXED window (user kept) -> calling a tool  OK
```

### 10.3 The fix

`history_window()` replaces both `msgs[-24:]` call sites. It always keeps the
system prompt and the newest real user query, then adds older history back in
complete assistant/tool pairs. The message cap governs **only** older history:
the current turn is sent whole, because dropping its tool results would blind
the model to output it just asked for. The real context guard is a character
budget that trims oversized tool results instead.

`scripts/proofs/history-window-check.py` — **12 passed, 0 failed**, including
the assertion that the old slice yields `users = 0` on the failing shape.

### 10.4 Verified on the real deployed engine

Kernel v32 pushed after `AllOff` confirmed nothing was serving; boot 261 s.
`scripts/proofs/MultiToolTurnProof.py` drives the shipped `/api/chat`:

```
tool #1..#12  web_search x6 + run_command x6, one per state
tool calls: 12 -> messages appended: 24 -> conversation at the final iteration: 26
under the OLD slice msgs[-24:] the question WOULD have been dropped
elapsed 92.4s | content deltas 75 | done:true True
RESULT: PASS
```

`scripts/proofs/HistoryTurnProof.py` (prior turns + one multi-tool turn):
9 tool events, 44 content deltas, first token 10.6 s, `done:true`, no errors.

Web gate after the template change: **249 passed, 5 skipped**, `tsc` 0.
`verify-engine-source.mjs` PASS (46 303 B stored / 46 275 B rendered).
APK **1.9.2 (21)**, 734 136 B — the embedded notebook hashes to `44fe57b2…` and
contains `history_window`.

### 10.5 One honest caveat about that first run

My first end-to-end run passed with only 9 tool calls. That turn reached 28
messages, but the question sat at index 9, so it was still inside the last-24
window — **the old code would have survived that input too.** It proved the
fixed engine works; it did not prove the fix. `MultiToolTurnProof.py` above is
the one that actually crosses the threshold.

### 10.6 Also observed, not caused by this change

The first instance I pushed (v31) announced, served `/api/ps` with models, then
went unreachable when its Cloudflare quick tunnel dropped; Kaggle still reported
the kernel `running`. The heartbeat lives in notebook cell 5, which this change
does not touch. Shutting everything down and re-pushing produced a clean
instance. Quick tunnels dying under a live kernel is a known failure mode here,
and it is what makes the app re-discover the engine on every send.
