# AETHER — CONTINUATION PROMPT (paste into the new chat; everything is on GitHub — clone spencerbby8-gif/aether.
 Do NOT use any old local git bundle: pre-scrub bundles still contain real keys.)

## 0. FIRST ACTION — restore the repo
The attached `aether-full.bundle` is a complete git history (verified, ends at
commit "restore: third sandbox history rollback"). Do:

    git clone aether-full.bundle aether && cd aether
    npm ci
    bash scripts/setup-android-toolchain.sh   # needed for jvm-suite + APK builds

## 1. CREDENTIALS (all live as of 2026-09-15; treat every one as compromised — rotate when convenient)

Four Kaggle engine accounts (kernel slug is the SAME on all four:
`qwen-3-8-27b-uncensored-chat`):

| slot | username      | Kaggle API token (KGAT)                    |
|------|---------------|--------------------------------------------|
| A    | fridaymoses   | KGAT_<SLOT_A_KEY — paste in session>      |
| B    | spencercoldtr | KGAT_<SLOT_B_KEY — paste in session>      |
| C    | dyceelvk      | KGAT_<SLOT_C_KEY — paste in session>      |
| D    | adaoraodoh    | KGAT_<SLOT_D_KEY — paste in session>      |

- Engine OFF key (header `X-Engine-Key` on every engine POST): `REMOVED_ENGINE_OFF_KEY`
- Beacon (ntfy topic, engines announce stages/LIVE LINKs here):
  `https://ntfy.sh/REMOVED_BEACON_TOPIC` — poll with `?poll=1&since=6h`
- Wake recipe: `export KAGGLE_USERNAME_D=adaoraodoh KAGGLE_KEY_D=<D key>` (D is
  env-only; A/B/C have committed fallbacks in `scripts/proofs/wake-engines.py`),
  then `python3 -u scripts/proofs/wake-engines.py <slot>`.
- Per-account Kaggle dataset `aether-engine-cache` (EXISTS on all four
  accounts: ollama tarball + 15.3 GB model store) — kernels attach it via the
  push field `datasetDataSources: ["<user>/aether-engine-cache"]` (camelCase;
  snake_case is silently ignored). If a dataset is ever deleted, rebuild with
  `python3 scripts/push-cache-builder.py <slot>` (~10 min, CPU kernel).
- GitHub: **FULLY PUSHED AND VERIFIED as of 2026-09-16.** Repo
  `https://github.com/spencerbby8-gif/aether`, main = `f8535af` = full source
  (456 files, 116 commits, scrubbed history) + the release APK
  `apk/aether-2.6.0-release.apk` (downloaded back from GitHub: byte-identical,
  sha256 d5038e77…) + this handoff + README. Old remote tip preserved on
  `backup/pre-rewrite-20260916`. A new session needs NOTHING but
  `git clone https://github.com/spencerbby8-gif/aether.git` plus the KGAT
  keys pasted in chat. (The 2026-09-15 PAT died mid-session with HTTP 401;
  the 2026-09-16 PAT was also pasted in chat — rotate it too.)
  SANDBOX NOTE: git history/config rolled back a 4th time this session;
  recovery that worked: `git fetch <url> +refs/heads/main:refs/remotes/origin/main`
  then `git reset --hard origin/main`, re-add remote, re-set user.name/email. Repo
  `https://github.com/spencerbby8-gif/aether` (public), `origin` configured,
  `main` = `52a23af` (tree `1520e5ae…`, the gate-verified tree: vitest
  352/0/5, tsc 0, verify-engine-source PASS). Full 115-commit history was
  scrubbed with `git-filter-repo --replace-text` — every historical KGAT key
  replaced with `KGAT_REDACTED`; a remote-side scan of every served commit
  found only the `KGAT_xxxx` placeholder. The pre-sync remote tip (Sep 5,
  `1c4fb87`, verified key-free) is preserved on branch
  `backup/pre-rewrite-20260916`. NOTE: filter-repo rewrote all commit SHAs —
  old SHAs from earlier session notes (e.g. `81501fe`, `70111ad`) no longer
  exist; `70111ad`'s content is somewhere in the rewritten chain.
- The pushed source is credential-free: `wake-engines.py`,
  `push-cache-builder.py` and `watch-real-wake.sh` now resolve Kaggle creds
  ONLY from env (`KAGGLE_USERNAME_x` / `KAGGLE_KEY_x`); the hardcoded A/B/C
  fallbacks were removed. To wake engines you must first
  `export KAGGLE_USERNAME_A=fridaymoses KAGGLE_KEY_A=… ` (etc. for B/C/D).
  `android/credentials.properties` (real keys, for APK builds) stays local,
  gitignored, never pushed.
- GitHub PAT: the one used for this push (`ghp_HNWx…`, pasted in chat
  2026-09-15 — treat as leaked, rotate it) is NOT stored here. For the next
  push, generate a fresh token and paste it here: `________________________`.

## 2. WHERE THE PROJECT STANDS (everything below is measured, not claimed)

Aether = Android APK + Next.js web app driving 4 self-hosted Kaggle GPU
engines (Qwen3.8-27B IQ4_XS on 2× Tesla T4 each) via cloudflared tunnels and
an ntfy beacon. The entire engine agent layer lives in ONE notebook cell
(cell 4, find it by content `"Warmup (pin in VRAM"`) rendered from
`src/server/engine/aether-engine-source.ts` and baked into
`android/app/src/main/assets/aether-notebook-template.json`.

Proven live (logs/reports in-repo):
- Cold wake: 34–38 s kernel→LIVE on all four engines (dataset cache;
  was 151–416 s). Already-warm resolve: 1.5 s, no push. Kaggle's own GPU
  queue (60–540 s before "stage: starting") is the remaining cold cost.
- Decode ceiling: 14–15.4 tok/s, flat across num_ctx/num_batch — 2×T4
  memory-bandwidth bound; do not chase it with settings (PERFORMANCE_CEILING.md).
- Warm TTFT median 0.5–0.8 s; stall detection 90 s first-progress / 45 s
  inter-chunk / 90 s final-answer (live-proven at 90.3 s against a real
  wedged Ollama; a healthy 303.9 s generation survives).
- Failover: engine killed mid-task → workspace snapshot restored → finished
  steps byte-identical, task completed (failover-continuity-live.py 19/19;
  real-task-live.py 13/13 and 20/20 with mid-run kill).
- Latency-aware AUTO routing in EngineManager (150 ms hysteresis, 4
  consecutive successes to reinstate a degraded engine).
- APK 2.6.0 / versionCode 45: `apk/aether-2.6.0-release.apk` (802,664 B) —
  template inside verified byte-identical to the asset. NEVER installed on
  hardware (no emulator possible); that is the standing honest caveat.

Gate (must stay green): `npx vitest run` = 352 pass / 0 fail / 5 skip ·
`npx tsc --noEmit` = 0 · `bash scripts/proofs/jvm-suite.sh` = 19/19 ·
`node scripts/verify-engine-source.mjs` = PASS (pins the template blob
sha256 `7ead9c01…` and rendered byteLength 218270 in
`tests/kaggle-wake-source.test.ts` L61/L174 — move BOTH pins after any
template edit, and run `node scripts/sync-engine-source.mjs` first).

## 3. SANDBOX SURVIVAL RULES (learned the hard way, repeatedly)

- The sandbox snapshot WIPES: `node_modules`, `/tmp`, `~/.cache/toolchain`,
  and `.git/config` (hence the lost remote), and has ROLLED BACK git history
  three times while keeping the working tree — if `git log` doesn't end at
  the newest commit, re-commit the tree; it is the verified state.
- Gradle on this 1984 MB box OOM-kills its daemon on the first attempt;
  free memory and simply re-run `TOOLCHAIN=~/.cache/toolchain bash
  scripts/build-apk.sh` (second attempt: ~70 s).
- Engine pushes 401 without the slot's KGAT exported in the SAME shell.
- Kaggle keeps every previous kernel version running after a push; reap with
  `reapSlotInstances(slot)` (BEACON_BACKUP_URL + ENGINE_OFF_KEY env).
- `/api/ps 200` ≠ ready; only `GET /api/ready {"ready":true}` is ready.
- Never benchmark or prove against a cold engine; tunnels die randomly
  (Cloudflare) — probe before every long run and discard runs with
  mid-proof URLErrors.
- Template edits: use/extend `scripts/wake-cache-stall-fix.py`
  (content-addressed, `--check`/`--revert`, byte-exact round trip) — never
  hand-edit the 195 KB cell. After any template change: patcher → sync →
  pins → vitest → push ONE engine → verify from the beacon before fleet push.

## 4. OPEN ITEMS (in priority order)

1. Rotate all six tokens (4× KGAT + OFF key + the GitHub PAT pasted
   2026-09-15) — they have all been in chat.
2. Install `aether-2.6.0-release.apk` on the physical phone (the one thing
   never testable from a sandbox) and exercise: wake from Settings, chat,
   file upload, engine off/on, mid-task failover.
3. Optional: proactive wake / engine rotation before the 12 h Kaggle session
   expiry (documented as remaining limitation in PERFORMANCE_CEILING.md).

## 5. USER STANDING RULES (binding)

- Hard evidence only; no false claims; state what is unverified.
- Numbered work items are sequential: finish + verify N before N+1.
- Report format: FOUND → ROOT CAUSE → FIX → BEFORE → AFTER → LIVE TEST →
  REMAINING LIMITATION.
- Never expose raw tunnel URLs or hidden chain-of-thought in the UI; never
  bypass CAPTCHA/MFA/anti-bot; chat-first UI is the accepted baseline;
  normalize model output (no emoji spam); sessions persist in phone storage.
