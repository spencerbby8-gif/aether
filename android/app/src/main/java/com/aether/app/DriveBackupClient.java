package com.aether.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/** Minimal Google Drive appDataFolder backup API; no agent permissions involved. */
final class DriveBackupClient {
    interface Callback { void onResult(boolean ok, String value); }

    private DriveBackupClient() { }

    static void latest(String token, Callback callback) {
        new Thread(() -> {
            String query = "name='aether-workspace-backup.json' and trashed=false";
            String route = "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=" + enc(query)
                    + "&orderBy=" + enc("modifiedTime desc") + "&pageSize=1&fields=" + enc("files(id,name,modifiedTime,size)");
            request("GET", route, token, null, null, callback);
        }, "aether-drive-list").start();
    }

    static void upload(String token, String snapshot, Callback callback) {
        latest(token, (ok, value) -> {
            if (!ok) { callback.onResult(false, value); return; }
            new Thread(() -> {
                try {
                    JSONObject list = new JSONObject(value); JSONArray files = list.optJSONArray("files");
                    if (files != null && files.length() > 0) {
                        String id = files.getJSONObject(0).getString("id");
                        request("PATCH", "https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=media",
                                token, "application/json; charset=utf-8", snapshot.getBytes(StandardCharsets.UTF_8), callback);
                    } else {
                        JSONObject metadata = new JSONObject().put("name", "aether-workspace-backup.json")
                                .put("parents", new JSONArray().put("appDataFolder"));
                        request("POST", "https://www.googleapis.com/drive/v3/files?fields=id", token,
                                "application/json; charset=utf-8", metadata.toString().getBytes(StandardCharsets.UTF_8), (created, response) -> {
                                    if (!created) { callback.onResult(false, response); return; }
                                    try {
                                        String id = new JSONObject(response).getString("id");
                                        request("PATCH", "https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=media",
                                                token, "application/json; charset=utf-8", snapshot.getBytes(StandardCharsets.UTF_8), callback);
                                    } catch (Exception e) { callback.onResult(false, "Drive created no backup file ID."); }
                                });
                    }
                } catch (Exception e) { callback.onResult(false, "Could not read the Drive backup list."); }
            }, "aether-drive-upload").start();
        });
    }

    static void download(String token, String id, Callback callback) {
        new Thread(() -> request("GET", "https://www.googleapis.com/drive/v3/files/" + id + "?alt=media",
                token, null, null, callback), "aether-drive-download").start();
    }

    private static void request(String method, String url, String token, String contentType, byte[] body, Callback callback) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod(method); connection.setConnectTimeout(15000); connection.setReadTimeout(30000);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Accept", "application/json");
            if (body != null) {
                connection.setDoOutput(true); connection.setRequestProperty("Content-Type", contentType);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            }
            int status = connection.getResponseCode();
            String text = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            if (status < 200 || status >= 300) {
                callback.onResult(false, publicError(status, text)); return;
            }
            callback.onResult(true, text);
        } catch (Exception e) { callback.onResult(false, "Google Drive network request failed. Check your connection and try again."); }
        finally { if (connection != null) connection.disconnect(); }
    }

    private static String publicError(int status, String body) {
        if (status == 401 || status == 403) return "Google Drive permission expired or was not granted. Reconnect Drive backup; this does not change Agent connector permissions.";
        if (status == 404) return "No app backup was found in Google Drive.";
        return "Google Drive returned HTTP " + status + ". Try again.";
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "{}";
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int n;
        while ((n = in.read(buffer)) >= 0) {
            out.write(buffer, 0, n);
            if (out.size() > 24 * 1024 * 1024) throw new IllegalStateException("Backup is too large");
        }
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private static String enc(String value) {
        try { return URLEncoder.encode(value, StandardCharsets.UTF_8.name()); }
        catch (Exception e) { return ""; }
    }
}
