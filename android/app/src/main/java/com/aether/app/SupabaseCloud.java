package com.aether.app;

import android.content.Context;

import com.aether.app.core.ChatSession;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Per-user Supabase session sync; service-role keys are never present. */
final class SupabaseCloud {
    private SupabaseCloud() { }

    static void sync(Context context, ChatSession chat) {
        SupabaseAuth auth = new SupabaseAuth(context);
        SupabaseAuth.Session session = auth.session();
        if (session == null || session.userId.isEmpty() || chat == null) return;
        if (session.expiringSoon()) {
            auth.refresh((ok, message) -> { if (ok) sync(context, chat); });
            return;
        }
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                JSONObject row = new JSONObject().put("user_id", session.userId).put("local_id", chat.id)
                        .put("title", chat.title == null ? "New chat" : chat.title).put("payload", chat.toJson());
                connection = (HttpURLConnection) new URL(SupabaseAuth.PROJECT_URL
                        + "/rest/v1/chat_sessions?on_conflict=user_id,local_id").openConnection();
                connection.setRequestMethod("POST"); connection.setConnectTimeout(12000); connection.setReadTimeout(20000);
                connection.setRequestProperty("apikey", SupabaseAuth.PUBLISHABLE_KEY);
                connection.setRequestProperty("Authorization", "Bearer " + session.accessToken);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("Prefer", "resolution=merge-duplicates,return=minimal");
                byte[] bytes = row.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
                int status = connection.getResponseCode();
                // Consume the response without logging content or credentials.
                read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            } catch (Exception ignored) {
                // Local persistence remains authoritative when offline.
            } finally { if (connection != null) connection.disconnect(); }
        }, "aether-cloud-sync").start();
    }

    private static void read(InputStream in) throws Exception {
        if (in == null) return;
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[2048]; int n;
        while ((n = in.read(buffer)) >= 0 && out.size() < 65536) out.write(buffer, 0, n);
    }
}
