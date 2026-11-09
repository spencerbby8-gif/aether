package com.aether.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Explicit MCP endpoint grants; secrets remain encrypted on the device. */
public final class ConnectorStore {
    private static final String PREFS = "aether_connectors_v1";
    private final SharedPreferences prefs;
    private final SecureStore secure;
    private final Context appContext;

    public ConnectorStore(Context context) {
        Context app = context.getApplicationContext();
        appContext = app;
        prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        secure = new SecureStore(app);
    }

    public synchronized List<Connector> list() {
        ArrayList<Connector> out = new ArrayList<>();
        try {
            JSONArray values = new JSONArray(prefs.getString("items", "[]"));
            for (int i = 0; i < values.length(); i++) out.add(Connector.from(values.getJSONObject(i)));
        } catch (Exception ignored) { }
        return out;
    }

    public synchronized Connector find(String id) {
        for (Connector item : list()) if (item.id.equals(id)) return item;
        return null;
    }

    public synchronized void save(Connector connector, String token) throws Exception {
        if (connector.id == null || connector.id.isEmpty()) connector.id = "mcp_" + java.util.UUID.randomUUID();
        if (connector.name == null || connector.name.trim().isEmpty()) throw new Exception("Name the connection.");
        if (connector.url == null || !connector.url.startsWith("https://")) throw new Exception("Use an HTTPS MCP server URL.");
        java.net.URI uri = java.net.URI.create(connector.url);
        if (uri.getUserInfo() != null || (uri.getQuery() != null
                && uri.getQuery().toLowerCase(java.util.Locale.ROOT).matches(".*(token|secret|key|auth|credential).*"))) {
            throw new Exception("Keep credentials out of the MCP URL; use the encrypted token field.");
        }
        if (token != null && !token.isEmpty()) secure.put(secretKey(connector.id), token);
        List<Connector> all = list(); boolean replaced = false;
        for (int i = 0; i < all.size(); i++) if (all.get(i).id.equals(connector.id)) { all.set(i, connector); replaced = true; }
        if (!replaced) all.add(connector); write(all);
    }

    public synchronized void delete(String id) {
        List<Connector> kept = new ArrayList<>();
        for (Connector item : list()) if (!item.id.equals(id)) kept.add(item);
        write(kept); secure.remove(secretKey(id)); secure.remove("connector_refresh_" + id);
    }

    /** Decrypted only while constructing an authenticated Agent engine request. */
    public JSONArray enabledPayload() {
        JSONArray out = new JSONArray();
        for (Connector item : list()) {
            if (!item.enabled) continue;
            if (item.oauth && item.expiresAt > 0 && item.expiresAt < System.currentTimeMillis() + 60_000) {
                ConnectorOAuth.refreshBlocking(appContext, item);
                item = find(item.id);
                if (item == null || !item.enabled) continue;
            }
            try {
                JSONObject value = item.toJson();
                value.put("token", secure.get(secretKey(item.id)));
                out.put(value);
            } catch (Exception ignored) { }
        }
        return out;
    }

    public boolean hasEnabled() {
        for (Connector item : list()) if (item.enabled) return true;
        return false;
    }

    private void write(List<Connector> all) {
        JSONArray values = new JSONArray();
        for (Connector item : all) values.put(item.toJson());
        prefs.edit().putString("items", values.toString()).apply();
    }

    private static String secretKey(String id) { return "connector_token_" + id; }

    public static final class Connector {
        public String id = "", name = "", url = "", token = "";
        public boolean enabled;
        public boolean read = true, write, execute;
        public String repository = "";
        public boolean oauth;
        public String oauthClientId = "", tokenEndpoint = "";
        public long expiresAt;

        JSONObject toJson() {
            try {
                return new JSONObject().put("id", id).put("name", name).put("url", url)
                        .put("enabled", enabled).put("read", read).put("write", write)
                        .put("execute", execute).put("repository", repository)
                        .put("oauth", oauth).put("oauthClientId", oauthClientId)
                        .put("tokenEndpoint", tokenEndpoint).put("expiresAt", expiresAt);
            } catch (Exception e) { return new JSONObject(); }
        }
        static Connector from(JSONObject value) {
            Connector c = new Connector(); c.id = value.optString("id"); c.name = value.optString("name");
            c.url = value.optString("url"); c.enabled = value.optBoolean("enabled");
            c.read = value.optBoolean("read", true); c.write = value.optBoolean("write");
            c.execute = value.optBoolean("execute"); c.repository = value.optString("repository");
            c.oauth = value.optBoolean("oauth"); c.oauthClientId = value.optString("oauthClientId");
            c.tokenEndpoint = value.optString("tokenEndpoint"); c.expiresAt = value.optLong("expiresAt"); return c;
        }
        public Connector copy() { return from(toJson()); }
    }
}
