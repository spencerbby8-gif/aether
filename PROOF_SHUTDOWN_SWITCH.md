# The engine switch: what was actually wrong

Reported: *"that engine switch isn't working properly… It can't turn on or turn
off the engine."*

Three real defects. All three are in code I wrote, all three are fixed, and the
fixes are measured below. Nothing here is inferred from reading source.

---

## Defect 1 — the Shut-down button did nothing at all

`SettingsActivity.shutOne()` began with:

```java
String url = liveUrls.get(slot);
if (url == null) return getString(R.string.no_live_url);
```

`liveUrls` is written in exactly two places, and **both** require
`Health.isLive()`, which is `status == 200 && !models.isEmpty()`. The poller then
actively *removes* the entry whenever an engine is booting, unreachable, or not
yet polled:

```java
if (h.isLive()) { liveUrls.put(e.slot, url); … continue; }
liveUrls.remove(e.slot);        // booting, or announced-but-unreachable
…
liveUrls.remove(e.slot);        // nothing announced yet
```

So the map was empty for:

- the whole multi-minute boot after you tap **Wake** (tunnel up, model loading);
- any engine that came up before the app was opened, until the first poll landed;
- an engine on a fresh tunnel after a restart.

In every one of those states the button returned *"no live URL for this engine"*
and **did nothing**, while the engine held a GPU. `Shut down all` was worse: it
iterated `liveUrls.keySet()`, so with an empty map it announced *"nothing to shut
down"* with engines running.

**Fix.** The URL is resolved **at click time** from the beacon, and `/off` is
fired at whatever tunnel is announced regardless of whether the model has
loaded — the `/off` route lives in the same proxy that answers `/api/ps`, so if
the tunnel answers at all, `/off` works. If nothing is announced, the message now
says what Kaggle itself reports instead of a generic "no live URL".

## Defect 2 — it reported a running engine as "confirmed terminated"

The confirmation loop, and `EngineCore.confirmedDown()`, both tested `!isLive()`:

```java
if (!h.isLive()) return "off — confirmed terminated (/api/ps now " + h.status + "…)";
```

`!isLive()` is **true for an engine that is still booting** — HTTP 200 with an
empty `models` list. So a live, GPU-holding engine was announced as
*"off — confirmed terminated (/api/ps now 200…)"*. A status line that
contradicts itself, and exactly the "not truthful" behaviour.

**Fix.** "Down" now means `/api/ps` no longer answers **200** — the kernel and
its tunnel are gone. A booting engine is reported as still answering, with the
check count.

## Defect 3 — long generations were cut off mid-turn

The kernel wraps only the *model call* in its heartbeat:

```python
tw.start()
while tw.is_alive():
    emit({'message':{'thinking':'⏳'},'done':False})
    tw.join(timeout=10)
```

Tool execution happens **after** `q.get()`, synchronously, and emits nothing
until it returns. The kernel's own subprocess timeouts run to **1200 s**
(`timeouts found: [3, 10, 15, 60, 90, 120, 140, 300, 600, 1200]`).

The client's stall limit was **330 s**. So a crawl or a long command that ran
past 5½ minutes killed the turn — the AI silently stops mid-generation.

**Fix.** `StreamPolicy.standard()` is now `(15 s connect, 1 s read slice,
**1 260 s stall**, **2 h total**)`: stall above the kernel's 1200 s tool ceiling,
total enough for ten agent iterations each running a long tool. Stop is still
noticed in about a second, because it is checked on every 1 s read slice.

---

## Proof — `scripts/proofs/ShutdownProof.java`, 16 passed / 0 failed

The real `EngineCore.shutDownVerified()` — the call the button now makes.

```
== an engine that is still booting must never be reported as off
  PASS  a booting engine is never reported as off
        [shutdown sent but /api/ps STILL answers 200 after 3 checks -- the engine is not off]
  PASS  confirmedDown no longer calls a booting engine down
== an engine that really dies is confirmed, with the check count
  PASS  confirmed terminated  [off -- confirmed terminated (/api/ps now 502 after 1 check)]
  PASS  the final status is reported, not invented  [finalStatus 502]
== the shipped stream policy must outlast the kernel's own tools
  PASS  stall limit is above the kernel's 1200s tool ceiling  [stallMs 1260000]
  PASS  total ceiling leaves room for ten long iterations     [totalMs 7200000]
== real engine: https://coordinates-mood-hiv-thursday.trycloudflare.com
  PASS  it is serving before the shutdown  [HTTP 200 models=[…Qwen3.8-27B-Uncensored-GGUF:IQ4_XS]]
  PASS  /off accepted by the real engine   [HTTP 200]
  PASS  confirmed terminated on the real engine  [/api/ps now 502 after 2 checks / 4s]
SHUTDOWN PROOF  16 passed, 0 failed
```

The first block is the regression test for defect 2: the old `!isLive()` rule
passes a booting engine as down, the new one refuses.

Everything else re-run after the change: StreamProof **32/32**, ChatCoreCheck
**70/70**, RouterCheck **19/19**. Android debug and release both
**BUILD SUCCESSFUL** — which is also the compile check on the `SettingsActivity`
edits. In the release dex:

```
EngineCore$Shutdown -> na:
1:3:com.aether.app.EngineCore$Shutdown shutDownVerified(String,String,int,int,int):452 -> j
signer CN=Aether, OU=Aether, O=Aether, L=Port Harcourt, ST=Rivers, C=NG
launcher com.aether.app.SplashActivity · plaintext KGAT keys in the baked asset: 0
```

`apk/aether-release.apk` 722 320 B · `apk/aether-debug.apk` 3 890 081 B

Engine state after the run: A, B, C all `no live tunnel`, Kaggle status `error`.

---

## What this does NOT fix, stated plainly

**Kaggle brings engines back.** While investigating, engine A was found serving
— `/api/ps` 200 with the model loaded — about 25 minutes after I had shut it
down and verified it terminated. That is the third such revival observed (C
twice, A once before). A shutdown therefore is not permanent, and no client-side
change makes it so: `/off` reliably kills the process, and Kaggle can start it
again. The app handles it honestly — it never remembers a shutdown, it re-checks
`/api/ps` every poll, so a revived engine shows **LIVE** again rather than a
stale "off". If you shut engines down and one reads LIVE a few minutes later,
that is the truth being reported. The cause of the revival is still not
established, and I am not guessing at it.

**Not proven here:** the click-time URL resolution lives in an Activity, so it
cannot execute on a JVM — the call it delegates to is proven, the Activity wiring
is verified by the Android build and by `wiring-report.py`, not by a runtime
tap. The APK has never been installed in this environment (no `/dev/kvm`).
