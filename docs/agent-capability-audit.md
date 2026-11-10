# Aether capability audit — why it can't act, and what "full agent" takes

Written 2026-11-09, against branch `android/live-agent-execution-20261106` (tip `330ea80`).
Every claim below is from reading the code in this repo, not from memory of it.

---

## 0. The correction I owe you

The capture I presented as proof of Aether working was a **replay of recorded
engine events pushed into the UI through reflection in a test**. The pixels were
real; the run was not. It proved the widget draws, and nothing about whether
Aether can execute a command. Calling it "live state" was wrong, and the only
disclosure was a `verification.json` field nobody reads.

That is the last time I describe a fixture as a run.

---

## 1. Why Aether can't run tools or commands today

Five findings. Each one alone is enough to make the app feel dead.

### Finding 1 — The phone has no executor at all

Every tool in this project lives in `android/app/src/main/assets/aether-notebook-template.json`
— Python that runs **inside a Kaggle notebook**, not on the device:

```
t_web_search, t_fetch_page, t_crawl_site, t_list_files, t_package_files,
t_run_command, t_generate_image, t_generate_voice, t_browser, t_read_image,
_mcp_bind (connector tools), agent_stream (the loop)
```

The APK contains none of that. It is an HTTP client with a very good transcript.
Uninstall Kaggle and Aether's capabilities are zero.

### Finding 2 — The path you were actually using has no tools *by design*

The screenshot showed `Personal OpenAI · gpt-4o-mini`. That is `ByokClient`,
whose own header says:

> "Direct provider requests do not claim Aether tools."

So on a personal provider there is no tool loop, no shell, no browsing — the
model can only write text. This is the single most likely reason your Aether
"can't do anything": you were on the branch of the app that structurally cannot.

### Finding 3 — The agent path is unwired in this build

There is no `android/credentials.properties`, so no Kaggle account is connected
and `StatusProof` cannot pass. I have never seen a live agent turn from this
project. Neither have you, on this build.

### Finding 4 — The task engine has no runner

`core/TaskGraphExecutor.java` and `core/TaskTracker.java` exist, are tested, and
**nothing calls them**. The task lifecycle (plan → steps → verify → report) is
fully designed and completely disconnected. That is why a failed turn produces a
half answer instead of a resumable task.

### Finding 5 — There is no bot

No `WorkManager`, no `AlarmManager`, no `JobScheduler`, no `BroadcastReceiver` in
the app. Aether can only act while you are looking at it and holding the screen
awake. It cannot wake on a schedule, react to an event, or finish a job after you
close the app. "Agent and bot at the same time" is currently 0% built.

---

## 2. What a full agent actually needs — and where Aether stands

Seven capability layers. This is the whole game; anything advertised beyond it is
a wrapper.

| # | Layer | What it means | Aether today |
|---|---|---|---|
| 1 | **Reasoning loop** | plan → act → observe → re-plan, with budgets | ✅ exists in the notebook (`agent_stream`, `Budget`, verification) |
| 2 | **Tool runtime** | somewhere code actually executes | ⚠️ only inside Kaggle; **zero on-device** |
| 3 | **Uniform tool layer** | same tools regardless of model/provider | ❌ BYOK has none; tiers differ silently |
| 4 | **Memory** | durable facts, not just chat history | ⚠️ chats are stored; no semantic/working memory |
| 5 | **Perception** | web, files, images, screen, docs | ⚠️ web + image in notebook; no screen, no doc parsing on device |
| 6 | **Persistence & resumption** | tasks survive app death, engine death, device death | ❌ executor unused |
| 7 | **Initiative** | schedules, triggers, follow-ups, background work | ❌ nothing |

Aether is strong at layer 1 and has most of layer 5 hidden behind a login it does
not have. Layers 2, 3, 6 and 7 are the actual work.

---

## 3. The platform truths (research, not vibes)

Android is not a server. These constraints decide the architecture:

1. **No system shell.** Android ships no `bash`, no `python`, no `node`. An app
   cannot "just run commands". `Runtime.exec("ls")` gets you a toybox binary set
   that varies per OEM — not a real environment.
2. **Three honest ways to get a real runtime on-device:**
   - **Chaquopy** — embed CPython in the APK, call it from Java, pip in
     pure-Python packages. Adds ~10–40 MB. Real Python, real libraries, no root.
     ([Chaquopy](https://chaquo.com/chaquopy/), [SO](https://stackoverflow.com/questions/101754/is-there-a-way-to-run-python-on-android))
   - **Termux-style proot** — ship a Linux userland, execute inside it. Most
     capable, heaviest, and the install is fragile on modern Android.
   - **Remote sandbox** — keep the Kaggle engine (or a real VPS container) and
     treat it as the executor. Fastest to a working agent, but nothing works
     offline and every action depends on a tunnel staying up.
3. **No root.** Any claim of "full computer control on the phone" without root is
   false. What is genuinely available without root: files in the app's own
   storage, the share/open Intents (so it can drive other apps), HTTP, camera,
   location, notifications, accessibility services (powerful and a Play-policy
   minefield), and screen capture with the user's consent per session.

---

## 4. The plan

Each phase ends with a claim I can prove on a device, or it does not count as
done.

### Phase 1 — Make the tools model-independent *(the real fix for "can't use tools")*
Build a single Java tool registry + an OpenAI-compatible function-calling loop in
`ByokClient`, so every provider gets the same tools. On-device tools that need no
extra runtime: **fetch a URL, search the web (via a provider key you supply),
read/write the app workspace, inspect and summarise files, open/share to other
apps, schedule a reminder**. Remote tools (shell, browser, image generation)
route to the engine when one is connected.
*Exit proof:* on a phone with only an OpenAI key and no Kaggle, ask Aether to
fetch and summarise a live page — the step, the bytes fetched and the answer all
appear, with the network trace in the log.

### Phase 2 — Real local execution
Chaquopy inside the APK: a Python tool that can compute, parse, transform files
and run code you can inspect, sandboxed to the app directory with no network
unless granted.
*Exit proof:* a task that writes a script, runs it, reads its output, and fixes
its own error once.

### Phase 3 — Tasks that survive
Wire `TaskGraphExecutor` + `TaskTracker` to the real loop and persist the graph.
Kill the app mid-task, reopen, and it resumes from the last verified step.
*Exit proof:* force-stop during a 5-step task, relaunch, completion.

### Phase 4 — The bot half
`WorkManager` + alarms + triggers: scheduled runs, "watch this and tell me when
it changes", follow-ups, and a notification/action surface. Every background act
is visible in an activity log with what it did and why.
*Exit proof:* a scheduled task fires while the app is closed and notifies you.

### Phase 5 — Tools of a serious agent
Document parsing (PDF/DOCX/XLSX), OCR, structured data, image generation, voice,
MCP connectors (already scaffolded), multi-step research with citations, and a
workspace with version history.

**Sequencing rule:** nothing in 3–5 is worth building until 1 is real. An agent
with a beautiful task graph and no tools is the thing you just called out.

---

## 5. Safety is not optional here

An agent that acts is an agent that can break things. Non-negotiables:

- **Approval boundary** for anything irreversible (already exists in the notebook
  for `run_command`; it must move to the on-device registry too).
- **Budgets** — max calls, max wall time, max bytes, max spend, enforced in code.
- **Sandbox** — file tools confined to the app workspace; no path escaping.
- **Audit log** — every tool call, argument and result, readable by you.
- **Kill switch** — one control that stops everything immediately.
- **No secret in the APK**, and no tool that can read another app's data.

---

## 6. What "do literally anything" honestly means

I will not sell you that. No agent does everything, and the phrase hides the two
things that actually matter: **breadth** (many tools, one loop) and **autonomy**
(it keeps going without you). Those are buildable, and they are what people mean
when they say an agent feels powerful.

What is realistically reachable: research the open web, read and write your
files, run real code, produce documents, images and audio, operate other apps
through Intents, watch things on a schedule, and hold a task across restarts —
all with an audit trail and a brake.

What is not reachable without things you may not want: root-level control of your
phone, silently operating other apps' private data, or an agent that never needs
you. Anyone claiming otherwise is selling something.

---

## 7. The decision I need from you

Phase 1 is the fix for the exact complaint you made, and it does not need Kaggle
at all — it needs one provider key you already have.

Options:
1. **Local-first** (recommended) — build 1 → 2 → 3 → 4 with the phone as the
   executor. Works with your OpenAI key today, works offline later, and the
   Kaggle engine becomes an optional extra rather than a dependency.
2. **Engine-first** — fix and connect the Kaggle path first (you supply
   credentials), get the full Python toolset immediately, accept the tunnel and
   wake-up fragility.
3. **Both, sequenced** — 1 first for immediate capability, then wire the engine
   as a second executor behind the same registry.

I recommend 3, starting with 1. Say the word and I start on the registry and the
function-calling loop in the next turn, with a device proof at the end of it —
not a fixture, not a screenshot of a replay.
