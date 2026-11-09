package com.aether.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Talks to the deployed `google-drive-token` Edge Function.
 *
 * The device never holds a Google refresh token. It keeps only a short-lived
 * access token in Android Keystore, and asks the function for another one when
 * that is close to expiry. Every failure is reported as a short, non-secret
 * sentence so a Drive problem can never be mistaken for a successful backup.
 */
final class DriveTokenBroker {
    interface TokenCallback { void onResult(String accessToken, String error); }
    interface Callback { void onResult(boolean ok, String message); }

    private static final String ROUTE = SupabaseAuth.PROJECT_URL + "/functions/v1/google-drive-token";
    private static final String CACHE_KEY = "drive_access_token_v1";
    private static final String EXPIRY_KEY = "drive_access_expiry_v1";
    /** Renew this early so a long upload never starts on a dying token. */
    private static final long SKEW_MS = 5 * 60 * 1000L;

    private DriveTokenBroker() { }

    /** True only when Google Play services can present the consent sheet. */
    static boolean available(Context context) {
        try {
            return com.google.android.gms.common.GoogleApiAvailability.getInstance()
                    .isGooglePlayServicesAvailable(context)
                    == com.google.android.gms.common.ConnectionResult.SUCCESS;
        } catch (Throwable missing) {
            // The Play-services classes are absent on non-GMS builds.
            return false;
        }
    }

    /** A usable Drive token, from cache when fresh, otherwise minted by the function. */
    static void access(Context context, TokenCallback callback) {
        SecureStore secure = new SecureStore(context);
        try {
            String cached = secure.get(CACHE_KEY);
            long expiry = Long.parseLong(secure.get(EXPIRY_KEY).isEmpty() ? "0" : secure.get(EXPIRY_KEY));
            if (!cached.isEmpty() && expiry - System.currentTimeMillis() > SKEW_MS) {
                callback.onResult(cached, null);
                return;
            }
        } catch (Exception ignored) { /* fall through to the network */ }
        call(context, new JSONObject(), callback);
    }

    /** Exchange a Play-services server auth code for a durable link plus a token. */
    static void connect(Context context, String serverAuthCode, TokenCallback callback) {
        if (serverAuthCode == null || serverAuthCode.isEmpty()) {
            callback.onResult(null, "Google returned no authorization code. Try connecting again.");
            return;
        }
        JSONObject body = new JSONObject();
        try { body.put("action", "connect").put("code", serverAuthCode); }
        catch (Exception e) { callback.onResult(null, "Could not prepare the Drive request."); return; }
        call(context, body, callback);
    }

    /** Revoke at Google and drop the server-side link. */
    static void disconnect(Context context, Callback callback) {
        forget(context);
        JSONObject body = new JSONObject();
        try { body.put("action", "disconnect"); }
        catch (Exception e) { callback.onResult(false, "Could not prepare the request."); return; }
        send(context, body, (status, error, response) -> {
            if (status >= 200 && status < 300) callback.onResult(true, "Google Drive disconnected.");
            else callback.onResult(false, message(status, error));
        });
    }

    /** Drop the local cached token (the server-side link is untouched). */
    static void forget(Context context) {
        SecureStore secure = new SecureStore(context);
        secure.remove(CACHE_KEY);
        secure.remove(EXPIRY_KEY);
    }

    static boolean hasCachedToken(Context context) {
        try {
            SecureStore secure = new SecureStore(context);
            if (secure.get(CACHE_KEY).isEmpty()) return false;
            long expiry = Long.parseLong(secure.get(EXPIRY_KEY).isEmpty() ? "0" : secure.get(EXPIRY_KEY));
            return expiry - System.currentTimeMillis() > 0;
        } catch (Exception e) { return false; }
    }

    // ---- plumbing -------------------------------------------------------

    private interface RawCallback { void onResult(int status, String error, JSONObject body); }

    private static void call(Context context, JSONObject body, TokenCallback callback) {
        send(context, body, (status, error, response) -> {
            if (status >= 200 && status < 300 && response != null) {
                String token = response.optString("access_token", "");
                if (token.isEmpty()) { callback.onResult(null, "Google Drive returned no access token."); return; }
                long expiresIn = response.optLong("expires_in", 3600);
                SecureStore secure = new SecureStore(context);
                try {
                    secure.put(CACHE_KEY, token);
                    secure.put(EXPIRY_KEY, String.valueOf(System.currentTimeMillis() + expiresIn * 1000L));
                } catch (Exception ignored) { /* the token still works for this call */ }
                callback.onResult(token, null);
                return;
            }
            callback.onResult(null, message(status, error));
        });
    }

    private static void send(Context context, JSONObject body, RawCallback callback) {
        SupabaseAuth auth = new SupabaseAuth(context);
        SupabaseAuth.Session session = auth.session();
        if (session == null) { callback.onResult(0, "not_signed_in", null); return; }
        if (session.expiringSoon()) {
            auth.refresh((ok, note) -> {
                if (!ok) { callback.onResult(0, "not_signed_in", null); return; }
                sendWith(context, body, callback);
            });
            return;
        }
        sendWith(context, body, callback);
    }

    private static void sendWith(Context context, JSONObject body, RawCallback callback) {
        SupabaseAuth.Session session = new SupabaseAuth(context).session();
        if (session == null) { callback.onResult(0, "not_signed_in", null); return; }
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(ROUTE).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setRequestProperty("apikey", SupabaseAuth.PUBLISHABLE_KEY);
            connection.setRequestProperty("Authorization", "Bearer " + session.accessToken);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "application/json");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            int status = connection.getResponseCode();
            String text = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            JSONObject response = null;
            try { response = new JSONObject(text); } catch (Exception ignored) { }
            String error = response == null ? "" : response.optString("error", "");
            callback.onResult(status, error, response);
        } catch (Exception e) {
            callback.onResult(-1, "network", null);
        } finally { if (connection != null) connection.disconnect(); }
    }

    /** Short, actionable text. Never echoes tokens or Google's raw payload. */
    private static String message(int status, String error) { return DriveErrors.message(status, error); }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "{}";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096]; int n;
        while ((n = in.read(buffer)) >= 0 && out.size() < 256 * 1024) out.write(buffer, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
