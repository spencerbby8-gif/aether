# Drive token broker — live probe against the deployed function

Date: 2026-11-09. Commit under test: `313bb69` (function `google-drive-token` v3,
project `jvuqxazndloiekikzrnb`).

## Why this exists

Up to this point the strongest claim was "the function refuses anonymous
callers". That does not prove the Google client credentials work, and the client
secret had just been rotated — a wrong secret would leave every real backup
failing with a message that looks like an ordinary Google error.

This probe answers one question with evidence: **did the rotated secret actually
reach Google and get accepted?**

## What was done

A temporary confirmed account (`probe-drive@example.invalid`) was created
directly in `auth.users` with an `email` identity, signed in through
`POST /auth/v1/token?grant_type=password` to obtain a genuine user JWT, and the
four broker actions were called with that JWT. The account was deleted
afterwards; `google_drive_credentials` was empty before and after.

No secret was printed, copied or committed at any point: the client id/secret
live only in the function's environment.

## Results

| # | Call | Result | What it proves |
|---|---|---|---|
| 1 | `{"action":"access"}` | `404 not_connected` | the caller's JWT resolved to a user, both secrets are configured (no more `503`), and no refresh token was stored yet |
| 2 | `{"action":"connect","code":"4/0Ax4XfWh_probe_code_not_real"}` | `400 invalid_grant` | **Google authenticated the client** (id + rotated secret) and rejected only the bogus code |
| 3 | `{"action":"disconnect"}` | `200 {"disconnected":true}` | revoke-then-delete path runs on a real session |
| 4 | `{"action":"access"}` again | `404 not_connected` | the delete actually removed the stored link |

## The distinction that matters

Google answers `invalid_grant` when the code is bad but the client is
authenticated, and `invalid_client` when the client id/secret pair is rejected.
Result 2 is the first, so the rotated secret is correct and live. If it were
wrong, call 1 would already have returned `503 drive_not_configured` and call 2
`400 invalid_client`.

## Still not proven by this probe

Consent, the real code exchange, the refresh token grant, an actual Drive upload
and a restore. Those need a physical device with Play services and the user's own
Google account approving the request. Nothing in this probe touches those paths,
and it must not be read as "backup works".
