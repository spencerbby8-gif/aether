package com.aether.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import com.aether.app.core.ChatStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.util.Map;

/** WhatsApp-style account-linked app/session backup using private Drive app data. */
public final class BackupActivity extends AppCompatActivity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private SupabaseAuth auth;
    private TextView state, latest, backup, restore, connect;
    private String latestId = "";
    private boolean busy;

    @Override protected void onCreate(@Nullable Bundle saved) {
        super.onCreate(saved);
        auth = new SupabaseAuth(this);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(Ui.dp(this, 22), Ui.dp(this, 16), Ui.dp(this, 22), Ui.dp(this, 16));
        root.setBackgroundColor(getColor(R.color.aether_bg));
        ScrollView scroll = new ScrollView(this); scroll.addView(root); setContentView(scroll); Ui.applySystemBars(this);
        TextView back = Ui.tv(this, "‹  Back", 15, Ui.DIM); back.setOnClickListener(v -> finish());
        root.addView(back, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Ui.dp(this, 48)));
        TextView title = Ui.tv(this, "Backup & restore", 29, Ui.PRIMARY); title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        title.setPadding(0, Ui.dp(this, 30), 0, Ui.dp(this, 10)); root.addView(title);
        TextView intro = Ui.tv(this, "Keep your chats and non-secret preferences in your own Google Drive’s private app-data folder. Restore merges sessions and never overwrites a newer local chat.", 14, Ui.DIM); root.addView(intro);
        state = Ui.tv(this, "", 13, Ui.DIM); state.setPadding(0, Ui.dp(this, 20), 0, Ui.dp(this, 12)); root.addView(state);
        connect = action("Connect Google Drive", v -> connect()); root.addView(connect);
        backup = action("Back up now", v -> backup()); root.addView(backup);
        restore = action("Restore latest backup", v -> restore()); root.addView(restore);
        latest = Ui.tv(this, "No backup checked yet.", 12, Ui.DIM); latest.setPadding(0, Ui.dp(this, 18), 0, 0); root.addView(latest);
        TextView privacy = Ui.tv(this, "Included: chat transcripts and ordinary app preferences.\n\nExcluded: Supabase sessions, Google tokens, personal-provider keys, GitHub/MCP tokens and connector secrets.\n\nDrive backup authorization is separate from the optional Drive Agent connector. Google OAuth must be configured in Supabase before connection can succeed.", 12, Ui.DIM);
        privacy.setPadding(0, Ui.dp(this, 30), 0, 0); root.addView(privacy);
    }

    private TextView action(String text, android.view.View.OnClickListener listener) {
        TextView view = Ui.tv(this, text, 14, Ui.PRIMARY); view.setGravity(Gravity.CENTER); view.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        view.setBackgroundResource(R.drawable.bg_settings_row); view.setOnClickListener(listener);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 54)); lp.topMargin = Ui.dp(this, 10); view.setLayoutParams(lp); return view;
    }

    @Override protected void onResume() { super.onResume(); refresh(); }

    private void refresh() {
        if (auth.session() == null) {
            state.setText("Sign in to your Aether account before connecting backup."); backup.setEnabled(false); restore.setEnabled(false); return;
        }
        String token = auth.driveToken();
        state.setText(token.isEmpty() ? "Signed in · Drive backup is not connected" : "Signed in · Google Drive backup is connected");
        connect.setText(token.isEmpty() ? "Connect Google Drive" : "Reconnect Google Drive");
        backup.setEnabled(!token.isEmpty()); restore.setEnabled(!token.isEmpty());
        if (!token.isEmpty() && latestId.isEmpty()) checkLatest();
    }

    private void connect() {
        if (auth.session() == null) { startActivity(new Intent(this, AuthActivity.class)); return; }
        Intent intent = new Intent(this, AuthActivity.class); intent.putExtra("drive_backup", true); startActivity(intent);
    }

    private void checkLatest() {
        DriveBackupClient.latest(auth.driveToken(), (ok, value) -> ui.post(() -> {
            if (!ok) { latest.setText(value); return; }
            try {
                JSONArray files = new JSONObject(value).optJSONArray("files");
                if (files == null || files.length() == 0) { latest.setText("No Aether backup exists yet."); return; }
                JSONObject file = files.getJSONObject(0); latestId = file.getString("id");
                latest.setText("Latest backup · " + file.optString("modifiedTime", "time unavailable") + " · " + file.optString("size", "?") + " bytes");
            } catch (Exception e) { latest.setText("Could not read the Drive backup list."); }
        }));
    }

    private void backup() {
        if (busy || auth.driveToken().isEmpty()) return;
        busy = true; state.setText("Creating local backup snapshot…");
        new Thread(() -> {
            try {
                ChatStore store = new ChatStore(new java.io.File(getFilesDir(), "chats"));
                JSONObject snapshot = new JSONObject().put("schema", 1).put("created_at", System.currentTimeMillis())
                        .put("app_version", BuildConfig.VERSION_NAME).put("chats", store.exportSessions())
                        .put("preferences", preferences());
                // Replace the request payload above with metadata-only connector export.
                JSONArray metadata = new JSONArray();
                for (ConnectorStore.Connector c : new ConnectorStore(this).list()) metadata.put(c.toJson());
                snapshot.put("connectors", metadata);
                byte[] bytes = snapshot.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                String checksum = checksum(bytes);
                snapshot.put("checksum_sha256", checksum);
                DriveBackupClient.upload(auth.driveToken(), snapshot.toString(), (ok, value) -> ui.post(() -> {
                    busy = false; state.setText(ok ? "Backup complete · " + snapshot.optJSONArray("chats").length() + " chats · SHA-256 recorded" : value);
                    if (ok) { latestId = ""; checkLatest(); }
                }));
            } catch (Exception e) { ui.post(() -> { busy = false; state.setText("Could not create the local backup snapshot."); }); }
        }, "aether-backup-snapshot").start();
    }

    private JSONObject preferences() {
        JSONObject out = new JSONObject();
        try {
            for (String store : new String[]{"aether_experience", "aether_console"}) {
                SharedPreferences prefs = getSharedPreferences(store, MODE_PRIVATE);
                for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
                    String key = store + "." + entry.getKey(); Object value = entry.getValue();
                    if (key.toLowerCase(java.util.Locale.ROOT).matches(".*(token|secret|password|key|credential).*")) continue;
                    if (value instanceof String || value instanceof Boolean || value instanceof Integer || value instanceof Long || value instanceof Float) out.put(key, value);
                }
            }
        } catch (Exception ignored) { }
        return out;
    }

    private void restore() {
        if (busy || latestId.isEmpty()) { if (latestId.isEmpty()) checkLatest(); return; }
        busy = true; state.setText("Downloading and validating backup…");
        DriveBackupClient.download(auth.driveToken(), latestId, (ok, value) -> new Thread(() -> {
            if (!ok) { ui.post(() -> { busy = false; state.setText(value); }); return; }
            try {
                JSONObject snapshot = new JSONObject(value); JSONArray chats = snapshot.getJSONArray("chats");
                String checksum = snapshot.optString("checksum_sha256"); snapshot.remove("checksum_sha256");
                // Checksum covers the original pre-checksum payload; validation also enforces schema and JSON.
                if (snapshot.optInt("schema") != 1 || checksum.isEmpty()) throw new IllegalStateException("Unsupported backup schema");
                if (!MessageDigest.isEqual(checksum.getBytes(java.nio.charset.StandardCharsets.US_ASCII),
                        checksum(snapshot.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)).getBytes(java.nio.charset.StandardCharsets.US_ASCII))) {
                    throw new IllegalStateException("Backup checksum mismatch");
                }
                ChatStore store = new ChatStore(new java.io.File(getFilesDir(), "chats"));
                int imported = store.importSessions(chats);
                restorePreferences(snapshot.optJSONObject("preferences"));
                ui.post(() -> { busy = false; state.setText("Restore complete · " + imported + " newer chats and preferences merged"); });
            } catch (Exception e) { ui.post(() -> { busy = false; state.setText("Restore refused: the backup is damaged or uses an unsupported schema."); }); }
        }, "aether-backup-restore").start());
    }

    private void restorePreferences(JSONObject values) {
        if (values == null) return;
        for (java.util.Iterator<String> keys = values.keys(); keys.hasNext();) {
            String key = keys.next();
            int separator = key.indexOf('.');
            if (separator <= 0) continue;
            String store = key.substring(0, separator);
            if (!store.equals("aether_experience") && !store.equals("aether_console")) continue;
            String preference = key.substring(separator + 1);
            SharedPreferences.Editor editor = getSharedPreferences(store, MODE_PRIVATE).edit();
            if (key.toLowerCase(java.util.Locale.ROOT).matches(".*(token|secret|password|key|credential).*")) continue;
            Object value = values.opt(key);
            if (value instanceof Boolean) editor.putBoolean(preference, (Boolean) value);
            else if (value instanceof Integer) editor.putInt(preference, (Integer) value);
            else if (value instanceof Long) editor.putLong(preference, (Long) value);
            else if (value instanceof Float) editor.putFloat(preference, (Float) value);
            else if (value instanceof String) editor.putString(preference, (String) value);
            editor.apply();
        }
    }

    private static String checksum(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder out = new StringBuilder();
        for (byte b : digest) out.append(String.format(java.util.Locale.US, "%02x", b)); return out.toString();
    }
}
