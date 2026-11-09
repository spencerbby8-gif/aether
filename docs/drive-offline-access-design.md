# Durable Google Drive backup — design and threat model

Status: implementation in progress. Nothing here is claimed as working until a real
consent → exchange → backup → restore cycle has happened on a device.

## Why the current path cannot be durable

Supabase's `/auth/v1/authorize` forwards provider-specific parameters literally instead of
merging them, so `query_params={"access_type":"offline"}` reaches Google as an unknown
parameter and is ignored (verified live). Without `access_type=offline` Google never issues a
refresh token, so `provider_token` dies after ~1 hour and the app can never renew it.

## Chosen architecture

```
Android  ──(Identity.getAuthorizationClient, drive.appdata, requestOfflineAccess(webClientId))
   │                                   │ user consents in the Play-services sheet
   │  serverAuthCode                   ▼
   ├──────────────► Supabase Edge Function `google-drive-token` ──► oauth2.googleapis.com/token
   │                        │ (holds GOOGLE_WEB_CLIENT_SECRET)          (code + secret)
   │                        ├─ stores refresh_token in Postgres (service-role only table)
   │  short-lived access   ◄┘
   ▼
googleapis.com/drive/v3 (appDataFolder) — same calls as today
```

Why this shape:

- **Web client + client secret** are required for the code exchange, so the exchange cannot
  live in the APK. The secret goes in Edge Function secrets, never in the app or the repo.
- **Refresh tokens never reach the device.** The device holds only a short-lived access token
  cached in Android Keystore; it asks the function for another when it is near expiry.
- **No redirect URI to maintain.** The Play-services authorization sheet returns the code to
  the app directly, so there is no `aether://` callback for Google to reject.
- **Incremental consent.** Aether's identity sign-in keeps `email profile`; Drive is a separate
  authorization the user grants (or revokes) inside Backup.

## Data model

`public.google_drive_credentials`

| column | type | notes |
|---|---|---|
| `user_id` | uuid pk → `auth.users(id)` on delete cascade | one Drive link per Aether account |
| `refresh_token` | text not null | Google refresh token, server-side only |
| `scope` | text | what was granted, for honest UI |
| `updated_at` | timestamptz | last exchange |

RLS is enabled and **no policies are created**, so `anon` and `authenticated` cannot read or
write it at all. Only the Edge Function's service role can. That is deliberate: a stolen user
JWT must not yield a Drive refresh token.

## Security rules the implementation must hold

1. The function accepts `POST` only and derives the user from the caller's Supabase JWT — never
   from a body field. A body-supplied user id would be an immediate privilege-escalation bug.
2. No token, code, or secret is ever logged, returned in an error message, or included in a
   thrown exception that reaches the client.
3. `disconnect` revokes at `oauth2.googleapis.com/revoke` **and** deletes the row, so a failed
   local delete cannot leave live access behind.
4. Google error bodies are mapped to short, non-identifying messages (`Drive authorization
   expired`, `Google rejected the request`) before they reach Android.
5. The app treats every Drive failure as "backup did not happen" — it never reports success on
   a failed upload, and never silently falls back to a fake local copy.
6. Scope stays `drive.appdata`: Aether can only ever touch its own hidden app-data folder.

## Verification plan

| Layer | How it is proven | Status |
|---|---|---|
| Table locked down | `anon`/`authenticated` SELECT returns nothing; service role works | pending |
| Function rejects anonymous callers | POST without JWT → 401 | pending |
| Function rejects a JWT for another user | row written only for the JWT subject | pending |
| Code exchange | real `serverAuthCode` → access + refresh token | needs device + account |
| Refresh | access token near expiry → new token without user interaction | pending |
| Backup/restore | real upload, then restore on a second install | needs device + account |
| Revocation | after disconnect, Drive calls fail and row is gone | pending |

## What is NOT solved by this

- Google verification: `drive.appdata` is a sensitive scope. While the app is unverified, only
  accounts added as **test users** can grant it (limit 100). Public release requires Google's
  review.
- Devices without Google Play services cannot use the authorization sheet. The UI must say so
  instead of failing obscurely.
