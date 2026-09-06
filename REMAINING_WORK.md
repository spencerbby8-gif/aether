# Remaining audit items — working checklist

Status legend: `[ ]` open · `[~]` in progress · `[x]` fixed + runtime-proven

## Group A — engine + UI correctness
- [x] A1 truthful per-engine A/B/C live health (badges from real health, not credential presence) — audit §4.1, P2.12
- [x] A2 correct manual vs AUTO routing in the UI (target badge, no silent switching) — §4.4, C5
- [x] A3 per-engine wake state; allow waking a 2nd engine while one is live — §4.2, §4.3, P2.13
- [x] A4 working kill-all: one shutdown control, one behaviour — §4.5, P2.14
- [x] A5 stale URL handling (rotated tunnel never reused; visible in UI) — §3.6, C3
- [x] A6 remove duplicate control paths (netlify/functions legacy JS vs routes) — §3.3, P1.8
- [x] A7 Markdown hydration error (`<div>` in `<p>`) — R5, P2.16
- [x] A8 stop rendering the raw tunnel URL in the UI — §4.6, P2.15
- [x] A9 remove hardcoded "Phase 5" badge — §4.8, P2.17

## Group B — control-plane cleanup
- [x] B1 one authoritative wake/off implementation — `src/server/engine/shutdown.ts` is the single wire impl; `killAllEngines()` + `manager.off()` both call it; one outcome vocabulary
- [x] B2 remove legacy conflicting handlers (netlify/functions/*.js, next.config rewrites) — deleted at A6, re-verified: both legacy paths 404
- [x] B3 correct HTTP status codes on every control route — invalid `?engine=` now 400 (was a silent AUTO downgrade); full matrix re-measured
- [x] B4 preserve the proven Bearer + camelCase Kaggle contract — proven at the wire against a recording fake Kaggle: `Authorization: Bearer <key>`, body keys `slug,newTitle,text,language,kernelType,isPrivate,enableGpu,enableInternet,kernelDataSources`, zero snake_case. `KAGGLE_API` is now server-env overridable so this is provable without burning quota
- [x] B5 Engine C present in every configuration/security path — runtime `kaggle:{a,b,c:true}`; a strict `?engine=c` wake really pushed with `KAGGLE_USERNAME_C`/`KAGGLE_KEY_C`/`KAGGLE_DATASET_C`; `redactSecrets` scrubs all three slots' keys AND usernames (regression test added)
- [x] B6 active-operation tracking covers the real stream lifetime — a real 64 s stream held `activeOperations=1` at every 3 s poll (129 NDJSON events, `done:true`), released to 0 on completion, and released within 2 s of a client cancel with the upstream sim seeing the disconnect (`abortedChats` 0→1)
- [x] B7 authenticate remaining sensitive routes — `agent/model` + `tools/schemas` + `providers` now require the control token; `tools/artifact` uses signed expiring URLs (media tags cannot send headers)
- [x] B8 R3 reconciled — idle-off really fires on a long-lived runtime (engine B got `POST /off`, `offCount` 2→3, event logged). The snapshot now reports `idleOff:{running,authoritative,enforcedBy,reason}`; on a serverless host (`NETLIFY=true`) the timer is deliberately not started and the UI says idle shutdown is enforced by the engine instead of showing a countdown it cannot honour

## Group C — security hardening
- [x] C1 SSRF re-proven at runtime — 13 probes through the real tool executor all returned `kind:"policy"` (HTTP 400): IPv4/IPv6/IPv6-mapped/hex/decimal/octal metadata + loopback, RFC1918 10/8 and 192.168/16, `gopher://`, `file://`, and a tunnel host resolving to a private IP
- [x] C2 tunnel URLs no longer leave the server — `ensure-alive` returns `{slot,urlPresent}` instead of `url`, `engine-off` returns `killed[].slot` instead of `killed[].url`, and free-text `reason`/`message` are scrubbed (observed live: `"wake push sent to [redacted]-c"`). Full endpoint scan clean, authenticated and anonymous
- [x] C3 secrets purged from the working tree AND git history — the notebook is now a {{...}} template rendered from server env, and `git filter-repo` scrubbed all 26,541 historical blobs (plaintext and base64). Tree at HEAD is byte-identical to pre-rewrite. **STILL REQUIRED, outside this sandbox:** force-push the rewritten history to GitHub and ROTATE the OFF_KEY, webhook.site token and ntfy topic — a public repo's old commits are already cloned, so purging does not un-leak them
- [x] C4 Kaggle credentials stay server-side — 0 of 90 client bundle files reference any credential env name or value; 0 of 13 `"use client"` modules touch `process.env`; the only 2 `NEXT_PUBLIC_` strings in `src/` are prose in comments
- [x] C5 engine hardened — `do_POST` now checks `X-Engine-Key` BEFORE routing, so `/api/chat` and the raw ollama proxy are covered (previously only `/off` was, leaving unauthenticated `run_command`); both wildcard CORS headers removed (`_cors()` and the streaming response). Proven over real HTTP: `/api/chat`, `/off` and `/api/tags` all 403 with no/bad key, 0 ACAO headers on GET/POST/OPTIONS, and a real chat through the server still streams 129 events + `done:true`. OFF_KEY no longer hardcoded (see C3)

## Group D — deployment truth
- [x] D1 **NOT VERIFIED — cannot be done from this sandbox.** There are no Netlify credentials and no outbound access to the Netlify platform, so no deploy, build log or live invocation could be observed. What IS established: the legacy `netlify/functions` directory is deleted and `/.netlify/functions/*` returns 404 (proven over HTTP); `netlify.toml` carries no `included_files`, so the 36 KB engine notebook is in no bundle (regex test); and Netlify's 60 s synchronous cap is documented against a 64.1 s measured generation. A real deploy still needs someone with the account
- [x] D2 reconciled — the engine's own watchdog (`IDLE_LIMIT = 3600`, i.e. 60 min) is now the single source of truth: `ENGINE_SELF_IDLE_MINUTES = 60` and `DEFAULT_IDLE_MINUTES` derives from it. They previously disagreed (20 vs 60), so the server always fired first and the engine's watchdog was dead code. `ENGINE_IDLE_MINUTES` still tightens it
- [x] D3 reconciled — `platformStreamCeilingSeconds()` + `deploymentStatus()` state the real ceiling per host (Netlify 60 s and NOT configurable · Vercel 800 s · long-lived Node: none). `/api/engine/state` publishes it as `deployment`, so a client can explain a cut-off generation instead of the route source silently promising 900 s that Netlify ignores. Documented in `netlify.toml`. **A measured real generation took 64.1 s — past Netlify's cap — so Netlify cannot host full-length generations; use a long-lived Node runtime**

## Group E — hygiene (P3)
- [x] E1 done — `aether-export.zip` (401 KB stale copy of `src/`) deleted; `pg`, `drizzle-orm`, `dotenv`, `@types/pg` and `drizzle-kit` removed (0 imports anywhere — storage is IndexedDB-only, and there is no drizzle config or migrations dir); `@testing-library/react`, `fake-indexeddb`, `jsdom` and `vitest` moved to devDependencies. Production deps are now exactly: katex, next, react, react-dom, react-markdown, rehype-highlight, rehype-katex, remark-gfm, remark-math, undici
- [x] E2 done — `playwright` moved to devDependencies (16 importers, all under `scripts/` and `tests/`, none in `src/`). 28 packages removed from the install

## Group F — lifecycle state off module memory (R3 / §7 P1 item 9)

The one P0/P1 item still open after groups A-E. B8 had fixed how idle-off is
*reported*; the underlying state was still module memory.

- [x] F1 durable engine state — new `src/server/engine/state-store.ts` behind the
  existing `EngineStateStore` interface. Backends: **Netlify Blobs** when
  `NETLIFY=true` (a function's filesystem is ephemeral), a **JSON file** under
  the workspace elsewhere (long-lived Node server and the server bundled in the
  Android app), `ENGINE_STATE_BACKEND=memory` for tests. Atomic write
  (tmp+rename); a corrupt or wrong-version file degrades to a clean snapshot
  instead of throwing. Under vitest it defaults to memory so state cannot leak
  between test files.
- [x] F2 re-hydrate on **every** request, not once per process. A warm serverless
  container would otherwise keep serving the snapshot it loaded at first use,
  long after another instance superseded it — the same bug class, narrowed.
- [x] F3 cross-instance duplicate-push guard at `wakeSlot()`, the one choke point
  both wake paths share. `resolveEngine()` calls `wakeSlot()` directly and never
  touched the manager's `setPushAt`, so the manager's 10-minute cooldown did not
  cover the `/api/netlify/ensure-alive` path at all. `resolve.ts`'s own
  `wakePushAt` map is also per-process (the audit's "lastWakePushAt evaporates").

**Runtime evidence — two real server processes per arm, same build, only
`ENGINE_STATE_BACKEND` differs.** Engine C (no simulator, so a wake always
pushes); Kaggle pushes counted on the recording fake at :3300.

| arm | wake on instance 1 | wake on instance 2 | total pushes |
|---|---|---|---|
| `memory` (the audited behaviour) | 1 | 1 | **2** |
| `file` (durable) | 1 | **0** | **1** |

Instance 2 of the durable arm answered `wake already dispatched for engine c —
not pushing a duplicate kernel`. Selection persistence proven the same way:
instance 1 woke B and wrote `active: "b"`; a separate process on another port
reported `active: b` from the shared store, having never been told.

Gate: tsc 0 · lint 0 errors/10 warnings · 32 files/240 tests (6 new) · build 0
trace warnings.

## REGRESSION FOUND — history purge was undone

While committing the R3 fix I found the repository's `.git` had reverted to the
**pre-purge** chain. Verified, not assumed:

- `git log` is now `e9d7b318 -> 49882f0c -> 6e500322 -> 147b502f -> ec50486e -> 1c4fb871`
- the six commits made for C3/C4/C5/D/E (`14c7ac9e`, `9852a2d6`, `ea936c85`,
  `8c24705a`, `7b63c531`, `f1df649b`) no longer exist as objects — `git cat-file -t`
  returns nothing for all six
- scanning every blob in history finds the leaked `OFF_KEY` again, at
  `49882f0c`, in `netlify/functions/ensure-alive/notebook.ipynb`

**The code is intact.** HEAD's tree was checked file by file: `netlify/functions/`
absent, `aether-export.zip` absent, the hardened notebook template present with
pin `90f5366e…`, 0 occurrences of the leaked key and 0 of
`Access-Control-Allow-Origin`, and `scripts/verify-engine-source.mjs` PASSes. What
was lost is the granular commit history — C3 through E2 now live inside the
single R3 commit instead of their own.

Two consequences that still need action:

1. **The history purge must be re-run** before anything is pushed. The secrets are
   in the ancestry again.
2. **The credentials are compromised regardless** and must be rotated — the repo
   is public and has already been cloned, so purging never un-leaked them.

Also fixed here: the repository had **no `.gitignore` at all**, so `git add -A`
swept 31,960 `node_modules` files plus `.next/` into a commit. Added, and the
commit was amended back to 54 files.

## REAL KAGGLE VERIFICATION — done (see PROOF_REAL_KAGGLE.md)

The audit's hardest gate, cleared with real credentials on real Kaggle hardware:

  wake        : kernels/status error -> queued after POST ensure-alive?engine=a
  boot        : ntfy showed gpus=1 -> ollama 0.33.2 -> model warm (15 GB VRAM)
                -> AGENT LIVE LINK
  live URL    : discovered from the beacon, kernel status "running"
  /api/ps     : 200
  C5 on real  : POST /api/chat no key -> 403, wrong key -> 403, raw ollama
                proxy no key -> 403, no ACAO header anywhere
  §4.9        : first content token at 8.65 s of a 50.79 s generation (17%),
                395 chunks — real streaming, not a replay
  shutdown    : POST /off -> 200, URL then 530, kernel -> error,
                ntfy "ENGINE OFF via UI - quota saved"

Still open from that run:
  - the engine's control surface intermittently returned **501** (Python's
    default BaseHTTPRequestHandler page) alternating with correct 403s from the
    same tunnel URL. Retrying /off worked. Not root-caused, not fixed.
  - single GPU only; A/B/C failover across three live engines not exercised.
  - no real tool-calling turn observed.

## Not claimable without evidence
- Kaggle integration: only after a real credentialed wake → RUNNING → live URL → /api/ps → /api/chat cycle.

## Engine robustness pass — done

Two real bugs found by re-reading the shipped handler, both fixed and both proven
against the *shipped* source (ast-sliced out of the decoded notebook and exec'd,
not re-implemented):

1. **Keep-alive desync (the 501 bug).** `protocol_version = 'HTTP/1.1'` plus a 403
   gate that returned without reading the request body. Fixed by draining the body
   once at the top of `do_POST`. Live-verified: 6 unauthenticated POSTs on one
   keep-alive socket → 6× 403, zero 501s.
2. **Double status line.** `_sent` was set only after `agent_stream()` returned,
   so a mid-generation failure still wrote a second `HTTP/1.1 200 OK` into the
   open chunked body. Now set inside `agent_stream`, next to `end_headers()`.

Tooling added under `scripts/proofs/`: `keepalive-501-proof.py` (A/B on one
reused socket), `double-status-proof.py` (real `agent_stream`, fails it where a
real one fails), `engine-sweep.py` (13 contract cases + 4 connection-reuse
sequences; the pre-fix engine fails 4, the fixed one fails 0).

Two of my own earlier claims were wrong and are retracted in
`PROOF_REAL_KAGGLE.md`: "more than one handler behind the tunnel", and "the 400
vs 501 difference is CPython version strictness" (it is JSON formatting —
compact bodies fuse into 3 tokens, spaced ones into 9).

## Dependency bump to latest — done, with three ecosystem ceilings

Everything was moved to the newest release, then walked back only where the
ecosystem itself is not yet mutually consistent. Each walk-back is a measured
incompatibility, not a preference:

| package | requested | shipped | why |
|---|---|---|---|
| typescript | 7.0.2 | **6.0.3** | `typescript-eslint@8.69.0` (the newest) declares `typescript: ">=4.8.4 <6.1.0"` and hard-throws `typescript-eslint does not support TS 7.0`. 6.0.3 is the highest stable under that ceiling. |
| eslint | 10.10.0 | **9.39.5** | `eslint-config-next@16.3.4` declares `eslint: ">=9.0.0"`, so npm happily installs 10 — but its bundled `eslint-plugin-react` calls `context.getFilename()`, which ESLint 10 removed: `TypeError: contextOrFilename.getFilename is not a function`. Upstream over-permissive peer range. |
| undici | 8.10.2 | **7.29.1** | undici 8 declares `engines: { node: ">=22.19.0" }` and dies on Node 20 with `webidl.util.markAsUncloneable is not a function`. This sandbox runs Node 20.20.2. |

Everything else is genuinely latest: next 16.3.4, react/react-dom 19.2.8,
tailwindcss + @tailwindcss/postcss 4.3.3, postcss 8.5.28, katex 0.18.6,
@types/node 26.4.1, playwright 1.63.0, eslint-config-next 16.3.4.

### tsconfig change forced by TypeScript 6

TS 6 removed `baseUrl` (`error TS5102: Option 'baseUrl' has been removed`).
It was redundant — `paths` was already `"@/*": ["./src/*"]`, resolved relative to
the tsconfig. Removed.

### ESLint 16.3.4 react-hooks debt

The config bump alone turned three `react-hooks` rules into errors and produced
7 new ones in unchanged code: `set-state-in-effect` ×5, `immutability` ×1,
`refs` ×1 (src/hooks/useAether.ts, src/components/{composer,media,memory}.tsx).
They flag deliberate "latest value in a ref" idioms in the streaming path, whose
behaviour is runtime-proven. Downgraded to **warnings** in eslint.config.mjs with
the reasoning inline, rather than rewriting streaming refs immediately before an
APK build. They still print, so the debt stays visible. **This is real debt and
should be paid down.**

Gate after the bump: tsc 0 · lint 0 errors/17 warnings · 32 files/251 tests ·
build clean · verify-engine-source PASS.

