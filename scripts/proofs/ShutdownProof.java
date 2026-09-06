import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.aether.app.EngineCore;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;

/**
 * Proves EngineCore.shutDownVerified() -- the code the Shut-down button now runs.
 *
 * Two failures it exists to catch, both of which shipped:
 *
 *   1. The button needed liveUrls, which only held engines the app had already
 *      seen fully LIVE, so it did nothing during boot or after a restart. That
 *      part lives in SettingsActivity and cannot run on a JVM; what CAN be
 *      proven here is the shutdown call itself, which is what the button now
 *      delegates to.
 *   2. The confirmation tested !isLive(), which is TRUE for an engine that is
 *      still booting (200 with no models). So a running engine holding a GPU was
 *      reported as "off -- confirmed terminated". Check "a booting engine is
 *      never reported as off" is the regression test for that, and the old code
 *      fails it.
 *
 * Part 3 runs against a real Kaggle engine that is actually serving.
 *
 *   javac -encoding UTF-8 -cp <json jar> -d /tmp/sd \
 *       android/app/src/main/java/com/aether/app/EngineCore.java \
 *       scripts/proofs/ShutdownProof.java
 *   java -cp /tmp/sd:<json jar> ShutdownProof <offKey> <liveUrl>
 *
 * The last two arguments are optional: without them only the local parts run.
 */
public final class ShutdownProof {

    private static int pass, fail;

    private static void check(String what, boolean ok, String detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + what
                + (detail.isEmpty() ? "" : "  [" + detail + "]"));
        if (ok) pass++; else fail++;
    }

    private static void section(String s) { System.out.println("\n== " + s); }

    public static void main(String[] args) throws Exception {
        String offKey = args.length > 0 ? args[0] : "proof-key";
        String liveUrl = args.length > 1 ? args[1] : null;

        // ------------------------------------------------- 1. booting engine
        section("an engine that is still booting must never be reported as off");
        HttpServer booting = serve(8731, (ex, dead) -> {
            if (ex.getRequestURI().getPath().equals("/api/ps")) {
                send(ex, 200, "{\"models\":[]}");     // up, model not loaded
                return;
            }
            if (ex.getRequestURI().getPath().equals("/off")) {
                if (!offKey.equals(ex.getRequestHeaders().getFirst("X-Engine-Key"))) {
                    send(ex, 403, "{\"error\":\"bad key\"}"); return;
                }
                send(ex, 200, "{\"ok\":true}");       // accepted, but nothing dies
                return;
            }
            send(ex, 404, "");
        });
        long t0 = System.currentTimeMillis();
        EngineCore.Shutdown boot = EngineCore.shutDownVerified(
                "http://127.0.0.1:8731", offKey, 5_000, 3, 300);
        long took = System.currentTimeMillis() - t0;
        /* Same rule, same server, still up and booting: the old !isLive() test
           called this "down", which is the lie this proof exists to catch. */
        boolean oldRuleSaysDown = EngineCore.confirmedDown(
                "http://127.0.0.1:8731", 2, 200, 3_000);
        booting.stop(0);
        check("/off was accepted", boot.code == 200, "HTTP " + boot.code);
        check("a booting engine is never reported as off", !boot.confirmed,
                boot.message);
        check("it says the engine is still answering", boot.message.contains("STILL"),
                boot.message);
        check("it kept checking rather than concluding at once", boot.checks == 3,
                boot.checks + " checks in " + took + "ms");
        check("confirmedDown no longer calls a booting engine down",
                !oldRuleSaysDown, "booting engine /api/ps 200 with no models");

        // --------------------------------------------------- 2. engine dies
        section("an engine that really dies is confirmed, with the check count");
        final boolean[] dead = {false};
        HttpServer dying = serve(8732, (ex, ignore) -> {
            if (ex.getRequestURI().getPath().equals("/api/ps")) {
                if (dead[0]) { send(ex, 502, "engine gone"); return; }
                send(ex, 200, "{\"models\":[{\"name\":\"proof-model:Q4\"}]}");
                return;
            }
            if (ex.getRequestURI().getPath().equals("/off")) {
                if (!offKey.equals(ex.getRequestHeaders().getFirst("X-Engine-Key"))) {
                    send(ex, 403, "{\"error\":\"bad key\"}"); return;
                }
                dead[0] = true;
                send(ex, 200, "{\"ok\":true}");
                return;
            }
            send(ex, 404, "");
        });
        EngineCore.Shutdown gone = EngineCore.shutDownVerified(
                "http://127.0.0.1:8732", offKey, 5_000, 8, 200);
        dying.stop(0);
        check("confirmed terminated", gone.confirmed, gone.message);
        check("it saw the first check, not a lucky retry", gone.checks == 1,
                gone.checks + " checks");
        check("the final status is reported, not invented", gone.finalStatus == 502,
                "finalStatus " + gone.finalStatus);
        check("the message names the status and the check",
                gone.message.contains("502") && gone.message.contains("1 check"),
                gone.message);

        // ---------------------------------------------------- 3. policy fit
        section("the shipped stream policy must outlast the kernel's own tools");
        EngineCore.StreamPolicy p = EngineCore.StreamPolicy.standard();
        /* The kernel runs tools synchronously and emits nothing while they run;
           its subprocess timeouts reach 1200s. A stall limit below that kills a
           legitimate long tool call mid-turn. */
        check("stall limit is above the kernel's 1200s tool ceiling",
                p.stallMs > 1_200_000, "stallMs " + p.stallMs);
        check("total ceiling leaves room for ten long iterations",
                p.totalMs > 3_600_000, "totalMs " + p.totalMs);
        check("stop is still checked about once a second",
                p.readSliceMs <= 1_500, "readSliceMs " + p.readSliceMs);

        // -------------------------------------------------- 4. real engine
        if (liveUrl != null && !liveUrl.isEmpty()) {
            section("real engine: " + liveUrl);
            EngineCore.Health before = EngineCore.health(liveUrl, 20_000);
            check("it is serving before the shutdown", before.status == 200,
                    "HTTP " + before.status + " models=" + before.models);
            long t = System.currentTimeMillis();
            EngineCore.Shutdown real = EngineCore.shutDownVerified(
                    liveUrl, offKey, 30_000, 10, 4_000);
            long secs = (System.currentTimeMillis() - t) / 1000;
            check("/off accepted by the real engine", real.code == 200,
                    "HTTP " + real.code);
            check("confirmed terminated on the real engine", real.confirmed,
                    real.message);
            check("/api/ps no longer answers 200", real.finalStatus != 200,
                    "finalStatus " + real.finalStatus + " after " + real.checks
                            + " checks / " + secs + "s");
        } else {
            System.out.println("\n== real-engine part skipped (no URL given)");
        }

        System.out.println("\nSHUTDOWN PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    // ------------------------------------------------------------ harness

    interface Route { void handle(HttpExchange ex, boolean dead) throws Exception; }

    private static HttpServer serve(int port, Route r) throws Exception {
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        s.createContext("/", ex -> {
            try { r.handle(ex, false); } catch (Exception e) { ex.close(); }
        });
        s.setExecutor(Executors.newFixedThreadPool(4, run -> {
            Thread t = new Thread(run); t.setDaemon(true); return t;   // must not outlive main
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
