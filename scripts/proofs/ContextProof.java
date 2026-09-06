import com.aether.app.EngineCore;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Does the engine remember the conversation? Live, on a real engine.
 *
 * The engine audit showed the answer was no: asked to "summarise that", the
 * model replied that there was no prior message -- because the client sent only
 * the newest prompt. This drives the fixed client against a real engine: give it
 * a fact, then ask for the fact back, with the conversation attached.
 *
 * Usage: java -cp /tmp/cp:json.jar ContextProof android/credentials.properties \
 *          android/app/src/main/assets/aether-notebook-template.json a
 */
public final class ContextProof {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        Properties p = new Properties();
        try (FileInputStream in = new FileInputStream(args[0])) { p.load(in); }
        final String topic = p.getProperty("beaconTopic");
        final String secret = p.getProperty("beaconSecret");
        final String offKey = p.getProperty("offKey");
        final String slot = args.length > 2 ? args[2] : "a";
        final String template = read(args[1]);

        EngineCore.Engine e = new EngineCore.Engine(slot,
                p.getProperty("engine" + slot.toUpperCase() + ".user"),
                p.getProperty("engine" + slot.toUpperCase() + ".key"),
                p.getProperty("kernelSlug"));

        System.out.println("== waking engine " + slot.toUpperCase());
        String rendered = template
                .replace("{{AETHER_OFF_KEY}}", offKey)
                .replace("{{AETHER_BEACON_TOKEN}}", topic)
                .replace("{{AETHER_BEACON_TOPIC}}", topic)
                .replace("{{AETHER_SLOT}}", slot);
        EngineCore.kernelPush(e, rendered, EngineCore.KERNEL_TITLE, true, 120_000);
        System.out.println("  pushed");

        String url = null;
        long deadline = System.currentTimeMillis() + 22 * 60_000L;
        while (url == null && System.currentTimeMillis() < deadline) {
            try { url = EngineCore.currentLinkFor(topic, secret, slot, 3600, 25_000); }
            catch (Exception ignored) { }
            if (url != null && !EngineCore.health(url, 20_000).isLive()) {
                System.out.println("  tunnel up, model not warm yet");
                url = null;
            }
            if (url == null) { System.out.println("  waiting…"); Thread.sleep(20_000); }
        }
        check("engine " + slot.toUpperCase() + " is live", url != null, "never came live");
        if (url == null) { summary(); System.exit(1); }
        System.out.println("  LIVE " + url);

        List<EngineCore.Msg> history = new ArrayList<>();

        System.out.println();
        System.out.println("== turn 1 -- give it a fact");
        Turn t1 = turn(url, offKey, history,
                "My name is Ada and my favourite number is 42. Just acknowledge it briefly.");
        System.out.println("  -> " + oneLine(t1.content.toString()));
        check("turn 1 produced text", t1.ok && t1.content.length() > 0, t1.err);
        history.add(new EngineCore.Msg("user",
                "My name is Ada and my favourite number is 42. Just acknowledge it briefly."));
        history.add(new EngineCore.Msg("assistant", t1.content.toString()));

        System.out.println();
        System.out.println("== turn 2 -- ask for the fact back, with the conversation attached");
        Turn t2 = turn(url, offKey, history, "What is my name?");
        System.out.println("  -> " + oneLine(t2.content.toString()));
        check("it remembered the name", t2.ok && t2.content.toString().contains("Ada"),
                "[" + oneLine(t2.content.toString()) + "]");
        history.add(new EngineCore.Msg("user", "What is my name?"));
        history.add(new EngineCore.Msg("assistant", t2.content.toString()));

        System.out.println();
        System.out.println("== turn 3 -- a second fact from the same conversation");
        Turn t3 = turn(url, offKey, history, "And my favourite number? Answer with just the number.");
        System.out.println("  -> " + oneLine(t3.content.toString()));
        check("it remembered the number", t3.ok && t3.content.toString().contains("42"),
                "[" + oneLine(t3.content.toString()) + "]");
        history.add(new EngineCore.Msg("user", "And my favourite number? Answer with just the number."));
        history.add(new EngineCore.Msg("assistant", t3.content.toString()));

        System.out.println();
        System.out.println("== turn 4 -- refer back across three turns");
        Turn t4 = turn(url, offKey, history,
                "In one sentence, restate my name and my favourite number together.");
        System.out.println("  -> " + oneLine(t4.content.toString()));
        check("both facts survive several turns",
                t4.ok && t4.content.toString().contains("Ada") && t4.content.toString().contains("42"),
                "[" + oneLine(t4.content.toString()) + "]");

        System.out.println();
        System.out.println("== control -- the same question with NO history must not know");
        Turn cold = turn(url, offKey, null, "What is my name?");
        System.out.println("  -> " + oneLine(cold.content.toString()));
        check("without history it does not invent a name",
                cold.ok && !cold.content.toString().contains("Ada"),
                "[" + oneLine(cold.content.toString()) + "]");

        System.out.println();
        System.out.println("== shutdown");
        int code = EngineCore.off(url, offKey, 30_000);
        boolean down = EngineCore.confirmedDown(url, 8, 5_000, 20_000);
        System.out.println("  /off " + code + " -> " + (down ? "confirmed terminated" : "STILL LIVE"));
        check("engine confirmed off", down, "still " + EngineCore.health(url, 20_000).status);

        summary();
        if (fail > 0) System.exit(1);
    }

    // --------------------------------------------------------------- plumbing

    private static String read(String path) throws Exception {
        try (InputStream in = new FileInputStream(path)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static String oneLine(String s) {
        String t = s == null ? "" : s.replaceAll("\\s+", " ").trim();
        if (t.isEmpty()) return "(EMPTY)";
        return t.length() > 220 ? t.substring(0, 219) + "…" : t;
    }

    private static final class Turn {
        final StringBuilder content = new StringBuilder();
        volatile boolean ok;
        volatile String err;
    }

    private static Turn turn(String url, String offKey, List<EngineCore.Msg> history, String prompt)
            throws Exception {
        final Turn t = new Turn();
        final CountDownLatch latch = new CountDownLatch(1);
        Thread w = new Thread(() -> EngineCore.chatStream(url, offKey, history, prompt, "",
                new boolean[] {false}, new EngineCore.ChatListener() {
                    @Override public void onThinking(String text) { }
                    @Override public void onContent(String text) { t.content.append(text); }
                    @Override public void onDone(boolean ok, String err) {
                        t.ok = ok; t.err = err; latch.countDown();
                    }
                }, EngineCore.StreamPolicy.standard()));
        w.setDaemon(true);
        w.start();
        if (!latch.await(20, TimeUnit.MINUTES)) t.err = "no terminal callback in 20 minutes";
        return t;
    }

    private static void check(String name, boolean ok, String detail) {
        System.out.println("  " + (ok ? "PASS  " : "FAIL  ") + name
                + (ok || detail == null || detail.isEmpty() ? "" : "  ->  " + detail));
        if (ok) pass++; else fail++;
    }

    private static void summary() {
        System.out.println();
        System.out.println("CONTEXT PROOF  " + pass + " passed, " + fail + " failed");
    }
}
