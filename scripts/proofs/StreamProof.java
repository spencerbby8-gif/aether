import com.aether.app.EngineCore;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Runtime proof of the streaming client, against a local server that speaks the
 * engine's actual wire contract.
 *
 * WHY THIS EXISTS. "The AI gets stuck on generating and stop does nothing" is a
 * runtime behaviour, and no emulator can run here -- but the streaming client is
 * plain Java over a socket, so it can be driven for real on the JVM. This stands
 * up an HTTP server that emits the engine's NDJSON exactly as the kernel does
 * (thinking lines, the 10-second heartbeat, tool-call lines, content tokens,
 * {"done":true}), then asserts what the shipped EngineCore.chatStream does with
 * it: normal turns, content that arrives in the final done line, silence, a stop
 * pressed mid-stall, HTTP errors, a closed socket, garbage lines, a long
 * tool-heavy turn, and twenty-five turns back to back.
 *
 * It is not the real Kaggle engine and it says so. What it proves is the client:
 * that a turn always terminates, that stop is honoured promptly, and that the
 * next turn still works.
 *
 * Run:
 *   javac -cp $T/jars/json-20240303.jar -d /tmp/sp \
 *     android/app/src/main/java/com/aether/app/EngineCore.java scripts/proofs/StreamProof.java
 *   java  -cp /tmp/sp:$T/jars/json-20240303.jar StreamProof
 */
public final class StreamProof {

    private static int pass = 0;
    private static int fail = 0;
    private static HttpServer server;
    private static String base;
    private static final String KEY = "test-key";

    public static void main(String[] args) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        /* Daemon threads, so the JVM can exit as soon as the checks are done
           instead of waiting out the silence scenarios' sleeps. */
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r);
            t.setDaemon(true);
            return t;
        }));

        route("/ok", ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            OutputStream o = ex.getResponseBody();
            write(o, thinking("\u2699\uFE0F agent step 1..."));
            write(o, thinking("\u23F3"));                      // engine heartbeat
            write(o, thinking("\uD83D\uDEE0\uFE0F web_search({\"q\":\"x\"})"));
            write(o, thinking("\u21B3 web_search returned 412 chars"));
            write(o, content("Hello "));
            write(o, content("world"));
            write(o, "{\"message\":{\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\"}");
            o.close();
        });

        /* The engine's fallback path re-emits raw Ollama lines, where the last
           object can carry content AND done together. */
        route("/done-with-content", ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            OutputStream o = ex.getResponseBody();
            write(o, content("first half "));
            write(o, "{\"message\":{\"role\":\"assistant\",\"content\":\"second half\"},\"done\":true}");
            o.close();
        });

        /* Silence: one line, then nothing. This is the "stuck on generating" case. */
        route("/stall", ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            OutputStream o = ex.getResponseBody();
            write(o, thinking("starting a long tool call"));
            o.flush();
            try { Thread.sleep(30_000); } catch (InterruptedException ignored) { }
        });

        /* Tool-heavy turn: ten agent iterations, each with a tool call. */
        route("/long", ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            OutputStream o = ex.getResponseBody();
            for (int i = 1; i <= 10; i++) {
                write(o, thinking("\u2699\uFE0F agent step " + i + "..."));
                write(o, thinking("\uD83D\uDEE0\uFE0F run_command({\"cmd\":\"ls\"})"));
                write(o, thinking("\u21B3 run_command returned 88 chars"));
                Thread.sleep(20);
            }
            write(o, content("done after ten tool rounds"));
            write(o, "{\"message\":{\"content\":\"\"},\"done\":true}");
            o.close();
        });

        /* Garbage lines interleaved with real ones. */
        route("/garbage", ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            OutputStream o = ex.getResponseBody();
            write(o, "not json at all");
            write(o, content("kept going"));
            write(o, "{ broken");
            write(o, "");
            write(o, "{\"message\":{\"content\":\"\"},\"done\":true}");
            o.close();
        });

        /* Socket closed with no done line. */
        route("/closed", ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            OutputStream o = ex.getResponseBody();
            write(o, content("partial answer"));
            o.close();          // no done:true
        });

        /* Echoes what the client actually put in the request body, so the
           conversation-history fix can be checked rather than assumed. */
        route("/context", ex -> {
            byte[] raw = ex.getRequestBody().readAllBytes();
            String body = new String(raw, StandardCharsets.UTF_8);
            int n = 0;
            int i = body.indexOf("\"role\"");
            while (i >= 0) { n++; i = body.indexOf("\"role\"", i + 1); }
            boolean sawAda = body.contains("My name is Ada");
            boolean sawReply = body.contains("Nice to meet you");
            ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            OutputStream o = ex.getResponseBody();
            write(o, content("messages=" + n + ";sawAda=" + sawAda + ";sawReply=" + sawReply));
            write(o, "{\"message\":{\"content\"\"},\"done\":true}");
            o.close();
        });

        route("/502", ex -> {
            byte[] b = "bad gateway".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(502, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });

        route("/api/chat", ex -> {
            /* The real endpoint: 403 without the key, otherwise a normal turn. */
            if (!KEY.equals(ex.getRequestHeaders().getFirst("X-Engine-Key"))) {
                byte[] b = "{\"status\":\"forbidden\"}".getBytes(StandardCharsets.UTF_8);
                ex.sendResponseHeaders(403, b.length);
                ex.getResponseBody().write(b);
                ex.close();
                return;
            }
            ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            OutputStream o = ex.getResponseBody();
            write(o, content("turn served"));
            write(o, "{\"message\":{\"content\":\"\"},\"done\":true}");
            o.close();
        });

        server.start();
        base = "http://127.0.0.1:" + server.getAddress().getPort();

        try {
            normalTurn();
            contentInFinalDoneLine();
            stallTerminates();
            stopIsHonouredDuringStall();
            longToolTurn();
            garbageLinesSurvive();
            closedSocketIsNotAHang();
            conversationHistoryIsSent();
            httpErrorsAreExplained();
            wrongKeyIsExplained();
            manyTurnsInARow();
        } finally {
            server.stop(0);
        }

        System.out.println();
        System.out.println("STREAM PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    // ------------------------------------------------------------ scenarios

    private static void normalTurn() {
        section("a normal turn");
        Rec r = run("/ok", null, EngineCore.StreamPolicy.standard(), 10_000);
        check("answer assembled in order", "Hello world".equals(r.content.toString()),
                "[" + r.content + "]");
        check("tool lines surfaced as thinking events", r.thinking.size() == 4,
                String.valueOf(r.thinking));
        check("engine heartbeat reached the client", r.thinking.contains("\u23F3"),
                String.valueOf(r.thinking));
        check("turn reported success", r.ok && r.error == null, r.error);
        check("terminal callback fired exactly once", r.doneCount.get() == 1,
                "count=" + r.doneCount.get());
    }

    private static void contentInFinalDoneLine() {
        section("content that arrives inside the done line");
        Rec r = run("/done-with-content", null, EngineCore.StreamPolicy.standard(), 10_000);
        check("nothing dropped from the final line",
                "first half second half".equals(r.content.toString()), "[" + r.content + "]");
        check("turn reported success", r.ok, r.error);
    }

    private static void stallTerminates() {
        section("an engine that stops sending (the 'stuck on generating' case)");
        /* 1.5s of silence is the limit here so the check is quick; the shipped
           default is 330s, above the engine's longest silent tool run. */
        EngineCore.StreamPolicy fast = new EngineCore.StreamPolicy(2_000, 250, 1_500, 60_000);
        long t0 = System.currentTimeMillis();
        Rec r = run("/stall", null, fast, 15_000);
        long ms = System.currentTimeMillis() - t0;
        check("a silent engine ends the turn instead of hanging", !r.ok, "turn never ended");
        check("the reason names the silence",
                r.error != null && r.error.contains("went quiet"), r.error);
        check("it gave up near the stall limit, not after the whole timeout",
                ms < 6_000, ms + "ms");
        check("terminal callback fired exactly once", r.doneCount.get() == 1,
                "count=" + r.doneCount.get());
    }

    private static void stopIsHonouredDuringStall() {
        section("stop pressed while the engine is silent");
        EngineCore.StreamPolicy shipped = EngineCore.StreamPolicy.standard();
        long ms = stopLatency(shipped, 600);
        check("stop ended the turn", lastRec != null && !lastRec.ok
                && "cancelled".equals(lastRec.error), lastRec == null ? "no record" : lastRec.error);
        check("stop latency is bounded by the read slice, not the whole timeout",
                ms < shipped.readSliceMs + 2_000,
                ms + "ms (read slice " + shipped.readSliceMs + "ms)");
        check("stop is prompt in absolute terms", ms < 4_000, ms + "ms");

        /* The same stop with a deliberately long read slice, to show what the
           slice is actually buying: this is the old behaviour, where stop could
           not be noticed until the read timed out. */
        EngineCore.StreamPolicy longSlice = new EngineCore.StreamPolicy(2_000, 8_000, 300_000, 60_000);
        long slow = stopLatency(longSlice, 600);
        check("a long read slice delays stop by roughly that slice",
                slow > 6_000, slow + "ms -- this is why the shipped slice is 1s");
    }

    private static Rec lastRec;

    /** Press stop `pressAfterMs` into a silent turn; return how long it took. */
    private static long stopLatency(EngineCore.StreamPolicy policy, long pressAfterMs) {
        final boolean[] cancel = new boolean[] {false};
        Thread stopper = new Thread(() -> {
            try { Thread.sleep(pressAfterMs); } catch (InterruptedException ignored) { }
            cancel[0] = true;
        });
        long t0 = System.currentTimeMillis();
        stopper.start();
        lastRec = run("/stall", cancel, policy, 30_000);
        return System.currentTimeMillis() - t0;
    }

    private static void longToolTurn() {
        section("a long tool-heavy turn");
        Rec r = run("/long", null, EngineCore.StreamPolicy.standard(), 20_000);
        check("all ten tool rounds surfaced", r.thinking.size() == 30,
                "events=" + r.thinking.size());
        check("the final answer arrived", "done after ten tool rounds".equals(r.content.toString()),
                "[" + r.content + "]");
        check("turn reported success", r.ok, r.error);
    }

    private static void garbageLinesSurvive() {
        section("malformed lines in the stream");
        Rec r = run("/garbage", null, EngineCore.StreamPolicy.standard(), 10_000);
        check("garbage skipped, real content kept",
                "kept going".equals(r.content.toString()), "[" + r.content + "]");
        check("turn still reported success", r.ok, r.error);
    }

    private static void closedSocketIsNotAHang() {
        section("socket closed with no done line");
        Rec r = run("/closed", null, EngineCore.StreamPolicy.standard(), 10_000);
        check("a closed stream ends the turn", r.doneCount.get() == 1,
                "count=" + r.doneCount.get());
        check("what arrived was kept", "partial answer".equals(r.content.toString()),
                "[" + r.content + "]");
    }

    private static void conversationHistoryIsSent() {
        section("the conversation before the turn is on the wire");
        java.util.List<EngineCore.Msg> history = new java.util.ArrayList<>();
        history.add(new EngineCore.Msg("user", "My name is Ada."));
        history.add(new EngineCore.Msg("assistant", "Nice to meet you, Ada."));
        final Rec rec = new Rec();
        final CountDownLatch latch = new CountDownLatch(1);
        Thread t = new Thread(() -> EngineCore.chatStream(base + "/context", KEY, history,
                "What is my name?", "", null, new EngineCore.ChatListener() {
                    @Override public void onThinking(String text) { }
                    @Override public void onContent(String text) { rec.content.append(text); }
                    @Override public void onDone(boolean ok, String err) {
                        rec.ok = ok; rec.error = err; rec.doneCount.incrementAndGet();
                        latch.countDown();
                    }
                }, EngineCore.StreamPolicy.standard()));
        t.setDaemon(true);
        t.start();
        try { latch.await(10_000, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) { }
        String seen = rec.content.toString();
        check("earlier user turn was sent", seen.contains("sawAda=true"), "[" + seen + "]");
        check("earlier assistant turn was sent", seen.contains("sawReply=true"), "[" + seen + "]");
        check("the new prompt is last, after two history messages (3 roles total)",
                seen.contains("messages=3"), "[" + seen + "]");

        /* And the single-prompt form must still send exactly one message. */
        Rec solo = run("/context", null, EngineCore.StreamPolicy.standard(), 10_000);
        check("single-prompt form still sends only the prompt",
                solo.content.toString().contains("messages=1"), "[" + solo.content + "]");
    }

    private static void httpErrorsAreExplained() {
        section("HTTP failures");
        Rec r = run("/502", null, EngineCore.StreamPolicy.standard(), 10_000);
        check("502 is reported as a failure", !r.ok, "reported ok");
        check("502 explains itself", r.error != null && r.error.contains("502"), r.error);
    }

    private static void wrongKeyIsExplained() {
        section("the engine rejecting the key");
        Rec r = runWithKey("/api/chat", "wrong-key", null,
                EngineCore.StreamPolicy.standard(), 10_000);
        check("403 is reported as a failure", !r.ok, "reported ok");
        check("403 names the key", r.error != null && r.error.contains("key"), r.error);
    }

    private static void manyTurnsInARow() {
        section("twenty-five turns back to back");
        int good = 0;
        String lastError = null;
        long t0 = System.currentTimeMillis();
        for (int i = 0; i < 25; i++) {
            Rec r = runWithKey("/api/chat", KEY, null, EngineCore.StreamPolicy.standard(), 10_000);
            if (r.ok && "turn served".equals(r.content.toString())) good++;
            else lastError = r.error;
        }
        long ms = System.currentTimeMillis() - t0;
        check("every consecutive turn succeeded", good == 25, good + "/25, last error: " + lastError);
        check("no turn was left hanging", ms < 20_000, ms + "ms for 25 turns");
    }

    // -------------------------------------------------------------- helpers

    private interface Handler { void handle(HttpExchange ex) throws Exception; }

    private static void route(String path, final Handler h) {
        server.createContext(path, ex -> {
            try {
                h.handle(ex);
            } catch (Exception e) {
                try { ex.close(); } catch (Exception ignored) { }
            }
        });
    }

    private static void write(OutputStream o, String jsonLine) throws Exception {
        o.write((jsonLine + "\n").getBytes(StandardCharsets.UTF_8));
        o.flush();
    }

    private static String thinking(String t) {
        return "{\"message\":{\"thinking\":\"" + escape(t) + "\"},\"done\":false}";
    }

    private static String content(String c) {
        return "{\"message\":{\"content\":\"" + escape(c) + "\"},\"done\":false}";
    }

    private static String escape(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '"' || ch == '\\') b.append('\\').append(ch);
            else if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
            else b.append(ch);
        }
        return b.toString();
    }

    private static final class Rec {
        final StringBuilder content = new StringBuilder();
        final List<String> thinking = new ArrayList<>();
        final AtomicInteger doneCount = new AtomicInteger();
        volatile boolean ok;
        volatile String error;
    }

    private static Rec run(String path, boolean[] cancel,
                           EngineCore.StreamPolicy policy, long waitMs) {
        return runWithKey(path, KEY, cancel, policy, waitMs);
    }

    private static Rec runWithKey(String path, String key, boolean[] cancel,
                                  EngineCore.StreamPolicy policy, long waitMs) {
        final Rec rec = new Rec();
        final CountDownLatch latch = new CountDownLatch(1);
        Thread t = new Thread(() -> EngineCore.chatStream(base + path, key, "hi", "",
                cancel, new EngineCore.ChatListener() {
                    @Override public void onThinking(String text) { rec.thinking.add(text); }
                    @Override public void onContent(String text) { rec.content.append(text); }
                    @Override public void onDone(boolean ok, String err) {
                        rec.ok = ok;
                        rec.error = err;
                        rec.doneCount.incrementAndGet();
                        latch.countDown();
                    }
                }, policy));
        t.setDaemon(true);
        t.start();
        try {
            if (!latch.await(waitMs, TimeUnit.MILLISECONDS)) {
                rec.error = "NO TERMINAL CALLBACK within " + waitMs + "ms";
                rec.doneCount.set(0);
            }
        } catch (InterruptedException ignored) { }
        return rec;
    }

    private static void section(String name) {
        System.out.println();
        System.out.println("== " + name);
    }

    private static void check(String name, boolean ok, String detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name
                + (ok || detail == null || detail.isEmpty() ? "" : "  ->  " + detail));
        if (ok) pass++; else fail++;
    }
}
