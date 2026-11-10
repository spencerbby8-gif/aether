# Drive backup build — evidence summary (run 42682152778)

Commit `313bb69` on `android/live-agent-execution-20261106`.
Hosted device run: https://github.com/spencerbby8-gif/aether/actions/runs/42682152778 — **success**.
APK shipped from that run: `aether-debug-drive-313bb69.apk`, 4,788,736 bytes,
SHA-256 `bb5122ef585065dae04127143b8d73f565307482610d852d04099f7caeeccff7`.

## What changed in this build

Durable Drive backup. The app no longer uses Supabase's one-hour
`provider_token`; it asks Google Identity Services for offline access to
`drive.appdata` only, and a new Edge Function (`google-drive-token`) exchanges
the one-time code and keeps the refresh token server-side.

## Device evidence from this run

- Instrumentation: `ScreenshotTest` **OK (2 tests)**, `LiveExecutionHandshakeTest`
  **OK (4 tests)**, `ExhaustiveThemeTest` **OK (1 test)** — 14 test records, no
  failures, 276 s of real emulator time.
- 130 PNG captures pulled from the artifact, including
  `04b-backup-signed-out.png` and the light/midnight theme-audit pair for the
  same screen. Both were opened and read, not just counted: the new privacy copy
  ("the app itself never stores a Google refresh token") renders in both themes,
  the signed-out state line is correct, and Disconnect/Backup/Restore are
  correctly dimmed.
- `logcat.txt` + `instrumentation.log`: no `FATAL`, no `ANR in`, no
  `NoClassDefFoundError` — relevant because the backup screen touches Play
  services classes that this emulator does not have.
- The shipped dex contains `DriveTokenBroker`, `DriveAuthorizer`, `DriveErrors`
  and the `google-drive-token` route, confirming the artifact matches the change.

## Security checks

| Check | Result |
|---|---|
| `drive-broker-check.sh` (live) | 5/5 — anonymous 401, publishable key cannot impersonate a user, token table 401 `permission denied`, POST-only 405, disconnect without session 401 |
| `DriveBrokerErrorsProof` (JVM) | 20/20 — every failure has honest text, no success-sounding failure, no token material |
| JVM suite | 26/27 — the only failure is the pre-existing `StatusProof`, which needs real Kaggle credentials |
| Secret scan of the shipped APK | `GOCSPX`, `client_secret`, `GOOGLE_WEB_CLIENT_SECRET`, `sb_secret`, `service_role` all **absent**; only the public web client id is present |
| Secret scan of the repo | clean |

## Still unproven — do not read this as "backup works"

1. No real consent → code exchange → upload → restore has run. It needs a phone
   with Play services, your Google account, and the rotated client secret.
2. Refresh after the one-hour access token expires: implemented, not exercised.
3. `/disconnect` revocation against a live grant: implemented, not exercised.
4. The "Google Play services is required" branch: code-review only, because the
   emulator never reaches it (the screen short-circuits on "signed out" first).
5. Google verification of `drive.appdata` for public use: not started; test-user
   cap applies until it is.
