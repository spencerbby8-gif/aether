# Google Auth and Drive backup: exact setup

Aether uses Supabase's hosted Google OAuth flow with PKCE. The app contains only the Supabase publishable key. **Never put the Google client secret, a Supabase service-role key, or a Google refresh token in the APK.**

Project used by this build:

- Supabase URL: `https://jvuqxazndloiekikzrnb.supabase.co`
- Google/Supabase callback: `https://jvuqxazndloiekikzrnb.supabase.co/auth/v1/callback`
- Android return URL: `aether://auth/callback`
- Drive scope requested only for Backup & Restore: `https://www.googleapis.com/auth/drive.appdata`

## 1. Create the Google OAuth **Web** client

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select the project that will own Aether authentication.
2. Open **APIs & Services → Library** and enable **Google Drive API**.
3. Open **APIs & Services → OAuth consent screen**. Create the app, supply the app name and support email, and complete the contact fields.
4. Under **Audience**, use **External + Test users** for private testing and add the Google accounts that will sign in. Production use with the sensitive Drive app-data scope requires publishing the app and may require Google's OAuth verification process.
5. Under **Data Access / Scopes**, add the normal OpenID identity scopes and `https://www.googleapis.com/auth/drive.appdata`. This scope lets Aether see only its own private app-data backup, not the user's other Drive files.
6. Open **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
7. Choose **Web application**—not Android. Supabase performs the web OAuth exchange on Aether's behalf.
8. Name it, for example, `Aether Supabase Web`.
9. Under **Authorized redirect URIs**, add exactly:
   `https://jvuqxazndloiekikzrnb.supabase.co/auth/v1/callback`
10. Create the client and copy its **Client ID** and **Client secret**.

## 2. Configure Supabase

1. Open the Supabase project dashboard → **Authentication → Sign In / Providers → Google**.
2. Enable Google and paste the Web **Client ID** and **Client secret**. Keep the secret in Supabase; do not add it to `SupabaseAuth.java`, Gradle properties, or the repository.
3. Save the provider settings.
4. Open **Authentication → URL Configuration** and add `aether://auth/callback` to **Redirect URLs**. Preserve any existing URLs.
5. Enable Email auth and confirm-email behavior appropriate to the installation. New email accounts currently show the confirmation-required path.
6. If the installed Supabase version exposes a provider **Scopes** field, the identity scopes are sufficient for ordinary Google sign-in. Aether's Backup screen requests `drive.appdata` separately when the user taps **Connect Google Drive**. Do not request Drive scope during every chat sign-in.

## 3. End-to-end verification required before claiming completion

Use a real test Google account and mailbox:

1. Create an email account, open the real confirmation email, complete confirmation, and sign in again.
2. Sign out, then sign in with **Continue with Google**. Confirm that returning to `aether://auth/callback` creates a persisted Supabase session.
3. Open **Settings → Storage & Data → Backup & Restore → Connect Google Drive** and approve `drive.appdata`.
4. Tap **Back up now**. Verify the success message and that **Latest backup** returns the real Drive file ID, modified time, and byte size.
5. Create a second local chat, restore the older backup, and verify the merge preserves newer local chats and imports only newer/missing remote chats.
6. Force an expired/revoked Drive token and verify the UI requests reconnection rather than reporting a successful backup.
7. Sign out and verify both the Supabase session and cached Drive token are removed from the device.

The source implements these routes and the local merge/checksum logic, but no real mailbox, Google account, OAuth callback, or Drive backup/restore has been completed in this workspace yet. Those remain external-account evidence gates, not features to infer from a successful APK build.
