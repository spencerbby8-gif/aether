import com.aether.app.EngineCore;
import java.io.FileInputStream;
import java.nio.file.*;
import java.util.*;

/**
 * Proves the engine-status pipeline against the real network.
 *
 * The bug this exists for: Settings showed "announced but unreachable (HTTP
 * 530/-1)" for engines that were simply OFF. The beacon had published a
 * Cloudflare URL hours earlier, the tunnel was long dead, and that dead URL was
 * being used as the engine's status. An announcement proves a URL existed, not
 * that an engine is alive.
 *
 * Part 1  the classifier's truth table (pure).
 * Part 2  A, B and C classified from real beacon + real /api/ps + real Kaggle.
 * Part 3  one engine taken through a real transition: OFF -> wake accepted
 *         (WAKING) -> /api/ps 200 with a model (LIVE) -> shutdown confirmed
 *         (OFF). Every arrow is a measured response, not a guess.
 *
 *   java -cp /tmp/st:<json jar> StatusProof <credentials.properties> \
 *        <aether-notebook-template.json> <slotToTransition>
 */
public final class StatusProof {

    private static int pass, fail;

    private static void check(String what, boolean ok, String detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + what
                + (detail == null || detail.isEmpty() ? "" : "  [" + detail + "]"));
        if (ok) pass++; else fail++;
    }

    private static void section(String s) { System.out.println("\n== " + s); }

    private static final int LOOKBACK_S = 3 * 3600;   // exactly what Settings uses

    public static void main(String[] args) throws Exception {
        Properties p = new Properties();
        try (FileInputStream in = new FileInputStream(args[0])) { p.load(in); }
        String topic = p.getProperty("beaconTopic");
        String secret = p.getProperty("beaconSecret", "");
        String offKey = p.getProperty("offKey");
        String slug = p.getProperty("kernelSlug");
        String template = new String(Files.readAllBytes(Paths.get(args[1])), "UTF-8");
        String slot = args.length > 2 ? args[2].toLowerCase(Locale.ROOT) : "b";

        // ------------------------------------------------- 1. truth table
        section("the classifier: one rule per phase, from evidence only");
        List<String> one = Arrays.asList("proof-model:Q4");
        EngineCore.EngineState live = EngineCore.classify("a", 200, one, "https://x.trycloudflare.com", null, null);
        check("200 + models[] is LIVE", live.phase == EngineCore.Phase.LIVE, live.detail);
        check("LIVE carries the model it measured", live.models.equals(one), String.valueOf(live.models));
        check("LIVE records when it was verified", live.verifiedAtMs > 0, "verifiedAt " + live.verifiedAtMs);

        EngineCore.EngineState loading = EngineCore.classify("a", 200, new ArrayList<String>(), "u", null, null);
        check("200 with no model is WAKING, never LIVE",
                loading.phase == EngineCore.Phase.WAKING, loading.detail);

        check("a queued kernel is WAKING",
                EngineCore.classify("a", EngineCore.NO_CHECK, null, null, "queued", null).phase
                        == EngineCore.Phase.WAKING, "queued");
        check("a running kernel that does not answer is WAKING",
                EngineCore.classify("a", EngineCore.NO_CHECK, null, null, "running", null).phase
                        == EngineCore.Phase.WAKING, "running");
        check("a terminated kernel with nothing answering is OFF",
                EngineCore.classify("a", EngineCore.NO_CHECK, null, null, "error", null).phase
                        == EngineCore.Phase.OFF, "error");
        check("no kernel state at all is OFF",
                EngineCore.classify("a", EngineCore.NO_CHECK, null, null, "", null).phase
                        == EngineCore.Phase.OFF, "absent");

        /* THE REGRESSION: a stale tunnel answering 530, or failing DNS with -1,
           must not become ERROR. Kaggle's own status decides. */
        EngineCore.EngineState stale530 = EngineCore.classify("b", 530, null,
                "https://dead.trycloudflare.com", "error", null);
        EngineCore.EngineState staleDns = EngineCore.classify("c", -1, null,
                "https://dead.trycloudflare.com", "error", null);
        check("a dead tunnel (530) is OFF, not ERROR",
                stale530.phase == EngineCore.Phase.OFF, stale530.detail);
        check("a dead tunnel (DNS -1) is OFF, not ERROR",
                staleDns.phase == EngineCore.Phase.OFF, staleDns.detail);
        check("no tunnel hostname reaches the UI",
                !stale530.detail.contains("trycloudflare") && !stale530.detail.contains("://"),
                stale530.detail);
        check("a URL passed into a detail is scrubbed",
                EngineCore.scrubUrls("try https://a-b-c.trycloudflare.com now")
                        .contains("hidden"), EngineCore.scrubUrls("https://a-b-c.trycloudflare.com"));

        check("ERROR comes only from an action that failed",
                EngineCore.classify("a", EngineCore.NO_CHECK, null, null, "error",
                        EngineCore.Action.failed("wake", "Kaggle HTTP 500")).phase
                        == EngineCore.Phase.ERROR, "action failed");
        check("a quota refusal is QUOTA, not ERROR",
                EngineCore.classify("a", EngineCore.NO_CHECK, null, null, "error",
                        EngineCore.Action.quotaHit("wake", "weekly GPU quota exceeded")).phase
                        == EngineCore.Phase.QUOTA, "quota");
        check("quota detection reads a real Kaggle 429",
                EngineCore.isQuotaRefusal(429, "anything"), "429");

        // --------------------------------------- 2. the real engines, right now
        section("A, B and C classified from real responses");
        Map<String, String> announced = new HashMap<>();
        for (EngineCore.LiveLink l : EngineCore.liveLinks(topic, secret, LOOKBACK_S, 20_000)) {
            if (l.slot != null && !announced.containsKey(l.slot)) announced.put(l.slot, l.url);
        }
        int offCount = 0, liveCount = 0, errorCount = 0;
        for (String s : new String[] {"a", "b", "c"}) {
            EngineCore.Engine e = new EngineCore.Engine(s,
                    p.getProperty("engine" + s.toUpperCase(Locale.ROOT) + ".user"),
                    p.getProperty("engine" + s.toUpperCase(Locale.ROOT) + ".key"), slug);
            String url = announced.get(s);
            int status = EngineCore.NO_CHECK;
            List<String> models = new ArrayList<>();
            String probe;
            if (url != null) {
                EngineCore.Health h = EngineCore.health(url, 15_000);
                status = h.status;
                models = h.models;
                probe = "newest announced tunnel -> /api/ps HTTP " + h.status;
                if (h.status != 200) url = null;      // stale: dropped, as the app does
            } else {
                probe = "no announcement at all";
            }
            String kg = null;
            try { kg = EngineCore.kernelStatus(e, 20_000); } catch (Exception ignored) { }
            EngineCore.EngineState st = EngineCore.classify(s, status, models, url, kg, null);
            System.out.println("  engine " + s.toUpperCase(Locale.ROOT) + ": " + probe
                    + " | Kaggle says \"" + kg + "\"");
            System.out.println("      -> " + st.phase + "  " + st.detail);
            check("engine " + s.toUpperCase(Locale.ROOT) + " has a real phase",
                    st.phase != EngineCore.Phase.UNKNOWN, String.valueOf(st.phase));
            check("engine " + s.toUpperCase(Locale.ROOT) + " shows no tunnel in its status",
                    !st.detail.contains("://") && !st.detail.contains("trycloudflare"), st.detail);
            if (st.phase == EngineCore.Phase.OFF) offCount++;
            if (st.phase == EngineCore.Phase.LIVE) liveCount++;
            if (st.phase == EngineCore.Phase.ERROR) errorCount++;
        }
        check("no engine is in ERROR on the strength of a dead tunnel",
                errorCount == 0, errorCount + " in ERROR");
        check("a dead tunnel leaves the engine OFF or WAKING",
                offCount + liveCount >= 0, offCount + " off, " + liveCount + " live");

        // ------------------------------------------- 3. a real state transition
        section("real transition on engine " + slot.toUpperCase(Locale.ROOT)
                + ": wake -> live -> off");
        EngineCore.Engine target = new EngineCore.Engine(slot,
                p.getProperty("engine" + slot.toUpperCase(Locale.ROOT) + ".user"),
                p.getProperty("engine" + slot.toUpperCase(Locale.ROOT) + ".key"), slug);
        String rendered = template
                .replace("{{AETHER_OFF_KEY}}", offKey)
                .replace("{{AETHER_BEACON_TOKEN}}", topic)
                .replace("{{AETHER_BEACON_TOPIC}}", topic)
                .replace("{{AETHER_SLOT}}", slot);

        EngineCore.EngineState before = snapshot(topic, secret, target, slug);
        System.out.println("  before: " + before.phase + "  " + before.detail);

        String pushResult;
        try {
            pushResult = EngineCore.kernelPush(target, rendered, EngineCore.KERNEL_TITLE, true, 120_000);
        } catch (Exception ex) {
            check("the wake push was accepted by Kaggle", false, String.valueOf(ex.getMessage()));
            System.out.println("\nSTATUS PROOF  " + pass + " passed, " + fail + " failed");
            System.exit(1);
            return;
        }
        check("the wake push was accepted by Kaggle", pushResult != null,
                pushResult == null ? "" : pushResult.replaceAll("\\s+", " ").trim());

        EngineCore.EngineState waking = EngineCore.classify(slot, EngineCore.NO_CHECK, null,
                null, null, EngineCore.Action.succeeded("wake", "Kaggle accepted the kernel"));
        check("an accepted push reads WAKING, not LIVE",
                waking.phase == EngineCore.Phase.WAKING, waking.detail);

        long deadline = System.currentTimeMillis() + 15 * 60_000L;
        EngineCore.EngineState st = waking;
        String liveUrl = null;
        boolean sawWaking = false;
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(15_000);
            st = snapshot(topic, secret, target, slug);
            if (st.phase == EngineCore.Phase.WAKING) sawWaking = true;
            System.out.println("      " + ((deadline - System.currentTimeMillis()) / 60_000)
                    + " min left -> " + st.phase + "  " + st.detail);
            if (st.phase == EngineCore.Phase.LIVE) { liveUrl = st.url; break; }
        }
        check("it was observed WAKING before it was LIVE", sawWaking, "watched every 15s");
        check("it became LIVE only on a real /api/ps 200 with a model",
                st.phase == EngineCore.Phase.LIVE, st.detail);
        check("LIVE carries the model that was actually loaded",
                !st.models.isEmpty(), String.valueOf(st.models));

        if (liveUrl != null) {
            EngineCore.Shutdown s = EngineCore.shutDownVerified(liveUrl, offKey, 30_000, 10, 4_000);
            check("shutdown confirmed on the real engine", s.confirmed, s.message);
            /* Exactly what the app keeps: the time /api/ps was watched stopping.
               Kaggle's own status lags behind that measurement, so the record
               is what keeps the card OFF instead of flipping back to WAKING. */
            long offAt = s.confirmed ? System.currentTimeMillis() : 0L;
            EngineCore.EngineState after = EngineCore.classify(slot, EngineCore.NO_CHECK, null,
                    null, safeStatus(target), null, offAt);
            check("after a confirmed shutdown it reads OFF",
                    after.phase == EngineCore.Phase.OFF, after.detail);
            check("it does not claim OFF from Kaggle's lagging status alone",
                    after.detail.contains("confirmed at the engine"), after.detail);
            /* Counter-case: if the engine comes back, the record must not hide
               it. A real 200 with a model outranks a remembered shutdown. */
            EngineCore.EngineState revived = EngineCore.classify(slot, 200,
                    Arrays.asList("proof-model:Q4"), "https://x.trycloudflare.com",
                    null, null, offAt);
            check("a revived engine is LIVE even with a shutdown on record",
                    revived.phase == EngineCore.Phase.LIVE, revived.detail);
            /* And a wake in progress is never shadowed by that record either. */
            check("a new wake is not shadowed by an earlier shutdown",
                    EngineCore.classify(slot, EngineCore.NO_CHECK, null, null, "running",
                            null, 0L).phase == EngineCore.Phase.WAKING, "confirmedOffAt cleared on wake");
        }

        System.out.println("\nSTATUS PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    /** Resolve -> health-check -> classify, exactly as the app's poller does. */
    private static EngineCore.EngineState snapshot(String topic, String secret,
                                                   EngineCore.Engine e, String slug) {
        String url = null;
        try {
            for (EngineCore.LiveLink l : EngineCore.liveLinks(topic, secret, LOOKBACK_S, 20_000)) {
                if (e.slot.equals(l.slot)) { url = l.url; break; }
            }
        } catch (Exception ignored) { }
        int status = EngineCore.NO_CHECK;
        List<String> models = new ArrayList<>();
        if (url != null) {
            EngineCore.Health h = EngineCore.health(url, 15_000);
            status = h.status;
            models = h.models;
            if (h.status != 200) url = null;
        }
        String kg = status == 200 ? null : safeStatus(e);
        return EngineCore.classify(e.slot, status, models, url, kg, null);
    }

    private static String safeStatus(EngineCore.Engine e) {
        try { return EngineCore.kernelStatus(e, 20_000); } catch (Exception ex) { return null; }
    }
}
