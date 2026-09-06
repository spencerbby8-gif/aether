# The switch did nothing because the buttons could never run

Reported, repeatedly: *"that engine switch isn't working properly… It can't turn
on or turn off the engine."*

The cause was not the Kaggle API, the beacon, the status classifier, or the
shutdown call. It was that **the code behind the buttons was never executed.**

---

## The defect

```java
private final ExecutorService bg = Executors.newSingleThreadExecutor();   // ONE thread

protected void onResume() {
    int gen = generation.incrementAndGet();
    bg.execute(() -> pollLoop(gen));        // task 1
}

private void pollLoop(int gen) {
    while (generation.get() == gen) {       // never returns while the screen is open
        pollOnce();
        Thread.sleep(wait);
    }
}

private void wake(...)      { … bg.execute(() -> { kernelPush(…); watchToLive(…); }); }
private void shutDown(...)  { … bg.execute(() -> shutOne(slot)); }
```

`bg` had **one** worker thread. `pollLoop` occupied it for as long as Settings was
open — which is the only time the buttons can be pressed. Every wake and shutdown
task was therefore **queued behind an infinite loop and never ran.**

What the user saw, precisely:

- **Wake** — the card changed to *WAKING — sending the kernel to Kaggle*, because
  that text is written synchronously on the UI thread *before* `execute()`. Then
  nothing. No push, no kernel, no GPU. *"It can't turn the engine on."*
- **Shut down** — the note read *Shutting down engine A…* and stayed there. The
  `/off` request was never sent. *"It can't turn the engine off."*
- **Intermittent success** — `checkNow()` and `onPause()` both bump the
  generation, which ends the loop and lets the stuck task finally run. So
  pressing *Check now*, or leaving the screen and coming back, could release a
  queued action minutes later. That is why it looked like it sometimes worked.

## Why every earlier proof missed it

`StreamProof`, `ShutdownProof`, `StatusProof`, `RouterCheck`, `ChatCoreCheck` and
the wiring report all exercise `EngineCore` and the core layer directly. None of
them constructs the Activity, so none of them ever touched that executor. The
buttons were bound (the wiring report is correct about that) — they submitted
work into a queue that could never drain. **A handler being wired is not the same
as its work being able to run.**

The pattern is a known failure mode: a task that never returns on a
single-thread executor means *"any other tasks you schedule never get run"*, and
thread-pool starvation is the standard name for it.

## The fix

```java
private final ExecutorService pollExec   = Executors.newSingleThreadExecutor(daemonFactory());
private final ExecutorService actionExec = Executors.newCachedThreadPool(daemonFactory());
```

Polling gets its own thread. Actions get a **pool**, not a single thread, because
`watchToLive()` can legitimately block for 15 minutes and must not be able to
stop a shutdown that arrives while it runs. Both are shut down in `onDestroy`,
and both use daemon threads. All six call sites were re-pointed: `onResume` and
`checkNow` to `pollExec`; wake, shutdown and shut-down-all to `actionExec`. No
`bg` reference remains in the file.

`ChatActivity` was checked for the same trap and does not have it: its poller,
its streaming turn and its storage already run on three separate executors.

## Proof — `scripts/proofs/ExecutorProof.java`, 12 passed / 0 failed

The Activity cannot be constructed on a JVM, so this reproduces the exact
scheduling — same executor types, same non-returning loop, same submission order:

```
== the old wiring: one single-thread executor for polling AND actions
  PASS  the poll loop is running  [25 polls]
  PASS  the button's work NEVER runs while the screen is open  [still queued after 5s -- this is the bug]
  PASS  it runs the moment the generation is bumped  [the loop ended, so the queued task finally executed]

== the new wiring: polling and actions on separate executors
  PASS  the button's work runs immediately  [0ms]
  PASS  polling carried on regardless  [8 polls]
  PASS  a shutdown is not blocked by a wake watch in progress  [0ms while the watch was still running]
  PASS  the wake watch was still running at that point  [blocking task in flight]

== the shipped source no longer shares one executor
  PASS  no shared 'bg' executor remains  [bg references: none]
  PASS  polling has its own executor  [2 poll submissions]
  PASS  every action goes to the action pool  [3 actions (wake, shutdown, shutdown all)]
  PASS  both executors are shut down on destroy  [onDestroy]
  PASS  worker threads are daemons  [thread factory]

EXECUTOR PROOF  12 passed, 0 failed
```

The first block is the bug reproduced; the second is the fix under the same
conditions, including the case the pool exists for.

Shipped-artifact verification, from the APK itself rather than the source:

```
$ dexdump classes3.dex | grep -A2 "name : 'actionExec'"
      name          : 'pollExec'
      type          : 'Ljava/util/concurrent/ExecutorService;'
      name          : 'actionExec'
      type          : 'Ljava/util/concurrent/ExecutorService;'
```

Re-run after the change: StreamProof **32/32**, ChatCoreCheck **70/70**,
RouterCheck **19/19**, wiring clean, debug and release **BUILD SUCCESSFUL**,
signer and launcher verified, zero plaintext keys in the baked asset.

`apk/aether-release.apk` 724 008 B · `apk/aether-debug.apk` 3 893 953 B

## Second cause found while verifying: one engine, several running versions

Engine A was found serving again 25 seconds after a confirmed shutdown, while
Kaggle reported its kernel `error`. Checking the beacon for distinct URLs rather
than the newest one:

```
engine A: 2 DISTINCT tunnel URLs announced in the last hour
   https://appears-cooked-researchers-show.trycloudflar…   3 announcements  /api/ps=530
   https://leading-myth-shows-deutschland.trycloudflare…   3 announcements  /api/ps=530
```

Two tunnels for one engine, both answering at the time. Kaggle keeps previous
kernel versions running after a new push and has no API to stop them —
kaggle-api issue #388: *"when I push a new kernel all other versions keep running
and I have to go to the website and stop them from there"*.

So shutting down only the newest announced URL left the others holding GPUs, and
the engine looked like it refused to turn off. Two changes:

- `EngineCore.urlsFor(...)` returns **every** distinct tunnel a slot announced,
  and `shutDownEvery(...)` shuts each one down, counting survivors and stale
  tunnels separately. OFF is only reported when nothing is left answering.
- `wake()` now refuses a second push while one is in flight, because a double tap
  is what creates the extra version that cannot be stopped from the API.

`scripts/proofs/MultiInstanceProof.java`, **14 passed / 0 failed**:

```
== two running instances plus a dead tunnel
  PASS  it killed BOTH running instances  [killed 2]
  PASS  the dead tunnel was not counted as a failure  [dead 1, still up 0]
  PASS  it reports everything down  [2 running instances confirmed terminated (1 stale tunnel already dead)]
== an instance that refuses to die is reported as a failure
  PASS  it does not claim success  [1 of 1 instances still answering -- …]
== urlsFor on the real beacon
  engine A: 2 distinct tunnel(s) announced in 3h
MULTI-INSTANCE PROOF  14 passed, 0 failed
```

Re-run with everything else: StreamProof 32/32, ShutdownProof 12/12,
ExecutorProof 12/12, ChatCoreCheck 70/70, RouterCheck 19/19, wiring clean, debug
and release BUILD SUCCESSFUL. `shutDownEvery` and `urlsFor` are in the release
dex. `apk/aether-release.apk` 724 584 B · `apk/aether-debug.apk` 3 963 318 B.

## Not proven

The Activity still has never run on a device here — no `/dev/kvm`. What is
proven is the scheduling mechanism, replicated with the same executor types and
the same non-returning loop, and the presence of both executors in the shipped
dex. If a button still does nothing after installing this APK, the next thing to
capture is logcat, because the remaining possibilities are on-device only.
