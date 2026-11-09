package com.aether.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Personal OpenAI-compatible providers for the Android app.
 *
 * Pure Java so the exact networking and parser shipped in the APK can run in
 * JVM proofs. Keys arrive in Connection at request time only; metadata JSON
 * deliberately never serializes them. ByokStore supplies the Android Keystore
 * encryption boundary. Direct provider requests do not claim Aether tools.
 */
public final class ByokClient {
    private ByokClient() { }

    public static final class Provider {
        public final String id;
        public final String name;
        public final String description;
        public final String baseUrl;
        public final List<String> suggestedModels;

        Provider(String id, String name, String description, String baseUrl, String... models) {
            this.id = id; this.name = name; this.description = description;
            this.baseUrl = baseUrl; this.suggestedModels = Collections.unmodifiableList(Arrays.asList(models));
        }
    }

    private static final Provider[] PROVIDERS = new Provider[] {
        new Provider("openai", "OpenAI", "GPT models through the OpenAI API.",
                "https://api.openai.com/v1", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"),
        new Provider("openrouter", "OpenRouter", "One key for multiple upstream model providers.",
                "https://openrouter.ai/api/v1", "openai/gpt-4.1-mini", "anthropic/claude-sonnet-4", "google/gemini-2.5-flash"),
        new Provider("groq", "Groq", "Low-latency inference for supported open models.",
                "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", "openai/gpt-oss-20b"),
        new Provider("mistral", "Mistral AI", "Mistral models on La Plateforme.",
                "https://api.mistral.ai/v1", "mistral-small-latest", "mistral-large-latest"),
        new Provider("together", "Together AI", "Open-model inference with an OpenAI-compatible API.",
                "https://api.together.xyz/v1", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-V3"),
        new Provider("cerebras", "Cerebras", "High-speed inference for supported models.",
                "https://api.cerebras.ai/v1", "llama-3.3-70b", "llama3.1-8b"),
        new Provider("xai", "xAI", "Grok models through the xAI API.",
                "https://api.x.ai/v1", "grok-3-mini", "grok-3"),
        new Provider("deepseek", "DeepSeek", "DeepSeek chat and reasoning models.",
                "https://api.deepseek.com/v1", "deepseek-chat", "deepseek-reasoner"),
        new Provider("custom", "Custom OpenAI-compatible", "A public HTTPS /models and /chat/completions endpoint.", "")
    };

    public static List<Provider> providers() {
        return Collections.unmodifiableList(Arrays.asList(PROVIDERS));
    }

    public static Provider provider(String id) {
        for (Provider p : PROVIDERS) if (p.id.equals(id)) return p;
        return PROVIDERS[PROVIDERS.length - 1];
    }

    /** Provider metadata plus a transient key. toMetadata() never includes it. */
    public static final class Connection {
        public String id = "";
        public String provider = "openai";
        public String name = "";
        public String baseUrl = "";
        public String defaultModel = "";
        public boolean enabled = true;
        public boolean hasKey;
        public String apiKey = "";
        public long testedAt;
        public String testStatus = "";
        public String testMessage = "";
        public final List<String> models = new ArrayList<>();

        public Connection copy() {
            Connection c = new Connection();
            c.id = id; c.provider = provider; c.name = name; c.baseUrl = baseUrl;
            c.defaultModel = defaultModel; c.enabled = enabled; c.hasKey = hasKey;
            c.apiKey = apiKey; c.testedAt = testedAt; c.testStatus = testStatus;
            c.testMessage = testMessage; c.models.addAll(models);
            return c;
        }

        public JSONObject toMetadata() throws Exception {
            JSONObject o = new JSONObject();
            o.put("id", id); o.put("provider", provider); o.put("name", name);
            o.put("baseUrl", baseUrl); o.put("defaultModel", defaultModel);
            o.put("enabled", enabled); o.put("hasKey", hasKey);
            o.put("testedAt", testedAt); o.put("testStatus", testStatus);
            o.put("testMessage", testMessage);
            JSONArray ids = new JSONArray();
            for (String model : models) ids.put(model);
            o.put("models", ids);
            return o;
        }

        public static Connection fromMetadata(JSONObject o) {
            Connection c = new Connection();
            c.id = o.optString("id", ""); c.provider = o.optString("provider", "openai");
            c.name = o.optString("name", ""); c.baseUrl = o.optString("baseUrl", "");
            c.defaultModel = o.optString("defaultModel", "");
            c.enabled = o.optBoolean("enabled", true); c.hasKey = o.optBoolean("hasKey", false);
            c.testedAt = o.optLong("testedAt", 0L);
            c.testStatus = o.optString("testStatus", "");
            c.testMessage = o.optString("testMessage", "");
            JSONArray ids = o.optJSONArray("models");
            if (ids != null) for (int i = 0; i < ids.length(); i++) {
                String id = ids.optString(i, "").trim();
                if (!id.isEmpty()) c.models.add(id);
            }
            return c;
        }
    }

    public static final class ChatOptions {
        public String instructions = "";
        public double temperature = 0.7;
        public int maxTokens = 2048;
        public int timeoutMs = 60_000;
        public boolean streaming = true;
    }

    // ------------------------------------------------------------ transport

    public static final class Request {
        public final String method;
        public final String url;
        public final Map<String, String> headers;
        public final String body;
        public final int timeoutMs;

        Request(String method, String url, Map<String, String> headers, String body, int timeoutMs) {
            this.method = method; this.url = url; this.headers = headers;
            this.body = body; this.timeoutMs = timeoutMs;
        }
    }

    public interface Response extends Closeable {
        int status();
        InputStream body() throws IOException;
    }

    public interface Transport {
        Response execute(Request request, EngineCore.TurnHandle handle) throws Exception;
    }

    public static final class HttpTransport implements Transport {
        @Override public Response execute(Request request, EngineCore.TurnHandle handle) throws Exception {
            HttpURLConnection c = (HttpURLConnection) new URL(request.url).openConnection();
            c.setRequestMethod(request.method);
            c.setConnectTimeout(Math.min(20_000, request.timeoutMs));
            c.setReadTimeout(request.timeoutMs);
            c.setInstanceFollowRedirects(true);
            for (Map.Entry<String, String> h : request.headers.entrySet()) {
                c.setRequestProperty(h.getKey(), h.getValue());
            }
            if (request.body != null) {
                c.setDoOutput(true);
                byte[] bytes = request.body.getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
            }
            int status = c.getResponseCode();
            InputStream body = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (body == null) body = new ByteArrayInputStream(new byte[0]);
            if (handle != null) {
                handle.arm(c);
                handle.armStream(body);
            }
            final InputStream responseBody = body;
            return new Response() {
                @Override public int status() { return status; }
                @Override public InputStream body() { return responseBody; }
                @Override public void close() {
                    try { responseBody.close(); } catch (Exception ignored) { }
                    c.disconnect();
                }
            };
        }
    }

    private static Map<String, String> headers(Connection c, boolean stream) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Authorization", "Bearer " + c.apiKey);
        h.put("Accept", stream ? "text/event-stream" : "application/json");
        h.put("Content-Type", "application/json");
        return h;
    }

    /** Canonical request connection. Built-in endpoints cannot be overridden. */
    public static Connection validated(Connection input) throws Exception {
        if (input == null) throw new Exception("A provider connection is required.");
        Connection c = input.copy();
        Provider p = provider(c.provider);
        if (!p.id.equals(c.provider)) throw new Exception("Unknown provider connector.");
        if (c.apiKey == null || c.apiKey.trim().isEmpty()) throw new Exception("An API key is required.");
        if (c.apiKey.length() > 4096) throw new Exception("The API key is too long.");
        c.apiKey = c.apiKey.trim();
        String raw = p.id.equals("custom") ? c.baseUrl.trim() : p.baseUrl;
        if (raw.endsWith("/")) raw = raw.substring(0, raw.length() - 1);
        URL url;
        try { url = new URL(raw); } catch (Exception e) { throw new Exception("A valid provider base URL is required."); }
        if (!"https".equalsIgnoreCase(url.getProtocol())) throw new Exception("Provider connections require HTTPS.");
        if (url.getHost().isEmpty() || url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null) {
            throw new Exception("The provider URL cannot contain credentials, queries, or fragments.");
        }
        String host = url.getHost().toLowerCase(Locale.ROOT);
        if (host.equals("localhost") || host.endsWith(".local") || host.endsWith(".internal")
                || host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")
                || host.startsWith("169.254.") || host.equals("::1") || isPrivate172(host)) {
            throw new Exception("Private and local provider addresses are not allowed.");
        }
        c.baseUrl = raw;
        return c;
    }

    private static boolean isPrivate172(String host) {
        String[] parts = host.split("\\.");
        if (parts.length != 4 || !parts[0].equals("172")) return false;
        try { int b = Integer.parseInt(parts[1]); return b >= 16 && b <= 31; }
        catch (Exception e) { return false; }
    }

    public static List<String> discoverModels(Connection input) throws Exception {
        return discoverModels(input, new HttpTransport());
    }

    public static List<String> discoverModels(Connection input, Transport transport) throws Exception {
        Connection c = validated(input);
        Response response = null;
        try {
            response = transport.execute(new Request("GET", c.baseUrl + "/models",
                    headers(c, false), null, 20_000), null);
            String body = readLimited(response.body(), 1_048_576);
            if (response.status() < 200 || response.status() >= 300) {
                throw upstreamError(response.status(), body, c.apiKey);
            }
            JSONArray data = new JSONObject(body).optJSONArray("data");
            if (data == null) throw new Exception("The provider returned an invalid model list.");
            Set<String> ids = new LinkedHashSet<>();
            for (int i = 0; i < data.length(); i++) {
                String id = data.optJSONObject(i) == null ? "" : data.optJSONObject(i).optString("id", "").trim();
                if (!id.isEmpty()) ids.add(id);
            }
            List<String> sorted = new ArrayList<>(ids);
            Collections.sort(sorted);
            return sorted;
        } finally {
            if (response != null) response.close();
        }
    }

    // ---------------------------------------------------------------- chat

    /** Stream (or read) one personal-provider turn. No automatic cross-provider retry. */
    public static void chat(Connection input, String model, List<EngineCore.Msg> history, String prompt,
                            ChatOptions options, boolean[] cancelled, EngineCore.ChatListener listener,
                            EngineCore.TurnHandle handle) {
        chat(input, model, history, prompt, options, cancelled, listener, handle, new HttpTransport());
    }

    public static void chat(Connection input, String model, List<EngineCore.Msg> history, String prompt,
                            ChatOptions options, boolean[] cancelled, EngineCore.ChatListener listener,
                            EngineCore.TurnHandle handle, Transport transport) {
        Response response = null;
        try {
            Connection c = validated(input);
            if (model == null || model.trim().isEmpty() || model.length() > 300) {
                throw new Exception("A valid model ID is required.");
            }
            ChatOptions opts = options == null ? new ChatOptions() : options;
            JSONObject body = new JSONObject();
            body.put("model", model.trim());
            body.put("temperature", Math.max(0, Math.min(2, opts.temperature)));
            body.put("max_tokens", Math.max(1, Math.min(32_768, opts.maxTokens)));
            body.put("stream", opts.streaming);
            JSONArray messages = new JSONArray();
            if (opts.instructions != null && !opts.instructions.trim().isEmpty()) {
                messages.put(new JSONObject().put("role", "system").put("content", opts.instructions.trim()));
            }
            if (history != null) for (EngineCore.Msg m : history) {
                if (m == null || m.content == null || m.content.isEmpty()) continue;
                messages.put(new JSONObject().put("role", "assistant".equals(m.role) ? "assistant" : "user")
                        .put("content", m.content));
            }
            messages.put(new JSONObject().put("role", "user").put("content", prompt == null ? "" : prompt));
            body.put("messages", messages);
            int timeout = Math.max(10_000, Math.min(180_000, opts.timeoutMs));
            response = transport.execute(new Request("POST", c.baseUrl + "/chat/completions",
                    headers(c, opts.streaming), body.toString(), timeout), handle);
            if (response.status() < 200 || response.status() >= 300) {
                String error = readLimited(response.body(), 65_536);
                throw upstreamError(response.status(), error, c.apiKey);
            }
            boolean received = opts.streaming ? readSse(response.body(), cancelled, listener)
                    : readSingle(response.body(), listener);
            if (cancelled != null && cancelled[0]) listener.onDone(false, "cancelled");
            else if (!received) throw new Exception("The provider completed without returning text.");
            else listener.onDone(true, null);
        } catch (Exception e) {
            if (cancelled != null && cancelled[0]) listener.onDone(false, "cancelled");
            else listener.onDone(false, redact(e.getMessage() == null ? "Provider request failed." : e.getMessage(),
                    input == null ? "" : input.apiKey));
        } finally {
            if (response != null) try { response.close(); } catch (Exception ignored) { }
            if (handle != null) handle.disarm();
        }
    }

    private static boolean readSingle(InputStream in, EngineCore.ChatListener listener) throws Exception {
        JSONObject body = new JSONObject(readLimited(in, 4_194_304));
        JSONArray choices = body.optJSONArray("choices");
        JSONObject message = choices == null || choices.length() == 0 ? null
                : choices.optJSONObject(0) == null ? null : choices.optJSONObject(0).optJSONObject("message");
        String content = message == null ? "" : message.optString("content", "");
        if (!content.isEmpty()) listener.onContent(content);
        return !content.isEmpty();
    }

    private static boolean readSse(InputStream in, boolean[] cancelled,
                                EngineCore.ChatListener listener) throws Exception {
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        StringBuilder data = new StringBuilder();
        boolean received = false;
        String line;
        while ((line = reader.readLine()) != null) {
            if (cancelled != null && cancelled[0]) return received;
            if (line.isEmpty()) {
                if (dispatchSse(data.toString(), listener)) received = true;
                data.setLength(0);
            } else if (line.startsWith("data:")) {
                if (data.length() > 0) data.append('\n');
                data.append(line.substring(5).trim());
            }
        }
        if (data.length() > 0 && dispatchSse(data.toString(), listener)) received = true;
        return received;
    }

    private static boolean dispatchSse(String data, EngineCore.ChatListener listener) throws Exception {
        if (data.isEmpty() || data.equals("[DONE]")) return false;
        JSONObject event = new JSONObject(data);
        JSONObject error = event.optJSONObject("error");
        if (error != null) throw new Exception(error.optString("message", "Provider stream failed."));
        JSONArray choices = event.optJSONArray("choices");
        if (choices == null || choices.length() == 0 || choices.optJSONObject(0) == null) return false;
        JSONObject delta = choices.optJSONObject(0).optJSONObject("delta");
        if (delta == null) delta = choices.optJSONObject(0).optJSONObject("message");
        String content = delta == null ? "" : delta.optString("content", "");
        if (!content.isEmpty()) listener.onContent(content);
        return !content.isEmpty();
    }

    private static Exception upstreamError(int status, String body, String key) {
        String detail = "Provider request failed (HTTP " + status + ").";
        try {
            JSONObject o = new JSONObject(body);
            Object error = o.opt("error");
            if (error instanceof JSONObject) detail = ((JSONObject) error).optString("message", detail);
            else if (error instanceof String && !((String) error).isEmpty()) detail = (String) error;
            else detail = o.optString("message", detail);
        } catch (Exception ignored) { }
        return new Exception(redact(detail, key));
    }

    private static String redact(String message, String key) {
        String clean = message == null ? "Provider request failed." : message;
        if (key != null && !key.isEmpty()) clean = clean.replace(key, "[redacted]");
        return clean.length() > 500 ? clean.substring(0, 500) : clean;
    }

    private static String readLimited(InputStream in, int max) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int n;
        while ((n = in.read(buffer)) >= 0) {
            total += n;
            if (total > max) throw new IOException("Provider response is too large.");
            out.write(buffer, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
}
