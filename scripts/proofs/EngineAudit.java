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
 * Full audit of the real engines: wake them, ask them ordinary questions, judge
 * whether they can actually generate text, then shut every one of them down and
 * confirm they are gone.
 *
 * WHY THIS EXISTS. "It can't generate text anymore" cannot be answered by
 * reading code. So this drives the same EngineCore the APK uses, against the
 * notebook the APK pushes (byte-identical to the pinned source), with ordinary
 * prompts -- not the trivial "reply with exactly X" ones -- and prints what came
 * back so the answer can be read rather than trusted.
 *
 * Usage: java -cp /tmp/ea:json.jar EngineAudit android/credentials.properties \
 *          android/app/src/main/assets/aether-notebook-template.json a,b,c
 */
public final class EngineAudit {

    private static int pass = 0;
    private static int fail = 0;

    /** Ordinary prompts: the kind a person actually types. */
    private static final String[][] PROMPTS = {
        {"two sentences", "Explain in two sentences what a GPU does.", "20"},
        {"haiku", "Write a haiku about the ocean.", "12"},
        {"arithmetic", "What is 17 multiplied by 23? Answer with just the number.", "2"},
        {"long form", "Write about 200 words on why the sky is blue.", "400"},
        {"follow-up", "Now summarise that in one sentence.", "20"},
    };

    public static void main(String[] args) throws Exception {
        Properties p = new Properties();
        try (FileInputStream in = new FileInputStream(args[0])) { p.load(in); }
        final String topic = p.getProperty("beaconTopic");
        final String secret = p.getProperty("beaconSecret");
        final String offKey = p.getProperty("offKey");
        final String slug = p.getProperty("kernelSlug");
        final String template = read(args[1]);
        final String[] slots = args[2].split(",");

        System.out.println("notebook template: " + template.length() + " bytes, sha256 "
                + sha256(template).substring(0, 16) + "…");

        // ---------------------------------------------------------- wake all
        System.out.println();
        System.out.println("== waking " + String.join(", ", slots));
        for (String slot : slots) {
            EngineCore.Engine e = engine(p, slot, slug);
            try {
                EngineCore.kernelPush(e, render(template, offKey, topic, slot),
                        EngineCore.KERNEL_TITLE, true, 120_000);
                System.out.println("  " + slot.toUpperCase() + " pushed (" + e + ")");
            } catch (Exception ex) {
                System.out.println("  " + slot.toUpperCase() + " PUSH FAILED: " + ex.getMessage());
                check("engine " + slot.toUpperCase() + " accepted the push", false, ex.getMessage());
            }
        }

        // ------------------------------------- wait for live, then interrogate
        List<String> live = new ArrayList<>();
        java.util.Map<String, String> urls = new java.util.LinkedHashMap<>();
        long deadline = System.currentTimeMillis() + 22 * 60_000L;
        List<String> pending = new ArrayList<>(java.util.Arrays.asList(slots));

        while (!pending.isEmpty() && System.currentTimeMillis() < deadline) {
            for (java.util.Iterator<String> it = pending.iterator(); it.hasNext(); ) {
                String slot = it.next();
                String url = null;
                try {
                    url = EngineCore.currentLinkFor(topic, secret, slot, 3600, 25_000);
                } catch (Exception ignored) { }
                if (url == null) continue;
                EngineCore.Health h = EngineCore.health(url, 20_000);
                if (!h.isLive()) {
                    System.out.println("  " + slot.toUpperCase() + " tunnel up, /api/ps "
                            + h.status + " models=" + h.models + " -- not live yet");
                    continue;
                }
                System.out.println("  " + slot.toUpperCase() + " LIVE " + url
                        + "  models=" + h.models);
                urls.put(slot, url);
                live.add(slot);
                it.remove();
                auditEngine(slot, url, offKey);
            }
            if (!pending.isEmpty()) {
                System.out.println("  waiting on " + pending + " …");
                Thread.sleep(20_000);
            }
        }
        for (String slot : pending) {
            check("engine " + slot.toUpperCase() + " came live", false,
                    "never reached /api/ps 200 with a model inside 22 minutes");
        }

        // ------------------------------------------------------- shut them down
        System.out.println();
        System.out.println("== shutting everything down");
        for (String slot : live) {
            String url = urls.get(slot);
            try {
                int code = EngineCore.off(url, offKey, 30_000);
                boolean down = EngineCore.confirmedDown(url, 8, 5_000, 20_000);
                System.out.println("  " + slot.toUpperCase() + " /off " + code
                        + " -> " + (down ? "confirmed terminated" : "STILL LIVE"));
                check("engine " + slot.toUpperCase() + " confirmed off", down,
                        "/api/ps still " + EngineCore.health(url, 20_000).status);
            } catch (Exception ex) {
                check("engine " + slot.toUpperCase() + " shut down", false, ex.getMessage());
            }
        }
        /* Anything that never came live must not be left holding a GPU. */
        for (String slot : pending) {
            try {
                EngineCore.Engine e = engine(p, slot, slug);
                System.out.println("  " + slot.toUpperCase()
                        + " never came live; Kaggle status now: " + EngineCore.kernelStatus(e, 20_000));
            } catch (Exception ignored) { }
        }

        System.out.println();
        System.out.println("ENGINE AUDIT  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    // --------------------------------------------------------------- per engine

    private static void auditEngine(String slot, String url, String offKey) throws Exception {
        System.out.println();
        System.out.println("== engine " + slot.toUpperCase() + " — can it generate text?");
        int empty = 0;
        int stepLimited = 0;
        for (String[] spec : PROMPTS) {
            String label = spec[0], prompt = spec[1];
            int minChars = Integer.parseInt(spec[2]);
            Turn t = turn(url, offKey, prompt);
            String text = t.content.toString().trim();
            boolean ok = t.ok && text.length() >= minChars;
            boolean limited = text.contains("tool-step limit");
            if (text.isEmpty()) empty++;
            if (limited) stepLimited++;
            System.out.println("  [" + label + "] " + t.ms + "ms, first token "
                    + t.firstMs + "ms, " + text.length() + " chars, "
                    + t.thinking.size() + " stream events, tools=" + toolNames(t.thinking));
            System.out.println("      -> " + oneLine(text, 200));
            check(slot.toUpperCase() + " " + label + ": generated text",
                    ok, "ok=" + t.ok + " err=" + t.err + " chars=" + text.length());
            if (limited) {
                check(slot.toUpperCase() + " " + label + ": not cut off by the step limit",
                        false, text);
            }
        }
        check(slot.toUpperCase() + " produced text for every prompt", empty == 0,
                empty + " empty replies");
        check(slot.toUpperCase() + " never fell back to the tool-step limit message",
                stepLimited == 0, stepLimited + " times");
    }

    // --------------------------------------------------------------- plumbing

    private static EngineCore.Engine engine(Properties p, String slot, String slug) {
        String key = "engine" + slot.toUpperCase() + ".";
        return new EngineCore.Engine(slot, p.getProperty(key + "user"),
                p.getProperty(key + "key"), slug);
    }

    /** Exactly what the APK does in Credentials.renderNotebook(). */
    private static String render(String template, String offKey, String topic, String slot)
            throws Exception {
        String out = template
                .replace("{{AETHER_OFF_KEY}}", offKey)
                .replace("{{AETHER_BEACON_TOKEN}}", topic)
                .replace("{{AETHER_BEACON_TOPIC}}", topic)
                .replace("{{AETHER_SLOT}}", slot);
        if (out.contains("{{AETHER_")) throw new Exception("unresolved placeholder");
        return out;
    }

    private static String read(String path) throws Exception {
        try (InputStream in = new FileInputStream(path)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static String sha256(String s) throws Exception {
        byte[] d = java.security.MessageDigest.getInstance("SHA-256")
                .digest(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder b = new StringBuilder();
        for (byte x : d) b.append(String.format("%02x", x));
        return b.toString();
    }

    private static List<String> toolNames(List<String> lines) {
        List<String> out = new ArrayList<>();
        for (String l : lines) {
            for (String t : new String[] {"web_search", "run_command", "fetch_page", "crawl_site",
                    "generate_image", "generate_voice"}) {
                if (l.contains(t) && !out.contains(t)) out.add(t);
            }
        }
        return out;
    }

    private static String oneLine(String s, int max) {
        String t = s.replaceAll("\\s+", " ").trim();
        if (t.isEmpty()) return "(EMPTY)";
        return t.length() > max ? t.substring(0, max - 1) + "…" : t;
    }

    private static final class Turn {
        final StringBuilder content = new StringBuilder();
        final List<String> thinking = new ArrayList<>();
        volatile boolean ok;
        volatile String err;
        volatile long ms;
        volatile long firstMs = -1;
    }

    private static Turn turn(String url, String offKey, String prompt) throws Exception {
        final Turn t = new Turn();
        final CountDownLatch latch = new CountDownLatch(1);
        final long t0 = System.currentTimeMillis();
        Thread w = new Thread(() -> EngineCore.chatStream(url, offKey, prompt, "",
                new boolean[] {false}, new EngineCore.ChatListener() {
                    @Override public void onThinking(String text) { t.thinking.add(text); }
                    @Override public void onContent(String text) {
                        if (t.firstMs < 0) t.firstMs = System.currentTimeMillis() - t0;
                        t.content.append(text);
                    }
                    @Override public void onDone(boolean ok, String err) {
                        t.ok = ok; t.err = err;
                        t.ms = System.currentTimeMillis() - t0;
                        latch.countDown();
                    }
                }, EngineCore.StreamPolicy.standard()));
        w.setDaemon(true);
        w.start();
        if (!latch.await(20, TimeUnit.MINUTES)) {
            t.err = "NO TERMINAL CALLBACK within 20 minutes";
            t.ms = System.currentTimeMillis() - t0;
        }
        return t;
    }

    private static void check(String name, boolean ok, String detail) {
        System.out.println("  " + (ok ? "PASS  " : "FAIL  ") + name
                + (ok || detail == null || detail.isEmpty() ? "" : "  ->  " + detail));
        if (ok) pass++; else fail++;
    }
}
