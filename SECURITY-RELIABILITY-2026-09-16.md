# Aether — Security + Reliability Pass: Evidence Report (2026-09-16)

Scope (user spec 58321): focused pass — secret cleanup (tree + full history), APK
credential-mechanism verification, browser-agent recovery fix. No redesign, no
unrelated changes. No secret values appear in this report.

---

## 1. Git secret cleanup

### FOUND
Kinds and counts only (values never reproduced):

| secret | where it lived (before) |
|---|---|
| Engine OFF key — live value | 108/117 original commits; 31 files at HEAD |
| Engine OFF key — retired value | 112/117 original commits; also embedded (as a "pattern" example) in a test comment at HEAD — missed by the first migration pass, caught and redacted in this one |
| ntfy beacon topic | 108/117 original commits; 9 files at HEAD |
| webhook.site backup-beacon token | 353 occurrences across all 117 original commits (history) |
| OFF key + topic hidden in base64 | 5 commits of `src/server/engine/aether-engine-source.ts` embedded the notebook template (containing those secrets) as a base64 payload — invisible to any plaintext scan |
| Kaggle engine keys | **never in git** (verified) — only the all-`x` placeholder in `android/credentials.properties.example`, a documented dummy |

### ROOT CAUSE
The pre-audit architecture committed rendered engine notebooks and beacon
configuration directly. A earlier migration pass moved tree literals to env
(`ENGINE_OFF_KEY`, `BEACON_TOPIC`, unified from `AETHER_OFF_KEY`;
`scripts/secret-env-migration.py`, `.env.example`) but one retired-key value
survived in a test comment, and the *history* still contained everything.

### FIX
Two-pass `git filter-repo` over all reachable history:
1. **Literal replacement** — every real value (and its base64 form) across all
   blobs and all commit messages → `REMOVED_*` tokens.
2. **Base64 surgery** — blobs carrying the `AETHER_NOTEBOOK_SHA256` marker get
   their embedded notebook payload decoded, scrubbed, re-encoded and re-chunked
   (handles secrets inside the payload, including across chunk boundaries).

Excluded as non-secrets (documented, deliberate): the all-`x` KGAT placeholder
(example file) and the all-zero webhook UUID (pre-existing test-fixture dummy).

### BEFORE → AFTER
- Before: **118/118** commits reachable from `main` contained ≥1 real secret
  (plaintext or base64-embedded).
- After: **0/118**.

### VERIFICATION (rewritten repo, all 118 commits)
- Exact-value grep of every commit tree: **0 hits**
- Shape-pattern scan (`nxoff-*`, `btb-kaggle-*`, `ghp_*`, webhook UUID) minus
  the two documented dummies: **0 hits**
- Base64-decode scan of every file of every commit: **0 hits**
- Commit messages: **0 hits**
- HEAD tree hash **identical** before/after the rewrite — current content is
  byte-for-byte the verified tree; only history changed
- Commit count preserved: 118; full suite green post-rewrite (below)

---

## 2. Browser agent recovery (the "stops after a few runs" bug)

### FOUND
The phone agent aborted turns after a handful of steps, including on pages that
merely presented a CAPTCHA or an overlay.

### ROOT CAUSE
A single consecutive-failure counter treated every non-ok step the same:
a CAPTCHA block, a rate-limit, a missed selector and a real failure all counted
identically, so **3 blocked steps killed a turn in which nothing had actually
failed**.

### FIX (shipped in the engine notebook, pins updated)
- `_fail_kind(tool, note)` classifies each failure:
  **blocked** (CAPTCHA / robot check / sign-in / 2FA / paywall / overlay),
  **transient** (timeouts, rate limits, 429, 5xx, connection resets, empty crawls),
  **recover** (not-found / no visible match), else **terminal**.
- `_account_step` ranks a whole step: any executed ok → ok (resets all rails);
  worst-of-step by rank terminal > blocked > transient > recover; replayed calls
  are not evidence.
- Per-rail budgets: `_B_CAPS = {blocked: 4, transient: 5, recover: 6}`; the
  generic 3-strike rail (`_MAX_CONSEC_FAIL = 3`) now counts **terminal**
  failures only. `_MAX_SILENT_STEPS = 12` and the 24-call `Budget(max_fails=2)`
  are untouched.
- Three honest stop messages tell the user which rail tripped and what to do.
- **CAPTCHA / anti-bot / MFA stay human-in-the-loop — never solved, never bypassed.**

### BEFORE → AFTER
- Before: `[blocked, blocked, blocked]` → abort (false failure).
- After: 3 blocked steps → `consec = 0`, turn continues; 4 blocked → clean
  user-action stop; 3 terminal → generic stop (safety preserved); success
  resets every rail; 24-call boundary and `give_up_on` unchanged.

### LIVE TEST
- `tests/browser-recovery.test.ts` — 3 tests / 32 checks driving the **shipped**
  template code, incl. "CAPTCHA steps don't consume the generic rail" and the
  24-call boundary. Green.
- Real-Chromium regression (`scripts/proofs/browser-reliability-live.py`,
  chromium-headless-shell 153): **11/11 workflows**, 49 tool calls, 3.9 s wall
  (guess-policy comparison: 10/11, −90% wall). CAPTCHA correctly refused and
  named, never solved.

---

## 3. Validation battery (final numbers, this session)

| gate | result |
|---|---|
| `npx vitest run` | **355 passed / 0 failed / 5 skipped** (360 tests) |
| `npx tsc --noEmit` | 0 errors |
| `verify-engine-source.mjs` | PASS — intact, secret-free, renderable, every POST gated, no wildcard CORS |
| JVM suite (`jvm-suite.sh`, JDK 21) | **18/19 clean** — `StatusProof` excluded by design: it requires the gitignored `android/credentials.properties` + live Kaggle access, which a credential-free environment intentionally lacks |
| Browser reliability (live Chromium) | 11/11 workflows |
| History secret scan | **0 hits / 118 commits** (§1) |

## 4. APK 2.7.0

- `apk/aether-2.7.0-debug.apk` — versionCode **46**, versionName **2.7.0-debug**,
  minSdk 26 / target 37, **4,018,880 bytes**,
  sha256 `9af462af0540cb3dcc4e995b2f02c0e2a38be0cea0f533a8cce6afacc92071f0`.
- **Credential-free by construction**: zero secret-pattern hits across all 421
  files inside the APK; the embedded notebook template is byte-consistent with
  the repo asset, all `{{...}}` placeholders intact, and the browser-recovery
  code is verified present in the shipped template.
- Debug-signed: the release keystore is gitignored and not present in this
  environment (a release rebuild re-signs under the owner's keystore).

### Credential-injection mechanism (verified, DUMMY values only)
`android/credentials.properties` (gitignored, `.gitignore` L43–45) →
`scripts/bake-credentials.sh` → XOR+Base64 `assets/aether-credentials.dat` →
packaged into the APK → read at runtime by `Credentials.java`.
Proven end-to-end with obviously-fake values: the `.dat` packages into the APK
and XOR-decodes back to exactly the input config; template placeholders stay
intact. **Caveat: the XOR mask is a public constant in the script — the `.dat`
is obfuscation, not encryption; anyone holding a baked APK can extract its
credentials.** Baking *real* engine credentials was declined (a public-repo APK
is a zip; Kaggle fleet ToS); the layer is documented and owner-operated. After
the dummy run the tree and APK were restored to the verified clean state.

---

## 5. Remaining limitations (honest list)

1. **Rotation is still required and cannot be done from a sandbox.** The
   pre-rewrite commits were public and are already cloned — purging history
   does not un-leak. `REMAINING_WORK.md` requires rotating the OFF key,
   webhook.site token and ntfy topic. Per explicit user instruction this session
   kept the existing keys ACTIVE — that is the owner's accepted risk, on record.
2. **Force-push done (2026-09-16)** — verified from a fresh anonymous clone:
   118 commits, 0 secret hits, single branch `main`. A stale
   `backup/pre-rewrite-20260916` branch on GitHub still carried the pre-rewrite
   root commit (16 secret hits) and was deleted. GitHub may serve pre-rewrite
   objects by direct SHA until its server-side GC.
3. A pre-scrub safety backup exists at
   `~/aether-PRE-SCRUB-BACKUP-DELETE-ME.bundle` (contains the original history,
   secrets included — delete it once the push is confirmed good).
4. `StatusProof` (JVM suite) needs live Kaggle + gitignored credentials — the
   one proof not runnable here.
5. The 2.7.0 build is debug-signed only (see §4).
