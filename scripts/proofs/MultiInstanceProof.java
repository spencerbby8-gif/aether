import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.aether.app.EngineCore;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.Executors;

/**
 * Proves EngineCore.shutDownEvery() and urlsFor(): the code behind "shut down"
 * now that it is known one engine can have several running instances.
 *
 * Kaggle leaves previous kernel versions running after a push and has no API to
 * stop them (kaggle-api issue #388), so each version has its own tunnel and its
 * own GPU. Observed live: two distinct engine-A tunnels answering /api/ps 200
 * inside the same minute. Shutting down only the newest is why shutdown looked
 * like it failed.
 *
 *   java -cp /tmp/mi:<json jar> MultiInstanceProof <topic> <secret>
 */
public final class MultiInstanceProof {

    private static int pass, fail;

    private static void check(String what, boolean ok, String detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + what
                + (detail == null || detail.isEmpty() ? "" : "  [" + detail + "]"));
        if (ok) pass++; else fail++;
    }

    private static void section(String s) { System.out.println("\n== " + s); }

    public static void main(String[] args) throws Exception {
        String key = "proof-key";

        section("two running instances plus a dead tunnel");
        HttpServer one = serve(8741, true, key);
        HttpServer two = serve(8742, true, key);
        List<String> urls = Arrays.asList(
                "http://127.0.0.1:8741",     // running
                "http://127.0.0.1:8742",     // running, a second version
                "http://127.0.0.1:8799");    // nothing listening: a stale tunnel
        EngineCore.ShutdownAll r = EngineCore.shutDownEvery(urls, key, 5_000, 3, 200);
        one.stop(0); two.stop(0);
        check("it examined all three tunnels", r.checked == 3, "checked " + r.checked);
        check("it killed BOTH running instances", r.killed == 2, "killed " + r.killed);
        check("the dead tunnel was not counted as a failure",
                r.alreadyDead == 1 && r.stillUp == 0,
                "dead " + r.alreadyDead + ", still up " + r.stillUp);
        check("it reports everything down", r.allDown, r.message);
        check("the message says how many there were",
                r.message.contains("2 running instances"), r.message);
        check("and mentions the stale tunnel", r.message.contains("already dead"), r.message);

        section("an instance that refuses to die is reported as a failure");
        HttpServer stubborn = serve(8743, false, key);   // accepts /off, never dies
        EngineCore.ShutdownAll bad = EngineCore.shutDownEvery(
                Collections.singletonList("http://127.0.0.1:8743"), key, 5_000, 2, 200);
        stubborn.stop(0);
        check("it does not claim success", !bad.allDown, bad.message);
        check("it counts the survivor", bad.stillUp == 1, "still up " + bad.stillUp);
        check("the message names it", bad.message.contains("still answering"), bad.message);

        section("nothing running at all");
        EngineCore.ShutdownAll none = EngineCore.shutDownEvery(
                Collections.singletonList("http://127.0.0.1:8798"), key, 5_000, 2, 200);
        check("it reports nothing was running", none.allDown && none.killed == 0, none.message);

        section("urlsFor on the real beacon");
        if (args.length >= 2) {
            for (String slot : new String[] {"a", "b", "c"}) {
                List<String> found = EngineCore.urlsFor(args[0], args[1], slot, 3 * 3600, 20_000, 8);
                System.out.println("  engine " + slot.toUpperCase(Locale.ROOT) + ": "
                        + found.size() + " distinct tunnel(s) announced in 3h");
                check("engine " + slot.toUpperCase(Locale.ROOT)
                        + " returns every distinct tunnel, newest first",
                        found.size() == new LinkedHashSet<>(found).size(), found.size() + " urls");
            }
            /* The live observation this fix is for: more than one at once. */
            int max = 0;
            for (String slot : new String[] {"a", "b", "c"}) {
                max = Math.max(max, EngineCore.urlsFor(args[0], args[1], slot, 3 * 3600, 20_000, 8).size());
            }
            System.out.println("  most tunnels seen for one engine in 3h: " + max);
            check("the beacon can hold several tunnels for one engine", max >= 1, max + " found");
        } else {
            System.out.println("  skipped (no topic given)");
        }

        System.out.println("\nMULTI-INSTANCE PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    /** A fake engine. `dies` = whether /off actually takes it down. */
    private static HttpServer serve(int port, final boolean dies, final String key) throws Exception {
        final boolean[] dead = {false};
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        s.createContext("/", ex -> {
            try {
                String path = ex.getRequestURI().getPath();
                if (path.equals("/api/ps")) {
                    if (dead[0]) { send(ex, 502, "gone"); return; }
                    send(ex, 200, "{\"models\":[{\"name\":\"proof-" + port + ":Q4\"}]}");
                    return;
                }
                if (path.equals("/off")) {
                    if (!key.equals(ex.getRequestHeaders().getFirst("X-Engine-Key"))) {
                        send(ex, 403, "bad key"); return;
                    }
                    if (dies) dead[0] = true;
                    send(ex, 200, "{\"ok\":true}");
                    return;
                }
                send(ex, 404, "");
            } catch (Exception e) { ex.close(); }
        });
        s.setExecutor(Executors.newFixedThreadPool(3, run -> {
            Thread t = new Thread(run); t.setDaemon(true); return t;
        }));
        s.start();
        return s;
    }

    private static void send(HttpExchange ex, int code, String body) throws Exception {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.sendResponseHeaders(code, b.length == 0 ? -1 : b.length);
        if (b.length > 0) { try (OutputStream os = ex.getResponseBody()) { os.write(b); } }
        ex.close();
    }
}
