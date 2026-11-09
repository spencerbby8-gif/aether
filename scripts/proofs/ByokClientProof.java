import com.aether.app.ByokClient;
import com.aether.app.EngineCore;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Deterministic fake-transport checks of the exact BYOK client in the APK. */
public final class ByokClientProof {
    private static int pass, fail;

    private static final class FakeResponse implements ByokClient.Response {
        final int status;
        final byte[] body;
        FakeResponse(int status, String body) {
            this.status = status;
            this.body = body.getBytes(StandardCharsets.UTF_8);
        }
        @Override public int status() { return status; }
        @Override public InputStream body() { return new ByteArrayInputStream(body); }
        @Override public void close() { }
    }

    private static final class FakeTransport implements ByokClient.Transport {
        final ByokClient.Response response;
        ByokClient.Request seen;
        FakeTransport(ByokClient.Response response) { this.response = response; }
        @Override public ByokClient.Response execute(ByokClient.Request request, EngineCore.TurnHandle handle) {
            seen = request;
            return response;
        }
    }

    private static final class Capture implements EngineCore.ChatListener {
        final StringBuilder content = new StringBuilder();
        boolean done;
        boolean ok;
        String error;
        @Override public void onThinking(String text) { }
        @Override public void onContent(String text) { content.append(text); }
        @Override public void onDone(boolean good, String error) {
            done = true; ok = good; this.error = error;
        }
    }

    private static ByokClient.Connection connection() {
        ByokClient.Connection c = new ByokClient.Connection();
        c.id = "one"; c.provider = "openai"; c.name = "Personal OpenAI";
        c.apiKey = "sk-test-secret"; c.defaultModel = "gpt-test";
        c.models.add("gpt-test");
        return c;
    }

    public static void main(String[] args) throws Exception {
        check("nine real provider connectors are registered", ByokClient.providers().size() == 9, null);

        ByokClient.Connection builtIn = connection();
        builtIn.baseUrl = "http://127.0.0.1/private";
        check("built-in provider ignores an injected base URL",
                ByokClient.validated(builtIn).baseUrl.equals("https://api.openai.com/v1"), null);

        ByokClient.Connection custom = connection();
        custom.provider = "custom"; custom.baseUrl = "http://example.com/v1";
        expectFailure("custom endpoint requires HTTPS", () -> ByokClient.validated(custom));
        custom.baseUrl = "https://127.0.0.1/v1";
        expectFailure("custom endpoint refuses loopback", () -> ByokClient.validated(custom));
        custom.baseUrl = "https://example.com/v1/";
        check("public custom HTTPS endpoint is normalized",
                ByokClient.validated(custom).baseUrl.equals("https://example.com/v1"), null);

        String metadata = connection().toMetadata().toString();
        check("metadata never serializes the API key", !metadata.contains("sk-test-secret"), metadata);
        ByokClient.Connection restored = ByokClient.Connection.fromMetadata(connection().toMetadata());
        check("metadata round trip retains provider and model",
                restored.provider.equals("openai") && restored.defaultModel.equals("gpt-test")
                        && restored.models.size() == 1 && restored.apiKey.isEmpty(), null);

        FakeTransport discovery = new FakeTransport(new FakeResponse(200,
                "{\"data\":[{\"id\":\"model-b\"},{\"id\":\"model-a\"},{\"id\":\"model-a\"}]}") );
        List<String> models = ByokClient.discoverModels(connection(), discovery);
        check("discovery returns only provider-reported unique models",
                models.equals(Arrays.asList("model-a", "model-b")), models.toString());
        check("discovery uses GET /models and bearer authentication",
                discovery.seen.method.equals("GET")
                        && discovery.seen.url.equals("https://api.openai.com/v1/models")
                        && discovery.seen.headers.get("Authorization").equals("Bearer sk-test-secret"), null);

        String sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n"
                + "data: {\"choices\":[{\"delta\":{\"content\":\"!\"}}]}\n\ndata: [DONE]\n\n";
        FakeTransport streaming = new FakeTransport(new FakeResponse(200, sse));
        Capture streamCapture = new Capture();
        ByokClient.ChatOptions options = new ByokClient.ChatOptions();
        options.instructions = "Be precise";
        options.temperature = 0.2;
        options.maxTokens = 321;
        List<EngineCore.Msg> history = new ArrayList<>();
        history.add(new EngineCore.Msg("assistant", "Earlier answer"));
        ByokClient.chat(connection(), "gpt-test", history, "Hello", options,
                new boolean[]{false}, streamCapture, null, streaming);
        check("SSE deltas reach the existing Android chat listener",
                streamCapture.done && streamCapture.ok && streamCapture.content.toString().equals("Hello!"),
                streamCapture.error);
        org.json.JSONObject sent = new org.json.JSONObject(streaming.seen.body);
        check("chat sends selected model and generation controls",
                sent.getString("model").equals("gpt-test") && sent.getDouble("temperature") == 0.2
                        && sent.getInt("max_tokens") == 321 && sent.getBoolean("stream"), sent.toString());
        check("chat sends system instructions, history, then current prompt",
                sent.getJSONArray("messages").length() == 3
                        && sent.getJSONArray("messages").getJSONObject(0).getString("role").equals("system")
                        && sent.getJSONArray("messages").getJSONObject(2).getString("content").equals("Hello"),
                sent.toString());

        FakeTransport single = new FakeTransport(new FakeResponse(200,
                "{\"choices\":[{\"message\":{\"content\":\"Complete answer\"}}]}") );
        Capture singleCapture = new Capture();
        options.streaming = false;
        ByokClient.chat(connection(), "gpt-test", null, "Hello", options,
                new boolean[]{false}, singleCapture, null, single);
        check("non-streaming responses are supported",
                singleCapture.ok && singleCapture.content.toString().equals("Complete answer"), singleCapture.error);

        FakeTransport rejected = new FakeTransport(new FakeResponse(401,
                "{\"error\":{\"message\":\"Rejected sk-test-secret\"}}") );
        Capture rejectedCapture = new Capture();
        ByokClient.chat(connection(), "gpt-test", null, "Hello", options,
                new boolean[]{false}, rejectedCapture, null, rejected);
        check("upstream failures are honest and redact the key",
                rejectedCapture.done && !rejectedCapture.ok
                        && rejectedCapture.error.contains("[redacted]")
                        && !rejectedCapture.error.contains("sk-test-secret"), rejectedCapture.error);

        FakeTransport empty = new FakeTransport(new FakeResponse(200, "{\"choices\":[]}") );
        Capture emptyCapture = new Capture();
        ByokClient.chat(connection(), "gpt-test", null, "Hello", options,
                new boolean[]{false}, emptyCapture, null, empty);
        check("an empty provider answer is not reported as success",
                emptyCapture.done && !emptyCapture.ok && emptyCapture.error.contains("without returning text"),
                emptyCapture.error);

        System.out.println();
        System.out.println("BYOK CLIENT PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    private interface ThrowingRunnable { void run() throws Exception; }

    private static void expectFailure(String name, ThrowingRunnable action) {
        try {
            action.run();
            check(name, false, "expected an exception");
        } catch (Exception expected) {
            check(name, true, expected.getMessage());
        }
    }

    private static void check(String name, boolean ok, String detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name
                + (detail == null ? "" : "  [" + detail + "]"));
        if (ok) pass++; else fail++;
    }
}
