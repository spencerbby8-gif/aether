import com.aether.app.EngineCore;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Real Java HTTP client/server proof for the manual-command handshake. */
public final class CommandApprovalProof {
    static int passed, failed;
    static void check(boolean ok, String name) {
        System.out.println((ok ? "  ok   " : "  FAIL ") + name);
        if (ok) passed++; else failed++;
    }

    static final class Fixture implements AutoCloseable {
        final HttpServer server;
        final java.util.concurrent.ExecutorService executor = java.util.concurrent.Executors.newCachedThreadPool();
        final String url;
        final CountDownLatch decision = new CountDownLatch(1);
        final List<String> order = java.util.Collections.synchronizedList(new ArrayList<>());
        volatile boolean approved;
        volatile String receivedId = "";
        volatile String receivedSession = "";

        Fixture() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            url = "http://127.0.0.1:" + server.getAddress().getPort();
            server.createContext("/api/approval", this::approval);
            server.createContext("/api/chat", this::chat);
            server.setExecutor(executor);
            server.start();
        }

        void approval(HttpExchange x) throws IOException {
            String body = new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            JSONObject value = new JSONObject(body);
            receivedId = value.optString("id");
            receivedSession = value.optString("session");
            approved = value.optBoolean("approved");
            order.add("decision:" + approved);
            decision.countDown();
            byte[] out = "{\"status\":\"recorded\"}".getBytes(StandardCharsets.UTF_8);
            x.getResponseHeaders().add("Content-Type", "application/json");
            x.sendResponseHeaders(200, out.length);
            try (OutputStream os = x.getResponseBody()) { os.write(out); }
        }

        void chat(HttpExchange x) throws IOException {
            x.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            x.sendResponseHeaders(200, 0);
            try (OutputStream os = x.getResponseBody()) {
                order.add("approval");
                write(os, new JSONObject().put("approval", new JSONObject()
                        .put("id", "command-1").put("session", "chat-1")
                        .put("tool", "run_command").put("command", "printf live-proof")).toString());
                try {
                    if (!decision.await(5, TimeUnit.SECONDS)) throw new IOException("no decision");
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt(); throw new IOException(e);
                }
                order.add("tool-start");
                write(os, new JSONObject().put("message", new JSONObject()
                        .put("thinking", "🛠️ run_command({\"command\":\"printf live-proof\"})")).toString());
                write(os, new JSONObject().put("done", true).toString());
            }
        }

        static void write(OutputStream os, String line) throws IOException {
            os.write((line + "\n").getBytes(StandardCharsets.UTF_8)); os.flush();
        }
        @Override public void close() { server.stop(0); executor.shutdownNow(); }
    }

    static void run(boolean approve) throws Exception {
        try (Fixture f = new Fixture()) {
            final boolean[] response = {false};
            final boolean[] done = {false};
            EngineCore.chatStream(f.url, "test-key", null, "run it", "", false,
                    new boolean[]{false}, new EngineCore.ChatListener() {
                        @Override public void onThinking(String text) { }
                        @Override public void onContent(String text) { }
                        @Override public void onDone(boolean ok, String error) { done[0] = ok; }
                        @Override public void onApproval(JSONObject value) {
                            response[0] = EngineCore.respondApproval(f.url, "test-key",
                                    value.optString("id"), value.optString("session"), approve);
                        }
                    }, EngineCore.StreamPolicy.standard(), null, "chat-1", null, false);
            check(response[0], "approval response delivered for approved=" + approve);
            check(f.approved == approve, "server received exact decision for approved=" + approve);
            check("command-1".equals(f.receivedId) && "chat-1".equals(f.receivedSession),
                    "decision is bound to command id and chat session");
            check(done[0], "stream terminates after the handshake");
            check(f.order.indexOf("approval") < f.order.indexOf("tool-start")
                            && f.order.indexOf("decision:" + approve) < f.order.indexOf("tool-start"),
                    "tool cannot start before approval decision: " + f.order);
        }
    }

    public static void main(String[] args) throws Exception {
        run(true);
        run(false);
        System.out.println("COMMAND APPROVAL CLIENT PROOF  " + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
