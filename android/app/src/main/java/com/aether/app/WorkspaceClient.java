package com.aether.app;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/** Authenticated file API for the exact remote workspace used by agent tools. */
public final class WorkspaceClient {
    public interface Callback { void onResult(boolean ok, String value); }

    private WorkspaceClient() { }

    public static void list(String engine, String key, String session, String path, Callback cb) {
        request(engine, key, "GET", "/api/workspace/list?session=" + enc(session) + "&path=" + enc(path), null, cb);
    }

    public static void read(String engine, String key, String session, String path, Callback cb) {
        request(engine, key, "GET", "/api/workspace/read?session=" + enc(session) + "&path=" + enc(path), null, cb);
    }

    public static void write(String engine, String key, String session, String path, String content, Callback cb) {
        try {
            JSONObject body = new JSONObject();
            body.put("session", session); body.put("path", path); body.put("content", content);
            request(engine, key, "POST", "/api/workspace/write", body, cb);
        } catch (Exception e) { cb.onResult(false, safe(e)); }
    }

    public static void mkdir(String engine, String key, String session, String path, Callback cb) {
        action(engine, key, session, path, "/api/workspace/mkdir", cb);
    }

    public static void delete(String engine, String key, String session, String path, Callback cb) {
        action(engine, key, session, path, "/api/workspace/delete", cb);
    }

    private static void action(String engine, String key, String session, String path, String route, Callback cb) {
        try {
            JSONObject body = new JSONObject(); body.put("session", session); body.put("path", path);
            request(engine, key, "POST", route, body, cb);
        } catch (Exception e) { cb.onResult(false, safe(e)); }
    }

    private static void request(String engine, String key, String method, String route,
                                JSONObject body, Callback cb) {
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                boolean loopback = engine != null && (engine.startsWith("http://127.0.0.1") || engine.startsWith("http://localhost"));
                if (engine == null || (!engine.startsWith("https://") && !loopback)) throw new IllegalStateException("No ready Agent workspace is available. Start an Agent task first.");
                connection = (HttpURLConnection) new URL(engine + route).openConnection();
                connection.setRequestMethod(method);
                connection.setConnectTimeout(12000); connection.setReadTimeout(20000);
                connection.setRequestProperty("X-Engine-Key", key == null ? "" : key);
                connection.setRequestProperty("Accept", "application/json");
                if (body != null) {
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                    connection.setFixedLengthStreamingMode(bytes.length);
                    connection.getOutputStream().write(bytes);
                }
                int status = connection.getResponseCode();
                String text = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
                JSONObject json = new JSONObject(text);
                if (status < 200 || status >= 300) throw new IllegalStateException(json.optString("error", "Workspace request failed (" + status + ")"));
                cb.onResult(true, text);
            } catch (Exception e) { cb.onResult(false, safe(e)); }
            finally { if (connection != null) connection.disconnect(); }
        }, "aether-workspace").start();
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "{}";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192]; int n;
        while ((n = in.read(buffer)) >= 0) {
            out.write(buffer, 0, n);
            if (out.size() > 2 * 1024 * 1024) throw new IllegalStateException("Workspace response is too large");
        }
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private static String enc(String value) {
        try { return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8.name()); }
        catch (Exception e) { return ""; }
    }

    private static String safe(Exception e) {
        String value = e.getMessage();
        return value == null || value.trim().isEmpty() ? e.getClass().getSimpleName() : value;
    }
}
