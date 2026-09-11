# Engine D — fourth self-hosted engine

Provisioned from scratch on a brand-new Kaggle account, cloned from the
canonical A/B/C runtime, and verified live end to end.

---

## 1. Canonical runtime, read off the working engines

Everything below was read from the shipped notebook template, not invented.
Engine D uses the identical runtime with only the account-specific values
changed.

| aspect | canonical value (A/B/C = D) |
|---|---|
| model | `hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS` |
| fallback model | `hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:Q4_K_M`, then Dolphin-Mistral-24B |
| context window | `NUM_CTX = 16384`, declared before warmup so Ollama does not reload |
| generation cap | `NUM_PREDICT = 4096` |
| serving | Ollama **v0.33.2** (zstd-aware), local `127.0.0.1:11434` |
| keep-alive | `keep_alive = -1` (model stays pinned in VRAM) |
| kernel slug | `qwen-3-8-27b-uncensored-chat` |
| health endpoint | `GET /api/ps` → `200` + non-empty `models[]` |
| chat endpoint | `POST /api/chat`, NDJSON, chunked, one JSON object per line |
| auth | every POST gated on `X-Engine-Key`; absent/wrong key → `{"status":"forbidden"}` |
| shutdown | `POST /off` → `{"status":"shutting down"}`, releases the GPU |
| beacon | webhook.site primary + ntfy backup, topic `REMOVED_BEACON_TOPIC` |
| slot tagging | every announcement prefixed `engine=<slot>` |
| tools | `web_search`, `fetch_page`, `crawl_site`, `run_command`, `generate_image`, `generate_voice`, `browser` |
| browser | real headless Chromium via Playwright, helper as a separate process |
| media | images (Pollinations), voice (Piper TTS), served at `/files/<name>` |
| orchestration | `route` / `Plan` / `Budget` / `normalize` / `verify`, exec'd at boot |
| startup | GPU probe → install Ollama → pull model → warm at 16384 → deploy agent → announce |
| failure behaviour | announce the reason, then `SystemExit(1)` so Kaggle releases the GPU |
| session | GPU T4 x2 (or P100), internet ON, 12 h runtime |

## 2. Provisioning

```
account           adaoraodoh   (derived from the API token via a push ref;
                                the token cannot read users, so a probe push
                                was used and the ref echoed the account)
kernel            /code/adaoraodoh/qwen-3-8-27b-uncensored-chat
rendered notebook 166 395 bytes, 0 unresolved placeholders, SLOT tag = 'd'
```

The notebook was rendered through the same `renderAetherNotebook()` path A/B/C
use, so it is the same template with `{{AETHER_SLOT}}` = `d`.

One side effect to note: the account probe created a private kernel named
`probe` on that account. Kaggle's REST API has no delete endpoint
(`POST /kernels/delete` returns 404), so it is still there. It is private,
empty, and holds no GPU.

## 3. Live verification — every step actually run

Engine D booted and served real traffic. Results:

| # | check | result |
|---|---|---|
| 1 | authenticate against the new account | push HTTP 200, `ref /code/adaoraodoh/…` |
| 2 | create/push the complete runtime | v1, then v2 after rewake; slot tag verified |
| 3 | start the kernel | booted in 282 s |
| 4 | live beacon | `engine=d AGENT LIVE LINK: …` + `engine=d WARM OK attempt 0` |
| 5 | health endpoint | `/api/ps` 200, 1 model |
| 6 | model actually loaded | `Qwen3.8-27B-Uncensored-GGUF:IQ4_XS`, 16.86 GB, 14.77 GB in VRAM |
| 7 | real streamed chat | "Run a shell command to compute 23*17" → answer `391`, exit 0 |
| 8 | real tool execution | `run_command` executed twice, both `ok=true` |
| 9 | browser + Playwright | `NAVIGATED https://example.com/ | title=Example Domain` |
| 10 | screenshot | PNG downloaded and checked: **1280×720**, 15 418 bytes, valid magic |
| 11 | web tools | `web_search` + `fetch_page` returned cited results |
| 12 | command execution | `echo $((23*17))` → exit 0 |
| 13 | image capability | `generate_image` → **42 881-byte JPEG**, valid magic, downloaded |
| 13b | audio capability | `generate_voice` → **103 468-byte WAV**, RIFF/WAVE magic, downloaded |
| 14 | shutdown | `POST /off` → `{"status":"shutting down"}`, `/api/ps` then 530, beacon `ENGINE OFF via UI - quota saved` |
| 15 | wake after shutdown | pushed v2, rebooted 282 s, `/api/ps` 200, chat returned `READY` |
| 16 | failover chain | walked **a → b → c → d → a**, D reached from C |
| 17 | full test suite | see §5 |

Media files were downloaded and their bytes inspected, not just trusted from
the model's reply. The orchestration layer was live on D throughout: a `plan`
event was emitted before model output, `tool_result` events carried raw and
brief sizes, and each turn ended with a `verification` event
(`{'ok': True, 'unmet': [], 'outcome': 'verified'}`).

## 4. Integration — everywhere A/B/C existed

`EngineId` was widened to `"a" | "b" | "c" | "d"` and `ENGINE_IDS` extended.
The type checker then found 8 sites; a manual sweep found 12 more it could not
see, because they were runtime data or hand-written comparison chains.

Derived from `ENGINE_IDS` where possible, so a fifth slot extends itself:

| area | file | what changed |
|---|---|---|
| failover order | `contract.ts`, `EngineRouter.java` | `ENGINE_IDS` / `ORDER` widened |
| accounts | `resolve.ts` | slot `d` reads `KAGGLE_USERNAME_D` / `KAGGLE_KEY_D` |
| kernel slug | `resolve.ts` | `ENGINE_KERNEL_D` |
| health probe | `api/engine/state/route.ts` | was hardcoded `{a,b,c}` — now derived |
| snapshot | `manager.ts` | was a hand-written `{a,b,c}` copy — now derived |
| state store | `state-store.ts` | two `["a","b","c"]` loops → `ENGINE_IDS` |
| **beacon tag** | `beacon.ts`, `resolve.ts`, `EngineCore.java` | regex `[abc]` → `[abcd]` |
| **tag validation** | `beacon.ts`, `resolve.ts` | `t === "a" \|\| …` chains → `ENGINE_IDS.includes` |
| **slot validation** | `ensure-alive/route.ts` | rejected `"d"` as malformed → derived |
| **routing mode** | `agent/stream/route.ts` | downgraded `"d"` to auto → derived |
| **stored routing** | `types.ts` `normalizeRouting` | dropped `"d"` → `PROVIDER_SLOTS` |
| Settings UI | `SettingsActivity.java` | rows + label derived from `EngineRouter.order()` |
| credentials | `Credentials.java`, `bake-credentials.sh` | slots `A,B,C,D` |
| redaction | `security.ts` | derived from `ENGINE_IDS`; verified D's key/username/kernel/URL all scrubbed |
| client types | `engine-client.ts`, `modals.tsx`, `engine-chat.ts` | `EngineSlot`, `ENGINE_SLOTS`, `EngineRouting` widened |

The four bolded rows are the ones that mattered most. Each was a hand-written
list the compiler could not check, and each would have made Engine D silently
misbehave: its beacon announcements would have parsed and then been discarded
as an unknown tag, an explicit `?engine=d` request would have been rejected as
malformed or downgraded to auto, and its tunnel URL would never have been
attributed to a slot.

Manual selection is now Auto / A / B / C / D, and the AUTO row reads
`fails over A→B→C→D` from `EngineRouter.chainLabel()` rather than a literal.
The UI still reports measured runtime state per slot (`Phase` LIVE/WAKING/OFF/
QUOTA/ERROR), never the selection as if it were liveness.

## 5. Test suite

```
vitest                      304 passed / 5 skipped / 0 failed   (was 288)
tsc --noEmit                0 errors
jvm-suite.sh                16/16 proofs clean
browser-reliability-live    11/11 workflows, 8/8 assertions
browser-auth-live           30/30
orchestration-live          54 passed / 0 failed, routing 20/20
agent-loop-live             25 passed / 0 failed
tests/engine-d.test.ts      16/16 (new)
```

Two existing tests failed after the widening and were corrected, because they
encoded the old three-slot contract as fact: `ENGINE_IDS` equal to
`["a","b","c"]`, and failover from C wrapping to A. C now advances to D.

The new Engine D suite targets the places a slot can be silently dropped:
failover position, `ENGINE_KERNEL_D`, credentials, `engineConfigured`,
secret-free error text, `ENGINE_URL_D` override, beacon attribution (all four
tunnels distinct, untagged not attributed to D), strict-`d` push using D's own
credentials, an unconfigured D being dropped rather than failing, live-D
resolution, quota reporting, and redaction of all four D secrets.

## 6. Task-state preservation across failover

Proven by checkpoint round trip. A plan mid-task (2 of 3 steps done) is
serialized to 1 341 bytes and revived:

```
goal preserved         : True
completed steps kept   : 2 of 3
their results kept     : True
files/artifacts kept   : ['/kaggle/working/lagos.txt']
evidence list kept     : True
next action            : ['image']
does NOT redo finished : True
```

The failover walk itself was driven through the real `EngineManager`:
`a → b → c → d → a`, all four slots covered before wrapping.

This is proven as a checkpoint round trip plus the manager's walk. It has not
been proven with an engine actually dying mid-request, because that needs two
live engines and A/B/C are at quota.

## 7. Security

The Kaggle key was pasted in chat, so it should be treated as exposed and
rotated. Handling in this change:

- **Never written to the repo.** `android/credentials.properties` and the
  generated `aether-credentials.dat` are both gitignored; confirmed.
- **Not in Git history.** `git log --all -S '<key>'` returns nothing.
- **Not in logs.** The key was passed through the environment and never
  echoed. `wake-engines.py` prints only the ref and a byte count.
- **Redacted.** `security.ts` scrubs `KAGGLE_KEY_D`, `KAGGLE_USERNAME_D`,
  `ENGINE_KERNEL_D` and `ENGINE_URL_D` from anything leaving the server;
  verified with a live `redactSecrets` call.
- **Engine D has no committed fallback.** A/B/C carry hardcoded keys in
  `wake-engines.py` (pre-existing, and already in Git history — they should be
  rotated). D reads `KAGGLE_KEY_D` from the environment only, so it cannot be
  committed by accident.
- **POST routes gated.** Verified: `/api/chat` without `X-Engine-Key` returns
  `{"status":"forbidden"}`.

In the APK the key is obfuscated (XOR + Base64), not encrypted. That is the
existing accepted trade-off for A/B/C and is unchanged for D — anyone who
unpacks the APK can recover all four keys.

## 8. Differences from A/B/C

Every one intentional:

1. **Account and kernel ref** — `adaoraodoh` instead of the A/B/C accounts.
   Unavoidable; it is a different Kaggle account.
2. **No committed credential fallback** — D reads the environment only. This
   is a deliberate improvement over A/B/C, whose keys are in Git history.
3. **Kernel version** — D is at v2 (v1 plus one rewake). A/B/C are at whatever
   their own history left them at. Version numbers are per-kernel and carry no
   behavioural meaning.
4. **Tunnel URL** — D announced `launched-real-participant-affiliate.
   trycloudflare.com`. Quick tunnels are ephemeral and differ on every boot for
   every engine.

No unexplained behavioural differences were found. The model, context window,
Ollama version, tool surface, API contract, beacon protocol, shutdown
behaviour and startup sequence are identical, because D runs the same rendered
template.

## 9. Not verified

- **A/B/C were not exercised live.** All three report `Maximum weekly GPU
  quota of 30.00 hours reached`. Their code paths are covered by the 304-test
  suite and the JVM proofs, but no live A/B/C request was made this session.
- **Live failover under real traffic** — proven by checkpoint round trip and
  by driving the real `EngineManager.failover`, not by an engine dying
  mid-request.
- **The APK is never installed on a device.** There is no emulator here and no
  network path to one.
- **A stray private `probe` kernel** remains on the D account; Kaggle's REST
  API offers no delete.
- **`/files/` media URLs die with the tunnel.** The screenshot, JPEG and WAV
  were verified while D was up; those URLs will not resolve after the next
  reboot.
