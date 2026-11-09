# Drive backup: what is built, what you must do, what is still unproven

Status as of the build in commit `313bb69` (branch `android/live-agent-execution-20261106`).

## The one thing that was broken

The app was asking Supabase for a Drive token. Supabase hands back Google's
`provider_token`, which **expires in about an hour and cannot refresh**. Any
backup older than that was dead, and Supabase cannot forward
`access_type=offline` to Google (verified twice), so no amount of client-side
work could fix it.

## What now exists

```
Android (Play services)                    Supabase Edge Function              Google
────────────────────────                   ──────────────────────              ──────
Identity.getAuthorizationClient
  scopes: drive.appdata only
  requestOfflineAccess(web client id)
        │  user taps Allow
        ▼
serverAuthCode (one-time)
        │  POST {action:"connect", code}   ─►  oauth2.googleapis.com/token
        │                                     stores refresh_token
        │  ◄── short-lived access token       in google_drive_credentials
        ▼
Keystore-cached access token (1 h)
  used for DriveBackupClient upload/latest/download
        │  token expired?
        │  POST {action:"access"}          ─►  refresh_token grant
        │  ◄── new short-lived token
```

- Refresh token lives **only** on the server, in `public.google_drive_credentials`.
- That table has RLS enabled with **no policies** and all client grants revoked;
  a live check from outside confirms `anon` gets `401 permission denied`.
- The app holds the **web client id** (public, not a secret). The client secret
  exists only as an Edge Function secret — never in the APK, never in the repo.
- Failure is never dressed up: every Drive error maps to explicit text
  (`DriveErrors`), so "backup did not happen" cannot be read as "backup done".

## Your three steps (I cannot do these — they need your Google account)

### 1. Rotate the client secret
The old secret appeared in plaintext in our earlier session, so treat it as
burned. Google Auth Platform → Clients → your web client → reset secret.

### 2. Put the new secret into the Edge Function
Supabase dashboard → Project `jvuqxazndloiekikzrnb` → Edge Functions → Secrets
→ add `GOOGLE_WEB_CLIENT_SECRET` = the new secret.

`GOOGLE_WEB_CLIENT_ID` is already set. Until the secret is set the function
answers `503 drive_not_configured` — by design, and only to signed-in callers.

Verify with your own session (any signed-in app, or the dashboard's invoke tab):
an `access` call should answer `404 not_connected` rather than `503`.

### 3. Add the scope and yourself as a test user
Google Auth Platform → Data Access → add
`https://www.googleapis.com/auth/drive.appdata` as a scope, and add your own
Google account under Audience → Test users. Unverified apps using this scope are
capped at 100 test users, which is fine for you and anyone you add.

## What is proven, and how

| Claim | Evidence |
|---|---|
| Function refuses anonymous callers | `scripts/proofs/drive-broker-check.sh` → 401 (no bearer, and publishable key as bearer) |
| Refresh tokens unreadable by clients | same script → 401 `permission denied` on the table |
| Function is POST-only | same script → 405 |
| Table shape: RLS on, 0 policies, service_role only | live `pg_class` + `pg_policies` query on the project |
| Every Drive failure has honest, non-success text and no token material | `DriveBrokerErrorsProof` 20/20 (JVM suite, now 26/27 — the one failure is the pre-existing `StatusProof`, which needs real Kaggle credentials) |
| App still compiles and builds | `gradle :app:assembleDebug :app:assembleDebugAndroidTest` SUCCESS, APK `d43aa06…` 7.8 MB |
| Backup screen still renders | hosted emulator screenshot `04b-backup-signed-out` |

## What is NOT proven yet (be clear about this)

1. **No real consent → exchange → backup → restore has happened.** That needs a
   physical device with Play services, your Google account, and the secret from
   step 1. I cannot fake it, and a fixture would not count.
2. **Refresh after an hour** is implemented but unexercised against a live grant.
3. **Revocation via `/disconnect`** is implemented (Google's revoke endpoint,
   then row delete) but unexercised with a live token.
4. **The Play-services gate** is written to show
   "Google Play services is required to connect Google Drive backup on this
   device" — the hosted emulator has no Play services, so the *signed-out*
   branch is what the screenshots capture; the Play-services line is code-review
   only, not a screenshot.
5. **Google verification** of `drive.appdata` for public use is not started.
   Until then, only test users you add can connect.
