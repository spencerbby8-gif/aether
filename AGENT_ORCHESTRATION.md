# Agent orchestration and decision layer

What the real decision layer was doing wrong, what changed, and what is
measured. The gates were re-run first and the browser fixes from the previous
change are confirmed intact.

---

## 1. Gates re-run at the start of this change

```
browser-reliability-fix --check   OK, every change is present
verify-engine-source              PASS (intact, secret-free, hardened)
tsc --noEmit                      0 errors
npm run lint                      0 errors / 17 warnings
vitest                            288 passed / 5 skipped / 0 failed
jvm-suite.sh                      16/16 proofs clean
browser-auth-live.py              30/30
browser-reliability-live.py       11/11 workflows, 8/8 assertions, 4.0s
```

Nothing from the browser change regressed.

## 2. What the decision layer actually was

The kernel's whole decision layer is `agent_stream` in cell 4 of the notebook
template. It had four defects, all read off the shipped code:

**a) The system prompt advertised four tools when seven were registered.**

```python
SYSMSG = ('You are AETHER, an autonomous AI agent with live tools:
           web_search, fetch_page, crawl_site, run_command. ' ...)
```

`browser`, `generate_image` and `generate_voice` were registered in `TOOLS`
but never mentioned in the prompt. The model could still see them in the tools
array — and the live measurement below shows it does use them — but the prompt
was actively telling it a smaller toolset than it had, and gave no guidance at
all on when each one applies.

**b) Tool results went back into the prompt as raw output, truncated from the
tail at 2500 characters.** A traceback sits at the *end* of a build log, so
that is precisely the part that got cut away, leaving a clean-looking success.

**c) Deduplication was an exact string match on `(name, args)`.** The same page
fetched with a trailing slash, or the same query reworded, both cost a fresh
call. And a failed action was re-runnable forever.

**d) Nothing checked the outcome.** The turn ended when the model stopped
calling tools, whether or not the file existed or the image had been written.

Parallel execution already existed (`ThreadPoolExecutor`, 4 workers) and was
left alone.

## 3. What was built

`scripts/agent-orchestration.py` — one module, exec'd into the kernel
namespace at boot from an embedded literal, so the copy the tests run against
is byte-identical to the copy that ships (`--check` asserts the round trip).

**Routing.** `route(text)` maps ordinary language to capabilities: chat,
web_search, fetch_page, crawl_site, browser, filesystem, terminal,
package_manager, code_execution, image, audio. No slash commands, no mode
switch. Returns goal, capabilities, tools, the evidence required, and steps.

**Planning.** `Plan` holds goal → evidence → tools → dependencies → order →
verification → outcome. `waves()` groups independent steps into waves that run
concurrently; dependent steps land in later waves. A dependency cycle is
reported, not looped on.

**Normalization.** `normalize(tool, raw)` returns a brief for the model and the
raw for the UI. It keeps *both ends* of command output, strips warning spam
and progress bars, numbers search results as title + source, and flags
non-zero exits. `tool_result` events carry the raw to the client.

**Budget.** `Budget` catches near-duplicates (reworded query, trailing slash,
selector case), abandons an action that has failed twice, and reports
exhaustion instead of silently stopping. **Failures are never replayed** —
handing back a cached error looks like progress to the loop and turns one
failure into an endless free retry.

**Verification.** `verify_intent` checks the artifact, not the reply: an image
needs a JPEG/PNG header on disk, audio needs RIFF, a command needs exit 0, a
file needs to exist, a package needs to import, a search needs a source URL.
The turn cannot end while evidence is unmet; it is told what is missing and
continues, bounded at two retries so a task that genuinely cannot finish still
ends.

**Failover.** `Plan.checkpoint()` / `Plan.resume()` carry goal, evidence,
per-step status, results, artifacts, timing and the next action as JSON —
small enough to send. A revived plan knows which step is next and does not redo
the finished ones.

## 4. Measured

### Routing: 20/20 ordinary-language prompts

`scripts/proofs/orchestration-live.py` section A. No model involved, so this is
deterministic and repeatable.

Five real bugs were found and fixed while getting there, each one a false
positive that would have cost a wasted tool call:

| prompt | wrong route | cause |
|---|---|---|
| "hello, how are you today?" | web_search | bare "today" treated as a web signal |
| "how much free disk space do I have?" | web_search | bare "how much" |
| "sign up on news.ycombinator.com" | +web_search | "news" inside the domain name |
| "install pandas and numpy" | missed package_manager | rule required a package-manager name |
| "install the latest version of docker" | +web_search | "version" read as a web signal |

The domain-name one is the instructive case: rules now match against the text
with URLs removed, so words inside a hostname are not read as intent.

### Planning and dependencies

Three independent research steps land in one wave; "search … and make an image
of it" chains into two, with the image waiting on the search. That second case
was broken at first — dependencies were linked while the step list was being
built, so a step only saw the ones before it, and the image rule fires before
the search rule. Linked in a second pass.

### Real execution: parallel beats serial

Three real calls (two live web searches and a page fetch), kernel's own tool
functions extracted from the shipped asset:

```
serial   1.07s
parallel 0.54s     per-call: web_search 0.54s, web_search 0.46s, fetch_page 0.07s
```

### Verification catches a task that merely returned

| check | result |
|---|---|
| "Here is your image!" with no file on disk | **rejected** |
| a real file written by a real command | verified, and the bytes are on disk |
| a command that exited 3 | caught, and the brief is flagged not-ok |
| an image claimed by URL with no bytes behind it | **rejected** |
| a real JPEG header resolved through `MEDIA_DIR` | verified |

The last two came from a real failure: the image tool wrote the file and then
raised on a missing tunnel global, so the verifier could not find an artifact
reported by bare filename. It now resolves against the media directory.

### Budget

Exact repeats, reworded queries, trailing slashes and selector case changes are
all recognised as duplicates. A selector that failed twice is abandoned. A
different selector is still allowed.

### Failover

A plan is checkpointed mid-task and revived: goal, evidence, the completed step
and its result all survive, the revived plan names the image as the next action
and does not redo the search, and it can still verify — including rejecting an
unbacked claim after the round trip.

### Combined real task

"search for what the Python Software Foundation does, save a summary to a file,
and generate an image of a python logo" — real search, real file, real command,
real image generation:

```
steps=3 done=3 waves=1 widest=3 outcome=verified
order: web_search -> filesystem -> image
budget: calls 3, replayed 0, refused 0, remaining 9
wall 0.79s
```

### The patched agent loop, run for real

`scripts/proofs/agent-loop-live.py` extracts `agent_stream` from the shipped
asset and runs it with a scripted model: **25/25**. Plan published before any
model output, tool results normalized (raw preserved, brief a fraction of it),
an identical search executed exactly once across three requests, and the
verification gate catching an image that was never written while staying
bounded.

That harness caught a regression I had just introduced: a plain chat turn
verified as "the answer is empty" and would have been nudged to keep working —
two extra model calls on a greeting. A conversation's deliverable *is* the
text, and it arrives on the no-tool path, so only conversation steps adopt it.
An image step's deliverable is a file, and letting prose stand in for one is
exactly the lie the gate exists to catch.

### Live engine: BEFORE only

Engine C was woken to v40 and answered for real, before this change:

```
search the web for today's top python news -> web_search,fetch_page   235.3s  2367 chars
generate an image of a blue cube           -> generate_image           85.7s   105 chars
what is 17 * 23? use the shell             -> run_command             106.0s    72 chars
hello, how are you?                        -> (none)                   18.8s   196 chars
```

The model already selected correctly on these simple prompts — the tools array
reaches it even when the system prompt under-sells it. So the system-prompt fix
is not rescuing a broken selector on easy cases; it matters on the ambiguous
ones, which is where the router's 20/20 is the evidence.

**There is no AFTER live measurement.** All three engines hit `Maximum weekly
GPU quota of 30.00 hours reached` partway through this work — C first refused a
push with `Maximum batch GPU session count of 2 reached`, was shut down, and
then reported quota exhaustion; A and B reported the same. The patched kernel
is built and verified locally but has never served a request from a real model.

## 5. Preserved

The browser authorization model is untouched and still enforced:
`browser-auth-live.py` **30/30** against the re-patched asset, including that
no secret value appears in any of the 36 replies. CAPTCHA, MFA and anti-bot
protections are still refused, never bypassed.

No artificial delays, no fake progress, no simulated tool results. Every
measurement above is a real call.

## 6. Gate after the change

```
tsc --noEmit                     0 errors
npm run lint                     0 errors / 17 warnings
vitest                           288 passed / 5 skipped / 0 failed
jvm-suite.sh                     16/16 proofs clean
browser-auth-live.py             30/30
browser-reliability-live.py      11/11, 8/8 assertions
orchestration-live.py            54 passed / 0 failed, routing 20/20
agent-loop-live.py               25 passed / 0 failed
```

Template pin `b80d27c0ff59379ae97c4bfc96273e475525845fec5640652413d4041c2a981d`,
rendered 166460 bytes.

## 7. Not verified

- **No live engine ran the patched kernel.** This is the biggest gap. Routing,
  planning, budgeting, normalization and verification are all proven
  deterministically, and the patched loop is proven with a scripted model — but
  whether a real model responds well to the new system prompt is unmeasured.
- **The router is a rule set, not a model.** It is right on the 20 prompts
  tested and wrong on prompts nobody wrote yet. It does not gate the model; it
  forecasts, so a model that disagrees is still free to call what it wants.
- The APK is never installed on a device — no emulator here, ever.
- Live failover across engines was proven by checkpoint round trip, not by an
  engine actually dying mid-task.
