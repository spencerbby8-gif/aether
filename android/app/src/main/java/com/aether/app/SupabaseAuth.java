package com.aether.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/** Supabase Auth REST client. Only the public publishable key is in the app. */
public final class SupabaseAuth {
    public static final String PROJECT_URL = "https://jvuqxazndloiekikzrnb.supabase.co";
    public static final String PUBLISHABLE_KEY = "sb_publishable_cusqr6nSrtwed1VQTJTG_Q_BlVvrdFp";
    public static final String REDIRECT = "aether://auth/callback";
    private static final String SESSION_KEY = "supabase_session_v1";
    private static final String VERIFIER_KEY = "supabase_pkce_verifier_v1";

    public interface Callback { void onResult(boolean ok, String message); }

    private final Context context;
    private final SecureStore secure;

    public SupabaseAuth(Context context) {
        this.context = context.getApplicationContext();
        secure = new SecureStore(this.context);
    }

    public String driveToken() {
        try { return secure.get("google_drive_token"); } catch (Exception e) { return ""; }
    }

    public void clearDriveToken() { secure.remove("google_drive_token"); }

    public Session session() {
        try {
            String value = secure.get(SESSION_KEY);
            return value.isEmpty() ? null : Session.from(new JSONObject(value));
        } catch (Exception e) { return null; }
    }

    public void saveSession(JSONObject value) throws Exception {
        Session session = Session.from(value);
        secure.put(SESSION_KEY, session.toJson().toString());
        if (!session.providerToken.isEmpty()) secure.put("google_drive_token", session.providerToken);
    }

    public void signOut(Callback callback) {
        Session current = session();
        if (current == null) { secure.remove(SESSION_KEY); secure.remove("google_drive_token"); callback.onResult(true, "Signed out"); return; }
        new Thread(() -> {
            request("POST", "/auth/v1/logout", null, current.accessToken, response -> {
                secure.remove(SESSION_KEY);
                secure.remove("google_drive_token");
                callback.onResult(true, "Signed out on this device");
            });
        }, "aether-sign-out").start();
    }

    public void signIn(String email, String password, Callback callback) {
        try {
            JSONObject body = new JSONObject().put("email", email.trim()).put("password", password);
            authenticate("/auth/v1/token?grant_type=password", body, callback);
        } catch (Exception e) { callback.onResult(false, "Could not prepare sign-in."); }
    }

    public void signUp(String email, String password, Callback callback) {
        try {
            JSONObject body = new JSONObject().put("email", email.trim()).put("password", password)
                    .put("options", new JSONObject().put("email_redirect_to", REDIRECT));
            new Thread(() -> request("POST", "/auth/v1/signup", body, null, response -> {
                try {
                    if (response.status < 200 || response.status >= 300) {
                        callback.onResult(false, error(response.body)); return;
                    }
                    JSONObject json = new JSONObject(response.body);
                    if (json.has("access_token")) {
                        saveSession(json); callback.onResult(true, "Account created");
                    } else {
                        callback.onResult(true, "Check your email to confirm your account, then sign in.");
                    }
                } catch (Exception e) { callback.onResult(false, "The account response could not be saved."); }
            }), "aether-sign-up").start();
        } catch (Exception e) { callback.onResult(false, "Could not prepare account creation."); }
    }

    public void resetPassword(String email, Callback callback) {
        try {
            JSONObject body = new JSONObject().put("email", email.trim());
            new Thread(() -> request("POST", "/auth/v1/recover?redirect_to=" + enc(REDIRECT), body, null,
                    response -> callback.onResult(response.status >= 200 && response.status < 300,
                            response.status >= 200 && response.status < 300
                                    ? "If the account exists, a recovery email has been sent." : error(response.body))),
                    "aether-recovery").start();
        } catch (Exception e) { callback.onResult(false, "Could not prepare recovery."); }
    }

    public void startGoogle() throws Exception { startGoogle(false); }

    public void startGoogle(boolean driveBackup) throws Exception {
        byte[] random = new byte[48]; new SecureRandom().nextBytes(random);
        String verifier = Base64.encodeToString(random, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        secure.put(VERIFIER_KEY, verifier);
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
        String challenge = Base64.encodeToString(digest, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        String url = PROJECT_URL + "/auth/v1/authorize?provider=google&redirect_to=" + enc(REDIRECT)
                + "&flow_type=pkce&code_challenge=" + enc(challenge) + "&code_challenge_method=s256"
                + (driveBackup ? "&scopes=" + enc("https://www.googleapis.com/auth/drive.appdata") : "");
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    public void handleRedirect(Uri uri, Callback callback) {
        String code = uri == null ? null : uri.getQueryParameter("code");
        if (code == null || code.isEmpty()) {
            String description = uri == null ? null : uri.getQueryParameter("error_description");
            callback.onResult(false, description == null ? "Sign-in was cancelled or did not return a code." : description);
            return;
        }
        try {
            String verifier = secure.get(VERIFIER_KEY);
            JSONObject body = new JSONObject().put("auth_code", code).put("code_verifier", verifier);
            authenticate("/auth/v1/token?grant_type=pkce", body, callback);
            secure.remove(VERIFIER_KEY);
        } catch (Exception e) { callback.onResult(false, "The Google sign-in session expired. Try again."); }
    }

    public void refresh(Callback callback) {
        Session current = session();
        if (current == null || current.refreshToken.isEmpty()) { callback.onResult(false, "Sign in again."); return; }
        try {
            JSONObject body = new JSONObject().put("refresh_token", current.refreshToken);
            authenticate("/auth/v1/token?grant_type=refresh_token", body, callback);
        } catch (Exception e) { callback.onResult(false, "Could not refresh the session."); }
    }

    private void authenticate(String route, JSONObject body, Callback callback) {
        new Thread(() -> request("POST", route, body, null, response -> {
            try {
                if (response.status < 200 || response.status >= 300) {
                    callback.onResult(false, error(response.body)); return;
                }
                JSONObject json = new JSONObject(response.body);
                saveSession(json);
                callback.onResult(true, "Signed in");
            } catch (Exception e) { callback.onResult(false, "The sign-in response could not be saved securely."); }
        }), "aether-auth").start();
    }

    private static void request(String method, String route, JSONObject body, String token, RawCallback callback) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(PROJECT_URL + route).openConnection();
            connection.setRequestMethod(method); connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
            connection.setRequestProperty("apikey", PUBLISHABLE_KEY);
            connection.setRequestProperty("Accept", "application/json");
            if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            String text = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            callback.onResult(new Response(status, text));
        } catch (Exception e) {
            callback.onResult(new Response(-1, "{\"error_description\":\"Network request failed. Check your connection and try again.\"}"));
        } finally { if (connection != null) connection.disconnect(); }
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "{}";
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int n;
        while ((n = in.read(buffer)) >= 0 && out.size() < 1024 * 1024) out.write(buffer, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private static String error(String body) {
        try {
            JSONObject json = new JSONObject(body);
            String value = json.optString("error_description", json.optString("msg", json.optString("message", "Authentication failed.")));
            return value.replaceAll("(?i)bearer\\s+\\S+", "credential hidden");
        } catch (Exception e) { return "Authentication failed. Try again."; }
    }

    private static String enc(String value) {
        try { return URLEncoder.encode(value, StandardCharsets.UTF_8.name()); }
        catch (Exception e) { return ""; }
    }

    private interface RawCallback { void onResult(Response response); }
    private static final class Response {
        final int status; final String body;
        Response(int status, String body) { this.status = status; this.body = body; }
    }

    public static final class Session {
        public String accessToken = "", refreshToken = "", userId = "", email = "", providerToken = "";
        public long expiresAt;
        static Session from(JSONObject json) {
            Session session = new Session();
            session.accessToken = json.optString("access_token"); session.refreshToken = json.optString("refresh_token");
            session.expiresAt = json.optLong("expires_at");
            session.providerToken = json.optString("provider_token");
            JSONObject user = json.optJSONObject("user");
            if (user != null) { session.userId = user.optString("id"); session.email = user.optString("email"); }
            if (session.accessToken.isEmpty()) throw new IllegalArgumentException("No access token");
            return session;
        }
        JSONObject toJson() {
            try {
                JSONObject user = new JSONObject().put("id", userId).put("email", email);
                return new JSONObject().put("access_token", accessToken).put("refresh_token", refreshToken)
                        .put("expires_at", expiresAt).put("provider_token", providerToken).put("user", user);
            } catch (Exception e) { return new JSONObject(); }
        }
        public boolean expiringSoon() { return expiresAt > 0 && expiresAt * 1000L < System.currentTimeMillis() + 120000L; }
    }
}
