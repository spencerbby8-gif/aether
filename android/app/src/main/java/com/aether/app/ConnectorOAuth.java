package com.aether.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/** OAuth 2.0 + PKCE for remote MCP servers. No client secret is embedded. */
final class ConnectorOAuth {
    interface Status { void status(String message, boolean connected); }
    private static final String PREFS = "aether_connector_oauth_pending";
    private static final String CALLBACK = "aether://connector/callback";
    private static final SecureRandom RANDOM = new SecureRandom();
    private ConnectorOAuth() { }

    static void start(Context context, ConnectorStore.Connector connector, Status status) {
        Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                URI endpoint = URI.create(connector.url);
                requireHttps(endpoint);
                JSONObject discovery = discover(endpoint);
                String registration = discovery.optString("registration_endpoint");
                String authorization = required(discovery, "authorization_endpoint");
                String token = required(discovery, "token_endpoint");
                validateProviderEndpoint(connector.url, authorization);
                validateProviderEndpoint(connector.url, token);
                String clientId = connector.oauthClientId == null ? "" : connector.oauthClientId.trim();
                if (!clientId.isEmpty()) {
                    requireHttps(URI.create(clientId)); // Vercel CIMD; no client secret or preregistration.
                } else {
                    if (registration.isEmpty()) throw new Exception("This provider does not advertise dynamic client registration. Use a bearer token or an HTTPS CIMD client metadata URL instead.");
                    validateProviderEndpoint(connector.url, registration);
                    JSONObject client = request("POST", registration, new JSONObject()
                            .put("client_name", "Aether Android")
                            .put("redirect_uris", new org.json.JSONArray().put(CALLBACK))
                            .put("grant_types", new org.json.JSONArray().put("authorization_code").put("refresh_token"))
                            .put("response_types", new org.json.JSONArray().put("code"))
                            .put("token_endpoint_auth_method", "none").toString(), "application/json");
                    clientId = required(client, "client_id");
                }
                String state = random(32), verifier = random(64);
                String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(
                        MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
                app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear()
                        .putString("connector", connector.id).putString("state", state)
                        .putString("verifier", verifier).putString("client_id", clientId)
                        .putString("token_endpoint", token).apply();
                String auth = authorization + (authorization.contains("?") ? "&" : "?")
                        + "response_type=code&client_id=" + enc(clientId)
                        + "&redirect_uri=" + enc(CALLBACK) + "&state=" + enc(state)
                        + "&code_challenge=" + enc(challenge) + "&code_challenge_method=S256"
                        + "&scope=" + enc(scopes(discovery));
                Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(auth));
                open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                app.startActivity(open);
                status.status("Complete sign-in in your browser. Aether will not mark the connector active until the token exchange succeeds.", false);
            } catch (Exception e) {
                status.status("OAuth setup failed: " + safe(e), false);
            }
        }, "aether-mcp-oauth-start").start();
    }

    static void handleCallback(Context context, Uri uri, Status status) {
        Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                String error = uri.getQueryParameter("error");
                if (error != null) throw new Exception("Provider returned " + error + ": " + String.valueOf(uri.getQueryParameter("error_description")));
                SharedPreferences pending = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                String expected = pending.getString("state", "");
                String actual = uri.getQueryParameter("state");
                if (expected.isEmpty() || actual == null || !MessageDigest.isEqual(
                        expected.getBytes(StandardCharsets.UTF_8), actual.getBytes(StandardCharsets.UTF_8))) {
                    throw new Exception("OAuth state did not match; the callback was rejected.");
                }
                String code = uri.getQueryParameter("code");
                if (code == null || code.isEmpty()) throw new Exception("OAuth callback did not contain an authorization code.");
                String id = pending.getString("connector", "");
                ConnectorStore store = new ConnectorStore(app);
                ConnectorStore.Connector connector = store.find(id);
                if (connector == null) throw new Exception("The connector was removed before sign-in completed.");
                String tokenEndpoint = pending.getString("token_endpoint", "");
                String clientId = pending.getString("client_id", "");
                validateProviderEndpoint(connector.url, tokenEndpoint);
                JSONObject tokens = request("POST", tokenEndpoint, form(
                        "grant_type", "authorization_code", "code", code,
                        "redirect_uri", CALLBACK, "client_id", clientId,
                        "code_verifier", pending.getString("verifier", "")), "application/x-www-form-urlencoded");
                saveTokens(app, store, connector, clientId, tokenEndpoint, tokens);
                pending.edit().clear().apply();
                status.status(connector.name + " connected with OAuth. Agent tools will use the permissions you granted.", true);
            } catch (Exception e) {
                status.status("OAuth connection failed: " + safe(e), false);
            }
        }, "aether-mcp-oauth-callback").start();
    }

    static boolean refreshBlocking(Context context, ConnectorStore.Connector connector) {
        try {
            SecureStore secure = new SecureStore(context);
            String refresh = secure.get("connector_refresh_" + connector.id);
            if (refresh == null || refresh.isEmpty()) return false;
            validateProviderEndpoint(connector.url, connector.tokenEndpoint);
            JSONObject tokens = request("POST", connector.tokenEndpoint, form(
                    "grant_type", "refresh_token", "refresh_token", refresh,
                    "client_id", connector.oauthClientId), "application/x-www-form-urlencoded");
            saveTokens(context, new ConnectorStore(context), connector,
                    connector.oauthClientId, connector.tokenEndpoint, tokens);
            return true;
        } catch (Exception e) { return false; }
    }

    private static void saveTokens(Context context, ConnectorStore store,
                                   ConnectorStore.Connector connector, String clientId,
                                   String tokenEndpoint, JSONObject tokens) throws Exception {
        String access = required(tokens, "access_token");
        connector.oauth = true;
        connector.oauthClientId = clientId;
        connector.tokenEndpoint = tokenEndpoint;
        connector.expiresAt = System.currentTimeMillis() + Math.max(60, tokens.optLong("expires_in", 3600)) * 1000L;
        connector.enabled = true;
        store.save(connector, access);
        String refresh = tokens.optString("refresh_token");
        if (!refresh.isEmpty()) new SecureStore(context).put("connector_refresh_" + connector.id, refresh);
    }

    private static JSONObject discover(URI endpoint) throws Exception {
        String origin = endpoint.getScheme() + "://" + endpoint.getAuthority();
        String path = endpoint.getPath() == null ? "" : endpoint.getPath();
        String suffix = path.endsWith("/") ? path.substring(0, path.length() - 1) : path;
        String authorizationServer = origin;
        try {
            JSONObject resource = request("GET", origin + "/.well-known/oauth-protected-resource" + suffix, null, null);
            org.json.JSONArray servers = resource.optJSONArray("authorization_servers");
            if (servers != null && servers.length() > 0) authorizationServer = servers.getString(0);
            validateProviderEndpoint(endpoint.toString(), authorizationServer);
        } catch (Exception ignored) {
            // Older MCP servers can advertise only authorization-server metadata.
        }
        URI server = URI.create(authorizationServer);
        String serverOrigin = server.getScheme() + "://" + server.getAuthority();
        String serverPath = server.getPath() == null ? "" : server.getPath();
        String serverSuffix = serverPath.endsWith("/") ? serverPath.substring(0, serverPath.length() - 1) : serverPath;
        String[] urls = {serverOrigin + "/.well-known/oauth-authorization-server" + serverSuffix,
                serverOrigin + "/.well-known/oauth-authorization-server",
                origin + "/.well-known/oauth-authorization-server" + suffix,
                origin + "/.well-known/oauth-authorization-server"};
        Exception last = null;
        for (String url : urls) {
            try { return request("GET", url, null, null); }
            catch (Exception e) { last = e; }
        }
        throw new Exception("OAuth discovery failed: " + safe(last));
    }

    private static String scopes(JSONObject discovery) {
        org.json.JSONArray supported = discovery.optJSONArray("scopes_supported");
        if (supported == null || supported.length() == 0) return "openid";
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < supported.length(); i++) {
            String scope = supported.optString(i);
            // Broad project/database/functions/storage automation without
            // requesting Supabase's edge-function secret-reading scope.
            if (scope.equals("secrets:read") || scope.isEmpty()) continue;
            if (out.length() > 0) out.append(' '); out.append(scope);
        }
        return out.length() == 0 ? "openid" : out.toString();
    }

    private static JSONObject request(String method, String url, String body, String contentType) throws Exception {
        URI uri = URI.create(url); requireHttps(uri);
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(15_000); c.setReadTimeout(30_000); c.setRequestMethod(method);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("User-Agent", "Aether-Android/3.1");
        if (body != null) {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            c.setDoOutput(true); c.setRequestProperty("Content-Type", contentType);
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
        }
        int code = c.getResponseCode();
        InputStream stream = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = read(stream);
        if (code == 401 && text.contains("WWW-Authenticate")) throw new Exception("OAuth authorization is required (HTTP 401).");
        if (code < 200 || code >= 300) throw new Exception("HTTP " + code + " from " + uri.getHost() + (text.isEmpty() ? "" : ": " + text.substring(0, Math.min(240, text.length()))));
        if (text.isEmpty()) return new JSONObject();
        return new JSONObject(text);
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096]; int count;
        try (InputStream input = in) {
            while ((count = input.read(buffer)) > 0 && out.size() < 1_000_000) out.write(buffer, 0, count);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void validateProviderEndpoint(String mcp, String endpoint) throws Exception {
        URI a = URI.create(mcp), b = URI.create(endpoint); requireHttps(b);
        String host = a.getHost() == null ? "" : a.getHost().toLowerCase(java.util.Locale.ROOT);
        String target = b.getHost() == null ? "" : b.getHost().toLowerCase(java.util.Locale.ROOT);
        String domain = host.endsWith("supabase.com") ? "supabase.com" : host.endsWith("vercel.com") ? "vercel.com" : host;
        if (!(target.equals(domain) || target.endsWith("." + domain))) throw new Exception("OAuth endpoint is outside the provider's HTTPS domain.");
    }
    private static void requireHttps(URI uri) throws Exception {
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) throw new Exception("OAuth endpoints must be valid HTTPS URLs without embedded credentials.");
    }
    private static String required(JSONObject value, String key) throws Exception {
        String out = value.optString(key); if (out.isEmpty()) throw new Exception("OAuth response is missing " + key + "."); return out;
    }
    private static String random(int bytes) {
        byte[] value = new byte[bytes]; RANDOM.nextBytes(value);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }
    private static String enc(String value) throws Exception { return URLEncoder.encode(value, "UTF-8"); }
    private static String form(String... values) throws Exception {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < values.length; i += 2) {
            if (i > 0) out.append('&'); out.append(enc(values[i])).append('=').append(enc(values[i + 1]));
        }
        return out.toString();
    }
    private static String safe(Exception e) {
        String message = e == null ? "unknown error" : String.valueOf(e.getMessage());
        return message.replaceAll("(?i)(access_token|refresh_token|code_verifier)[=:]\\S+", "$1=[redacted]");
    }
}
