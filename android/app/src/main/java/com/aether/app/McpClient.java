package com.aether.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Small Streamable-HTTP MCP client: initialize, tools/list and tools/call. */
public final class McpClient {
    public static final class Config {
        public String url = "";
        public String token = "";
        public String name = "Connector";
    }

    public static final class Tool {
        public String name = "";
        public String description = "";
        public JSONObject inputSchema = new JSONObject();
    }

    public static final class CallResult {
        public final String text;
        public final boolean isError;
        CallResult(String text, boolean isError) { this.text = text; this.isError = isError; }
    }

    public interface Transport {
        String post(Config config, String sessionId, String body, boolean notification,
                    java.util.concurrent.atomic.AtomicReference<String> newSession) throws Exception;
    }

    private final Config config;
    private final Transport transport;
    private String sessionId = "";
    private int nextId = 1;

    public McpClient(Config input) throws Exception {
        this(input, new HttpTransport());
    }

    public McpClient(Config input, Transport transport) throws Exception {
        config = new Config();
        config.url = input == null ? "" : input.url.trim();
        config.token = input == null || input.token == null ? "" : input.token.trim();
        config.name = input == null || input.name == null ? "Connector" : input.name;
        this.transport = transport;
        if (!config.url.startsWith("https://")) throw new Exception("MCP connectors require HTTPS.");
        if (transport instanceof HttpTransport) validatePublicEndpoint(config.url);
    }

    public synchronized List<Tool> listTools() throws Exception {
        initialize();
        JSONObject response = request("tools/list", new JSONObject());
        JSONArray values = response.optJSONArray("tools");
        List<Tool> out = new ArrayList<>();
        if (values != null) for (int i = 0; i < values.length() && i < 100; i++) {
            JSONObject value = values.optJSONObject(i);
            if (value == null) continue;
            Tool tool = new Tool();
            tool.name = value.optString("name", "").trim();
            tool.description = value.optString("description", "");
            JSONObject schema = value.optJSONObject("inputSchema");
            if (schema != null) tool.inputSchema = schema;
            if (!tool.name.isEmpty()) out.add(tool);
        }
        return out;
    }

    public synchronized CallResult call(String tool, JSONObject arguments) throws Exception {
        initialize();
        JSONObject params = new JSONObject().put("name", tool)
                .put("arguments", arguments == null ? new JSONObject() : arguments);
        JSONObject result = request("tools/call", params);
        StringBuilder text = new StringBuilder();
        JSONArray content = result.optJSONArray("content");
        if (content != null) for (int i = 0; i < content.length(); i++) {
            JSONObject item = content.optJSONObject(i);
            if (item == null) continue;
            if ("text".equals(item.optString("type"))) {
                if (text.length() > 0) text.append('\n');
                text.append(item.optString("text", ""));
            } else {
                if (text.length() > 0) text.append('\n');
                text.append(item.toString());
            }
        }
        JSONObject structured = result.optJSONObject("structuredContent");
        if (structured != null) {
            if (text.length() > 0) text.append('\n');
            text.append(structured.toString(2));
        }
        if (text.length() == 0) text.append(result.toString());
        return new CallResult(clip(text.toString(), 160_000), result.optBoolean("isError", false));
    }

    private void initialize() throws Exception {
        if (nextId > 1) return;
        JSONObject params = new JSONObject()
                .put("protocolVersion", "2025-06-18")
                .put("capabilities", new JSONObject())
                .put("clientInfo", new JSONObject().put("name", "Aether Android").put("version", "3.2.0"));
        request("initialize", params);
        JSONObject notification = new JSONObject().put("jsonrpc", "2.0")
                .put("method", "notifications/initialized");
        transport.post(config, sessionId, notification.toString(), true,
                new java.util.concurrent.atomic.AtomicReference<String>());
    }

    private JSONObject request(String method, JSONObject params) throws Exception {
        int id = nextId++;
        JSONObject call = new JSONObject().put("jsonrpc", "2.0").put("id", id)
                .put("method", method).put("params", params);
        java.util.concurrent.atomic.AtomicReference<String> newSession = new java.util.concurrent.atomic.AtomicReference<>();
        String raw = transport.post(config, sessionId, call.toString(), false, newSession);
        if (newSession.get() != null && !newSession.get().isEmpty()) sessionId = newSession.get();
        JSONObject response = decode(raw);
        if (response.optInt("id", -1) != id) throw new Exception("MCP response ID did not match the request.");
        JSONObject error = response.optJSONObject("error");
        if (error != null) throw new Exception("MCP " + method + ": " + error.optString("message", "request failed"));
        JSONObject result = response.optJSONObject("result");
        if (result == null) throw new Exception("MCP " + method + " returned no result.");
        return result;
    }

    private static JSONObject decode(String raw) throws Exception {
        String text = raw == null ? "" : raw.trim();
        if (text.startsWith("{")) return new JSONObject(text);
        StringBuilder data = new StringBuilder();
        for (String line : text.split("\\r?\\n")) {
            if (line.startsWith("data:")) {
                if (data.length() > 0) data.append('\n');
                data.append(line.substring(5).trim());
            }
        }
        return new JSONObject(data.toString());
    }

    private static void validatePublicEndpoint(String raw) throws Exception {
        URL url = new URL(raw);
        if (url.getUserInfo() != null) throw new Exception("Keep MCP credentials out of the URL.");
        InetAddress[] addresses = InetAddress.getAllByName(url.getHost());
        if (addresses.length == 0) throw new Exception("MCP host could not be resolved.");
        for (InetAddress address : addresses) {
            if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
                    || address.isSiteLocalAddress() || address.isMulticastAddress()) {
                throw new Exception("Private and local MCP addresses are not allowed.");
            }
        }
    }

    private static String clip(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max) + "\n[connector result truncated]";
    }

    static final class HttpTransport implements Transport {
        @Override public String post(Config config, String sessionId, String body, boolean notification,
                                     java.util.concurrent.atomic.AtomicReference<String> newSession) throws Exception {
            HttpURLConnection c = (HttpURLConnection) new URL(config.url).openConnection();
            try {
                c.setRequestMethod("POST");
                c.setConnectTimeout(15_000);
                c.setReadTimeout(45_000);
                c.setRequestProperty("Accept", "application/json, text/event-stream");
                c.setRequestProperty("Content-Type", "application/json");
                c.setRequestProperty("MCP-Protocol-Version", "2025-06-18");
                if (!config.token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + config.token);
                if (sessionId != null && !sessionId.isEmpty()) c.setRequestProperty("Mcp-Session-Id", sessionId);
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
                int status = c.getResponseCode();
                String session = c.getHeaderField("Mcp-Session-Id");
                if (session != null) newSession.set(session);
                if (status == 202 && notification) return "{}";
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = read(in);
                if (!config.token.isEmpty()) text = text.replace(config.token, "[redacted]");
                if (status < 200 || status >= 300) throw new Exception("MCP HTTP " + status + ": " + clip(text, 300));
                return text;
            } finally {
                c.disconnect();
            }
        }

        private static String read(InputStream in) throws Exception {
            if (in == null) return "";
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) >= 0) {
                if (out.size() + n > 2 * 1024 * 1024) throw new Exception("MCP response is too large.");
                out.write(buffer, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
