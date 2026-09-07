import com.aether.app.EngineCore;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;


/**
 * Proves the chat-stream timeout fix.
 *
 * The bug: readSliceMs was 1000ms. On Android HttpURLConnection is OkHttp, and
 * OkHttp treats a read timeout as fatal -- it throws SocketTimeoutException
 * ("timeout") and closes the socket, so the next read fails with
 * SocketException ("Socket closed"). Those are verbatim the two errors the user
 * reported. On the JDK a read timeout is recoverable, which is why every
 * earlier streaming proof passed on a laptop while the phone failed every turn.
 *
 * What this harness can and cannot do, stated plainly:
 *   - It CANNOT run OkHttp, so it cannot replay the fatal-timeout behaviour.
 *   - It CAN prove the two things the fix rests on: that the shipped read slice
 *     is longer than every silence the real engine produces (measured, with the
 *     number printed), and that cancelling a turn still lands in about a second
 *     now that it no longer depends on a short read slice.
 *   - It runs the real EngineCore.chatStream, unmodified, including against the
 *     real live engine when one is up.
 */
public final class StreamTimeoutProof {

    static int pass = 0, fail = 0;

    public static void main(String[] args) throws Exception {
        System.out.println("== chat stream timeout proof ==");
        EngineCore.StreamPolicy std = EngineCore.StreamPolicy.standard();
        System.out.println("shipped policy: connect=" + std.connectMs + "ms readSlice="
                + std.readSliceMs + "ms stall=" + std.stallMs + "ms total=" + std.totalMs + "ms\n");

        policyIsLongerThanTheRealSilence(std);
        contentSurvivesTheGapThatKilledThePhone(std);
        cancelStillLandsInAboutASecond(std);
        aRealSocketDeathIsReportedInPlainWords();
        aGenuineStallIsStillDetected();
        realEngineEndToEnd(args);

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    /* ---------------------------------------------------------- assertions */

    static void policyIsLongerThanTheRealSilence(EngineCore.StreamPolicy std) {
        /* Measured against a live engine: the kernel sends its heartbeat, then
           is silent for 2243ms while the model produces the first token. During
           a tool call it emits nothing for up to its own 1200s subprocess
           ceiling, and the heartbeat that follows a model call comes every 10s.
           The read slice must sit above all of that or the socket dies. */
        check("read slice is above the measured 2243ms first-token silence",
                std.readSliceMs > 2243, std.readSliceMs + "ms");
        check("read slice is above the kernel's 10s heartbeat interval",
                std.readSliceMs > 10_000, std.readSliceMs + "ms");
        check("read slice covers the kernel's 1200s tool ceiling",
                std.readSliceMs >= 1_200_000, std.readSliceMs + "ms");
        check("the old 1000ms slice is gone", std.readSliceMs != 1_000,
                "would fire on the first token of every reply");
        check("stall ceiling unchanged at 1260s", std.stallMs == 1_260_000, std.stallMs + "ms");
    }

    /** The exact shape of a real reply: heartbeat, 2243ms of nothing, content. */
    static void contentSurvivesTheGapThatKilledThePhone(EngineCore.StreamPolicy std)
            throws Exception {
        HttpServerHolder s = new HttpServerHolder(ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            OutputStream o = ex.getResponseBody();
            write(o, "{\"message\":{\"thinking\":\"\\u23f3\"},\"done\":false}");
            Thread.sleep(2243);              // the measured first-token gap
            write(o, "{\"message\":{\"content\":\"Hello \"},\"done\":false}");
            write(o, "{\"message\":{\"content\":\"world\"},\"done\":false}");
            write(o, "{\"message\":{\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\"}");
            ex.close();
        });
        Rec r = stream(s.url(), null, std, 30_000);
        check("a reply survives the 2243ms silence", r.ok, String.valueOf(r.err));
        check("all of its content arrived", "Hello world".equals(r.content.toString()),
                "\"" + r.content + "\"");
        check("the heartbeat reached the UI", r.thinking.toString().contains("\u23f3"), r.thinking.toString().trim());
        s.stop();
    }

    /**
     * Stop used to work because the read timed out every second and the loop
     * re-checked the flag. With a 21 minute slice that is gone, so cancellation
     * has to come from disconnecting the connection. Proven here: the server
     * holds the socket open in silence, the caller cancels after 1.2s, and the
     * turn must end promptly rather than waiting out the slice.
     */
    static void cancelStillLandsInAboutASecond(EngineCore.StreamPolicy std) throws Exception {
        HttpServerHolder s = new HttpServerHolder(ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            write(ex.getResponseBody(), "{\"message\":{\"thinking\":\"\\u23f3\"},\"done\":false}");
            Thread.sleep(60_000);            // silent, exactly like a long tool run
            ex.close();
        });
        final boolean[] cancel = new boolean[] {false};
        final EngineCore.TurnHandle handle = new EngineCore.TurnHandle();
        final Rec r = new Rec();
        Thread t = new Thread(() -> EngineCore.chatStream(s.url(), "k", null, "hi", "", cancel,
                listener(r), std, handle));
        t.setDaemon(true);
        t.start();
        Thread.sleep(1200);                  // let the reader get into its wait
        long t0 = System.currentTimeMillis();
        cancel[0] = true;
        handle.cancel();
        /* Measured to the moment the turn REPORTS, which is what the user
           feels -- not to when the abandoned reader thread happens to exit. */
        boolean reported = r.done.await(1500, java.util.concurrent.TimeUnit.MILLISECONDS);
        long took = System.currentTimeMillis() - t0;
        check("stop lands in about a second, not after the read slice",
                reported && took < 1500, took + "ms");
        t.join(1000);
        check("a stopped turn is reported as cancelled, not as a socket error",
                !r.ok && "cancelled".equals(r.err), String.valueOf(r.err));
        s.stop();
    }

    /**
     * A server that resets the connection mid-reply. The user must be told what
     * happened, not handed "Socket closed" -- and our own cancel must not be
     * dressed up as a failure either.
     */
    static void aRealSocketDeathIsReportedInPlainWords() throws Exception {
        ServerSocket ss = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
        Thread t = new Thread(() -> {
            try (Socket sock = ss.accept()) {
                BufferedReader in = new BufferedReader(
                        new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
                String line; int len = 0;
                while ((line = in.readLine()) != null) {
                    if (line.isEmpty()) break;
                    if (line.toLowerCase(Locale.ROOT).startsWith("content-length:")) {
                        len = Integer.parseInt(line.split(":")[1].trim());
                    }
                }
                char[] buf = new char[Math.max(len, 1)];
                if (len > 0) in.read(buf, 0, len);
                OutputStream o = sock.getOutputStream();
                o.write(("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\n\r\n"
                        + "{\"message\":{\"content\":\"partial\"},\"done\":false}\n")
                        .getBytes(StandardCharsets.UTF_8));
                o.flush();
                sock.setSoLinger(true, 0);        // RST instead of a clean close
            } catch (Exception ignored) { }
        });
        t.setDaemon(true);
        t.start();
        Rec r = stream("http://" + InetAddress.getLoopbackAddress().getHostAddress() + ":"
                + ss.getLocalPort(), null, EngineCore.StreamPolicy.standard(), 30_000);
        ss.close();
        check("a dropped connection is not reported as a raw Java message",
                !r.ok && r.err != null
                        && !r.err.equals("Socket closed") && !r.err.equals("timeout"),
                "\"" + r.err + "\"");
        check("partial content that did arrive is kept", r.content.toString().contains("partial"),
                "\"" + r.content + "\"");
    }

    /** The stall path must still work; proven with a small policy so it is fast. */
    static void aGenuineStallIsStillDetected() throws Exception {
        HttpServerHolder s = new HttpServerHolder(ex -> {
            ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            write(ex.getResponseBody(), "{\"message\":{\"content\":\"x\"},\"done\":false}");
            Thread.sleep(30_000);                // silent past the stall ceiling
            ex.close();
        });
        EngineCore.StreamPolicy tight = new EngineCore.StreamPolicy(15_000, 200, 900, 60_000);
        Rec r = stream(s.url(), null, tight, 30_000);
        check("a real stall is still detected and explained",
                !r.ok && r.err != null && r.err.contains("quiet"), "\"" + r.err + "\"");
        s.stop();
    }

    /** The real thing: EngineCore.chatStream against a real engine, real policy. */
    static void realEngineEndToEnd(String[] args) {
        if (args.length < 1) {
            System.out.println("\n[skipped] no credentials.properties argument "
                    + "-- real engine turn not attempted");
            return;
        }
        try {
            Properties p = new Properties();
            try (FileInputStream in = new FileInputStream(args[0])) { p.load(in); }
            String topic = p.getProperty("beaconTopic");
            String url = null;
            for (String slot : new String[] {"a", "b", "c"}) {
                for (String u : EngineCore.urlsFor(topic, "", slot, 3 * 3600, 12_000, 8)) {
                    EngineCore.Health h = EngineCore.health(u, 8_000);
                    if (h.status == 200 && !h.models.isEmpty()) { url = u; break; }
                }
                if (url != null) break;
            }
            if (url == null) {
                System.out.println("\n[skipped] no live engine -- real engine turn not attempted");
                return;
            }
            System.out.println("\nreal engine turn, shipped policy:");
            Rec r = stream(url, p.getProperty("offKey"), EngineCore.StreamPolicy.standard(), 180_000);
            check("a real engine turn completes", r.ok, String.valueOf(r.err));
            check("a real engine reply is not empty", r.content.toString().trim().length() > 0,
                    "\"" + trim(r.content) + "\"");
            check("no timeout or socket error surfaced",
                    r.err == null || (!r.err.contains("timeout") && !r.err.contains("Socket")),
                    String.valueOf(r.err));
            System.out.println("  reply: " + trim(r.content));
        } catch (Exception e) {
            check("real engine turn did not throw", false, String.valueOf(e));
        }
    }

    /* ------------------------------------------------------------- helpers */

    static final class Rec {
        final StringBuilder content = new StringBuilder();
        final StringBuilder thinking = new StringBuilder();
        volatile boolean ok;
        volatile String err = "<never fired>";
        final java.util.concurrent.CountDownLatch done =
                new java.util.concurrent.CountDownLatch(1);
    }

    static EngineCore.ChatListener listener(final Rec r) {
        return new EngineCore.ChatListener() {
            @Override public void onThinking(String t) { r.thinking.append(t).append('\n'); }
            @Override public void onContent(String t) { r.content.append(t); }
            @Override public void onDone(boolean good, String e) {
                r.ok = good; r.err = e; r.done.countDown();
            }
        };
    }

    static Rec stream(String url, String offKey, EngineCore.StreamPolicy p, long waitMs)
            throws Exception {
        final Rec r = new Rec();
        Thread t = new Thread(() -> EngineCore.chatStream(url, offKey == null ? "k" : offKey,
                null, "Reply with one short sentence.", "", null, listener(r), p,
                new EngineCore.TurnHandle()));
        t.setDaemon(true);
        t.start();
        r.done.await(waitMs, java.util.concurrent.TimeUnit.MILLISECONDS);
        t.join(2000);
        return r;
    }

    static void check(String what, boolean ok, String seen) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + what + "   [" + seen + "]");
        if (ok) pass++; else fail++;
    }

    static void write(OutputStream o, String s) throws IOException {
        o.write((s + "\n").getBytes(StandardCharsets.UTF_8));
        o.flush();
    }

    static String trim(CharSequence sb) {
        String t = sb.toString().replaceAll("\\s+", " ").trim();
        return t.length() > 90 ? t.substring(0, 90) + "..." : t;
    }

    /** A throwaway HTTP server with daemon threads, one handler. */
    static final class HttpServerHolder {
        private final com.sun.net.httpserver.HttpServer server;
        HttpServerHolder(final Handler h) throws IOException {
            server = com.sun.net.httpserver.HttpServer.create(
                    new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 8);
            server.createContext("/", ex -> {
                try { h.handle(ex); } catch (Exception ignored) { }
            });
            server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool(r -> {
                Thread t = new Thread(r); t.setDaemon(true); return t;
            }));
            server.start();
        }
        String url() { return "http://" + server.getAddress().getHostString()
                + ":" + server.getAddress().getPort(); }
        void stop() { server.stop(0); }
        interface Handler { void handle(com.sun.net.httpserver.HttpExchange ex) throws Exception; }
    }
}
