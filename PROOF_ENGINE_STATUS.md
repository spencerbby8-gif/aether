# Engine status truth

Reported: *Settings shows "announced but unreachable (HTTP 530/-1)" for A/B/C,
which is misleading — a beacon announcement only proves a URL was published, not
that the engine is alive.*

That was correct, and it was my bug. Reproduced with real network calls, root
cause identified, pipeline rebuilt, and verified against the live engines.

---

## 1. Reproduced, with the real responses

Queried the beacon exactly as the app does (`since=10800s`, the app's own 3-hour
window) and health-checked the newest URL per slot:

| engine | newest announcement | `/api/ps` | old UI text |
|---|---|---|---|
| A | 3 min ago | **HTTP 200** with a loaded model | `LIVE` |
| B | 128 min ago | **HTTP -1** (DNS does not resolve) | `announced but unreachable (HTTP -1)` |
| C | 127 min ago | **HTTP -1** | `announced but unreachable (HTTP -1)` |

B and C were **off** — Kaggle reported both kernels `error`. The UI was showing
an error produced entirely by a two-hour-old Cloudflare hostname.

**Stale-state source:** `BEACON_LOOKBACK_S = 3 * 3600`. The lookback window
outlives the engines, so every dead engine kept matching its own old
announcement, and `pollOnce()` turned the resulting 530/-1 into the engine's
status. Worse, the poller re-read the same dead URL every 15 seconds and
re-printed the same error.

## 2. The rebuilt pipeline

`pollOnce()` now runs five steps per engine, in order:

1. **Resolve** — collect the newest announcement per slot. This is a *candidate
   list*, never a status.
2. **Obtain a URL** — the newest announcement, else the last one that actually
   answered.
3. **Health-check** — `GET /api/ps`. This is the only evidence that counts.
4. **Drop stale tunnels** — any URL that does not answer 200 is removed from
   `tunnels` and `liveUrls` immediately, so the next poll re-resolves instead of
   re-reporting the same dead hostname.
5. **Classify** — `EngineCore.classify(...)`. Kaggle's kernel status is consulted
   *only* when nothing answers, and only to tell WAKING from OFF.

## 3. The phases, and what each one requires

| Phase | Required evidence |
|---|---|
| **LIVE** | `/api/ps` returned **200 with at least one model**. Nothing else earns it — not an announcement, not an accepted push, not "selected". |
| **WAKING** | A push was accepted, or Kaggle says `queued`/`running`, or the kernel answers 200 with no model yet. |
| **OFF** | Nothing answers `/api/ps` **and** Kaggle reports the kernel gone — or a shutdown was confirmed at the engine. |
| **QUOTA** | Kaggle refused a push for quota or limits (429, or a quota/limit message). |
| **ERROR** | **Only** an action the user just triggered actually failed. |

A dead tunnel returning **530**, or failing DNS with **-1**, is never ERROR. It
falls through to Kaggle's status and becomes OFF or WAKING.

Two ordering rules that took a live failure to get right:

- A `/api/ps` 200 beats everything, so an engine that came back on its own shows
  LIVE even if a shutdown is on record.
- A shutdown **confirmed at the engine** outranks Kaggle's kernel status, which
  lags — see §5.

## 4. Per-engine state, and "selected" is not "LIVE"

Each slot keeps its own `EngineState`: phase, evidence, the model list, the
tunnel (internal only) and `verifiedAtMs`. The card renders
`BADGE · checked 12s ago` over the evidence line, so the age of the measurement
is visible.

The routing list draws two separate facts on one line —
`● Engine B — pinned, no failover · OFF   (selected — routing only)`. Choosing an
engine decides where traffic goes; it says nothing about whether that engine is
running, and the row now says so explicitly.

No raw Cloudflare URL can reach the screen: `EngineState` scrubs URLs in its
constructor and `announce()` scrubs again, so the guarantee does not depend on
every caller behaving.

## 5. The proof found a bug in my own first version

Run 1 (engine B) failed one check:

```
PASS  shutdown confirmed on the real engine  [/api/ps now 502 after 2 checks]
FAIL  after a confirmed shutdown it reads OFF  [waking - kernel running, engine not answering yet]
```

The shutdown had been confirmed at the engine, but Kaggle's kernel status still
read `running`, and the classifier trusted it — so the card would have shown OFF
for one frame and flipped back to WAKING on the next poll. Fixed: the client
records the time it watched `/api/ps` stop answering, and that measurement
outranks the lagging control-plane field. It is dropped the instant an engine
answers 200 again, and cleared when a wake starts, so it can never hide a revived
engine or a boot in progress.

## 6. Verified against the real engines — `StatusProof`, 33 passed / 0 failed

`scripts/proofs/StatusProof.java`, verbatim transcript in
`scripts/proofs/output/status-proof-2026-09-06.txt`.

Real classification of all three at once:

```
engine A: newest announced tunnel -> /api/ps HTTP 200 | Kaggle says "running"
    -> LIVE  live - …Qwen3.8-27B-Uncensored-GGUF:IQ4_XS
engine B: newest announced tunnel -> /api/ps HTTP 530 | Kaggle says "error"
    -> OFF   off - nothing answering, Kaggle reports the kernel terminated
engine C: newest announced tunnel -> /api/ps HTTP -1  | Kaggle says "error"
    -> OFF   off - nothing answering, Kaggle reports the kernel terminated
PASS  no engine is in ERROR on the strength of a dead tunnel  [0 in ERROR]
```

Real transition on engine C (engine B was taken through the same in run 1):

```
before: OFF
PASS  the wake push was accepted by Kaggle  [versionNumber 8, dyceelvk/…]
PASS  an accepted push reads WAKING, not LIVE
      14 min left -> WAKING  waking - kernel running, engine not answering yet
      [... further WAKING polls, one every 15 s ...]
      10 min left -> LIVE    live - …Qwen3.8-27B-Uncensored-GGUF:IQ4_XS
PASS  it was observed WAKING before it was LIVE
PASS  it became LIVE only on a real /api/ps 200 with a model
PASS  shutdown confirmed on the real engine  [/api/ps now 502 after 2 checks]
PASS  after a confirmed shutdown it reads OFF
PASS  it does not claim OFF from Kaggle's lagging status alone
PASS  a revived engine is LIVE even with a shutdown on record
PASS  a new wake is not shadowed by an earlier shutdown
STATUS PROOF  33 passed, 0 failed
```

Also re-run after the change: StreamProof **32/32**, ShutdownProof **12/12**,
ChatCoreCheck **70/70**, RouterCheck **19/19**, wiring clean. Debug and release
**BUILD SUCCESSFUL**; `EngineCore$EngineState`, `classify`, `scrubUrls` and
`isQuotaRefusal` are present in the release dex; signer, launcher and zero
plaintext keys re-verified.

Engine state afterwards: A, B, C all `no live tunnel`, Kaggle `error`.

## 7. Not proven

- **QUOTA has never been triggered by a real Kaggle refusal.** The classifier's
  QUOTA path and `isQuotaRefusal(429, …)` are proven with a synthetic action; I
  have not exhausted anyone's GPU quota to observe a genuine refusal, so that one
  branch is unverified against Kaggle's actual response body.
- The Activity that renders these states has never run on a screen — no
  `/dev/kvm` here. The classification, the resolution and the transitions are
  proven against real engines; the pixel layout is verified only by the Android
  build and the wiring report.
- Kaggle still restarts kernels on its own (engine A came back twice during this
  session, each time found serving and shut down again). The status pipeline
  reports that truthfully rather than hiding it, but it cannot prevent it.
