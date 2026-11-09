import com.aether.app.EngineCore;
import com.sun.net.httpserver.HttpServer;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/** Verifies the Android request contract with a local fake engine, never Kaggle. */
public final class DiscussionModeProof {
    private static int pass, fail;
    private static void check(String name, boolean ok, Object detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name + "  [" + detail + "]");
        if (ok) pass++; else fail++;
    }

    public static void main(String[] args) throws Exception {
        List<String> bodies = new ArrayList<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/chat", exchange -> {
            bodies.add(read(exchange.getRequestBody()));
            byte[] out = ("{\"message\":{\"content\":\"Hello\"},\"done\":false}\n"
                    + "{\"message\":{\"content\":\"\"},\"done\":true}\n").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, out.length);
            exchange.getResponseBody().write(out);
            exchange.close();
        });
        server.start();
        String url = "http://127.0.0.1:" + server.getAddress().getPort();
        try {
            call(url, true);
            call(url, false);
            JSONObject discussion = new JSONObject(bodies.get(0));
            JSONObject agent = new JSONObject(bodies.get(1));
            check("discussion sends an explicit true mode", discussion.optBoolean("discussion", false), discussion);
            check("agent does not accidentally request discussion", !agent.has("discussion"), agent);
            check("custom instructions and the prompt remain in order",
                    discussion.getJSONArray("messages").length() == 2
                            && discussion.getJSONArray("messages").getJSONObject(0).getString("content").equals("Instructions")
                            && discussion.getJSONArray("messages").getJSONObject(1).getString("content").equals("Hello"),
                    discussion.getJSONArray("messages"));
        } finally {
            server.stop(0);
        }
        System.out.println("\nDISCUSSION MODE PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    private static void call(String url, boolean discussion) {
        AtomicBoolean done = new AtomicBoolean();
        EngineCore.chatStream(url, "k", null, "Hello", "Instructions", discussion,
                new boolean[]{false}, new EngineCore.ChatListener() {
                    @Override public void onThinking(String text) { }
                    @Override public void onContent(String text) { }
                    @Override public void onDone(boolean ok, String error) { done.set(ok); }
                }, EngineCore.StreamPolicy.standard(), null);
        check("fake engine turn completes" + (discussion ? " in discussion" : " in agent"), done.get(), done);
    }

    private static String read(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int n;
        while ((n = in.read(buffer)) >= 0) out.write(buffer, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
