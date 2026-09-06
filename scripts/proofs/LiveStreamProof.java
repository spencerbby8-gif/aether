import com.aether.app.EngineCore;

import java.io.FileInputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The streaming client against a REAL Kaggle engine, not a local stand-in.
 *
 * Same shipped EngineCore the APK calls: wait for the engine to be genuinely
 * live (/api/ps 200 with a loaded model), then run consecutive turns -- plain
 * replies, a turn that makes the model call run_command, a repeat to prove
 * repeated requests still work, and a stop pressed mid-generation -- and finish
 * by shutting the engine down and confirming it is gone.
 *
 * Usage: java -cp /tmp/lp:json.jar LiveStreamProof android/credentials.properties a
 */
public final class LiveStreamProof {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        Properties p = new Properties();
        try (FileInputStream in = new FileInputStream(args[0])) { p.load(in); }
        final String topic = p.getProperty("beaconTopic");
        final String secret = p.getProperty("beaconSecret");
        final String offKey = p.getProperty("offKey");
        final String slot = args.length > 1 ? args[1] : "a";

        System.out.println("== waiting for engine " + slot.toUpperCase() + " to become live");
        String url = null;
        long deadline = System.currentTimeMillis() + 20 * 60_000L;
        while (url == null && System.currentTimeMillis() < deadline) {
            String candidate = null;
            try {
                candidate = EngineCore.currentLinkFor(topic, secret, slot, 3600, 25_000);
            } catch (Exception e) {
                System.out.println("  beacon: " + e.getMessage());
            }
            if (candidate != null) {
                EngineCore.Health h = EngineCore.health(candidate, 20_000);
                if (h.isLive()) {
                    url = candidate;
                    System.out.println("  LIVE  " + url);
                    System.out.println("        models=" + h.models + "  status=" + h.status);
                } else {
                    System.out.println("  tunnel up, /api/ps " + h.status
                            + " models=" + h.models + " -- not live yet");
                }
            } else {
                System.out.println("  no tunnel announced yet");
            }
            if (url == null) Thread.sleep(15_000);
        }
        check("engine " + slot.toUpperCase() + " is live (/api/ps 200 with a loaded model)",
                url != null, "never became live inside 20 minutes");
        if (url == null) { summary(); System.exit(1); }

        section("turn 1 -- a plain reply");
        Turn t1 = turn(url, offKey, "Reply with exactly: LIVE ONE. Nothing else.", null, 0, null);
        check("turn completed", t1.ok, t1.err);
        check("the answer came back verbatim",
                t1.content.toString().contains("LIVE ONE"), "[" + t1.content + "]");
        check("terminal callback fired exactly once", t1.doneCount == 1, "count=" + t1.doneCount);
        System.out.println("        " + t1.ms + "ms total, first content at " + t1.firstMs + "ms");

        section("turn 2 -- the model calls run_command (the case that used to hang)");
        Turn t2 = turn(url, offKey,
                "Use the run_command tool to execute exactly: nvidia-smi --query-gpu=name "
                + "--format=csv,noheader -- Then reply with only the GPU name it printed.",
                null, 0, null);
        check("tool turn completed instead of hanging", t2.ok, t2.err);
        check("the tool call was visible in the stream",
                containsTool(t2.thinking, "run_command"), String.valueOf(t2.thinking));
        check("an answer followed the tool call",
                t2.content.toString().trim().length() > 0, "[" + t2.content + "]");
        System.out.println("        answer: " + oneLine(t2.content.toString()));
        System.out.println("        " + t2.ms + "ms total, " + t2.thinking.size() + " stream events");

        section("turn 3 -- the same request again (repeated requests)");
        Turn t3 = turn(url, offKey, "Reply with exactly: LIVE THREE. Nothing else.", null, 0, null);
        check("the next turn still works", t3.ok, t3.err);
        check("answer came back verbatim",
                t3.content.toString().contains("LIVE THREE"), "[" + t3.content + "]");

        section("stop pressed mid-generation");
        final boolean[] cancel = new boolean[] {false};
        long stopAt = 4_000;
        Turn t4 = turn(url, offKey,
                "Write a very long essay about the history of computing, at least 2000 words.",
                cancel, stopAt, null);
        check("stop ended the turn", !t4.ok && "cancelled".equals(t4.err), t4.err);
        check("stop took effect near when it was pressed",
                t4.ms < stopAt + 8_000, t4.ms + "ms (pressed at " + stopAt + "ms)");
        EngineCore.Health after = EngineCore.health(url, 20_000);
        check("the engine is still healthy after a stop", after.isLive(),
                "/api/ps " + after.status);

        section("turn 5 -- the conversation continues after a stop");
        Turn t5 = turn(url, offKey, "Reply with exactly: STILL HERE. Nothing else.", null, 0, null);
        check("a turn after a cancelled one still works", t5.ok, t5.err);
        check("answer came back verbatim",
                t5.content.toString().contains("STILL HERE"), "[" + t5.content + "]");

        section("shutdown");
        int code = EngineCore.off(url, offKey, 30_000);
        check("POST /off accepted", code == 200, "HTTP " + code);
        boolean down = EngineCore.confirmedDown(url, 8, 5_000, 20_000);
        check("engine confirmed terminated (/api/ps stopped answering)", down,
                "still live: " + EngineCore.health(url, 20_000).status);

        summary();
        if (fail > 0) System.exit(1);
    }

    // ------------------------------------------------------------- plumbing

    private static boolean containsTool(List<String> lines, String tool) {
        for (String l : lines) if (l.contains(tool)) return true;
        return false;
    }

    private static String oneLine(String s) {
        String t = s.replaceAll("\\s+", " ").trim();
        return t.length() > 160 ? t.substring(0, 159) + "…" : t;
    }

    private static final class Turn {
        final StringBuilder content = new StringBuilder();
        final List<String> thinking = new ArrayList<>();
        volatile boolean ok;
        volatile String err;
        volatile int doneCount;
        volatile long ms;
        volatile long firstMs = -1;
    }

    private static Turn turn(String url, String offKey, String prompt,
                             final boolean[] cancel, long cancelAfterMs,
                             EngineCore.StreamPolicy policy) throws Exception {
        final Turn t = new Turn();
        final CountDownLatch latch = new CountDownLatch(1);
        final long t0 = System.currentTimeMillis();
        final boolean[] cancelFlag = cancel != null ? cancel : new boolean[] {false};

        if (cancel != null && cancelAfterMs > 0) {
            Thread stopper = new Thread(() -> {
                try { Thread.sleep(cancelAfterMs); } catch (InterruptedException ignored) { }
                cancel[0] = true;
            });
            stopper.setDaemon(true);
            stopper.start();
        }

        Thread worker = new Thread(() -> EngineCore.chatStream(url, offKey, prompt, "",
                cancelFlag, new EngineCore.ChatListener() {
                    @Override public void onThinking(String text) { t.thinking.add(text); }
                    @Override public void onContent(String text) {
                        if (t.firstMs < 0) t.firstMs = System.currentTimeMillis() - t0;
                        t.content.append(text);
                    }
                    @Override public void onDone(boolean ok, String err) {
                        t.ok = ok;
                        t.err = err;
                        t.doneCount++;
                        t.ms = System.currentTimeMillis() - t0;
                        latch.countDown();
                    }
                }, policy != null ? policy : EngineCore.StreamPolicy.standard()));
        worker.setDaemon(true);
        worker.start();

        if (!latch.await(35, TimeUnit.MINUTES)) {
            t.err = "NO TERMINAL CALLBACK within 35 minutes";
            t.ms = System.currentTimeMillis() - t0;
        }
        return t;
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

    private static void summary() {
        System.out.println();
        System.out.println("LIVE STREAM PROOF  " + pass + " passed, " + fail + " failed");
    }
}
