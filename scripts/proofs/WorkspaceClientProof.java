import com.aether.app.WorkspaceClient;
import com.sun.net.httpserver.HttpServer;
import org.json.JSONObject;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Direct HTTP contract proof against a fake authenticated workspace engine. */
public final class WorkspaceClientProof {
    static int pass, fail;
    static void check(String name, boolean ok) { check(name, ok, ""); }
    static void check(String name, boolean ok, Object detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name + "  [" + detail + "]");
        if (ok) pass++; else fail++;
    }
    static final List<String> requests = Collections.synchronizedList(new ArrayList<>());
    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/workspace/", exchange -> {
            String body = read(exchange.getRequestBody());
            requests.add(exchange.getRequestMethod() + " " + exchange.getRequestURI() + " " + body);
            String response;
            if (!"test-key".equals(exchange.getRequestHeaders().getFirst("X-Engine-Key"))) {
                exchange.sendResponseHeaders(403, -1); exchange.close(); return;
            }
            if (exchange.getRequestURI().getPath().endsWith("/list")) response = "{\"path\":\"\",\"files\":[{\"name\":\"notes.txt\",\"path\":\"notes.txt\",\"directory\":false,\"bytes\":5}]}";
            else if (exchange.getRequestURI().getPath().endsWith("/read")) response = "{\"path\":\"notes.txt\",\"content\":\"hello\",\"bytes\":5}";
            else response = "{\"status\":\"ok\"}";
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length); exchange.getResponseBody().write(bytes); exchange.close();
        });
        server.start();
        String url = "http://127.0.0.1:" + server.getAddress().getPort();
        try {
            Result list = new Result(); WorkspaceClient.list(url, "test-key", "chat123", "", list); list.await();
            check("list sends authenticated session/path query", list.ok && requests.get(0).contains("session=chat123"), requests.get(0));
            check("list returns real file metadata", new JSONObject(list.value).getJSONArray("files").getJSONObject(0).getString("name").equals("notes.txt"));
            Result read = new Result(); WorkspaceClient.read(url, "test-key", "chat123", "notes.txt", read); read.await();
            check("read returns editor content", read.ok && new JSONObject(read.value).getString("content").equals("hello"));
            Result write = new Result(); WorkspaceClient.write(url, "test-key", "chat123", "notes.txt", "updated", write); write.await();
            check("write sends exact text and path", write.ok && requests.get(2).contains("updated") && requests.get(2).contains("notes.txt"), requests.get(2));
            Result mkdir = new Result(); WorkspaceClient.mkdir(url, "test-key", "chat123", "folder", mkdir); mkdir.await();
            check("mkdir uses its real route", mkdir.ok && requests.get(3).startsWith("POST /api/workspace/mkdir"), requests.get(3));
            Result delete = new Result(); WorkspaceClient.delete(url, "test-key", "chat123", "notes.txt", delete); delete.await();
            check("delete uses its real route", delete.ok && requests.get(4).startsWith("POST /api/workspace/delete"), requests.get(4));
            Result rollback = new Result(); WorkspaceClient.rollback(url, "test-key", "chat123", rollback); rollback.await();
            check("rollback calls the authenticated checkpoint route", rollback.ok && requests.get(5).startsWith("POST /api/workspace/rollback"), requests.get(5));
            Result denied = new Result(); WorkspaceClient.list(url, "wrong", "chat123", "", denied); denied.await();
            check("engine authentication failure reaches caller", !denied.ok, denied.value);
            Result refused = new Result(); WorkspaceClient.list("http://example.com", "key", "chat", "", refused); refused.await();
            check("non-HTTPS remote workspace is refused", !refused.ok, refused.value);
        } finally { server.stop(0); }
        System.out.println("\nWORKSPACE CLIENT PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
    static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] b = new byte[2048]; int n;
        while ((n = in.read(b)) >= 0) out.write(b, 0, n); return out.toString(StandardCharsets.UTF_8.name());
    }
    static final class Result implements WorkspaceClient.Callback {
        final CountDownLatch done = new CountDownLatch(1); volatile boolean ok; volatile String value;
        public void onResult(boolean ok, String value) { this.ok = ok; this.value = value; done.countDown(); }
        void await() throws Exception { if (!done.await(5, TimeUnit.SECONDS)) throw new AssertionError("timeout"); }
    }
}
